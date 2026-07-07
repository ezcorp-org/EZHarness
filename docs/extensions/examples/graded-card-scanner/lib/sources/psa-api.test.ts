// Unit tests for fetchPsaCert — fixture-based, no live network. Covers
// the happy path, defensive parsing of a drifted shape, and every typed
// failure (no-token, quota/429, http/non-200, shape/bad-json, timeout).

import { describe, expect, test } from "bun:test";
import { fetchPsaCert } from "./psa-api";
import {
  BROWSER_USER_AGENT,
  createHostQueue,
  createQueuedFetch,
  type FetchImpl,
  type TimedFetch,
} from "../politeness";
import psaFixture from "../../__fixtures__/psa-cert-response.json";

function jsonFetch(body: unknown, status = 200): FetchImpl {
  return async () => new Response(JSON.stringify(body), { status }) as Response;
}

describe("fetchPsaCert happy path", () => {
  test("parses identity + population from the documented shape", async () => {
    const res = await fetchPsaCert("49392223", "a-valid-token", jsonFetch(psaFixture));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.identity).toEqual({
      subject: "CHARIZARD",
      year: "1999",
      set: "POKEMON GAME",
      cardNo: "4",
      variety: "HOLO",
      grade: "MINT 9",
    });
    expect(res.popAtGrade).toBe(2101);
    expect(res.popHigher).toBe(121);
  });

  test("sends a bearer authorization header and the cert in the path", async () => {
    // Captured via an object property: TS narrows a captured `let` back to
    // its `null` initializer at the expect() site, pinning expect<T> to null.
    const seen: { url: string; auth: string | null } = { url: "", auth: null };
    const spyFetch: FetchImpl = async (url, init) => {
      seen.url = url;
      seen.auth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify(psaFixture), { status: 200 }) as Response;
    };
    await fetchPsaCert("49392223", "secret-token", spyFetch);
    expect(seen.url).toContain("/GetByCertNumber/49392223");
    expect(seen.auth).toBe("bearer secret-token");
  });

  test("falls back to GradeDescription when CardGrade is absent", async () => {
    const drifted = { PSACert: { ...psaFixture.PSACert, CardGrade: undefined, GradeDescription: "GEM MT 10" } };
    const res = await fetchPsaCert("1", "t-token-1234", jsonFetch(drifted));
    if (!res.ok) throw new Error("expected ok");
    expect(res.identity.grade).toBe("GEM MT 10");
  });

  test("missing fields degrade to '' / null (never crash, never guess)", async () => {
    const res = await fetchPsaCert("1", "t-token-1234", jsonFetch({ PSACert: {} }));
    if (!res.ok) throw new Error("expected ok");
    expect(res.identity).toEqual({
      subject: "",
      year: "",
      set: "",
      cardNo: "",
      variety: "",
      grade: "",
    });
    expect(res.popAtGrade).toBeNull();
    expect(res.popHigher).toBeNull();
  });

  test("numeric-string population values are coerced; junk → null", async () => {
    const res = await fetchPsaCert(
      "1",
      "t-token-1234",
      jsonFetch({ PSACert: { TotalPopulation: "500", PopulationHigher: "not-a-number" } }),
    );
    if (!res.ok) throw new Error("expected ok");
    expect(res.popAtGrade).toBe(500);
    expect(res.popHigher).toBeNull();
  });

  test("numeric Year / CardNumber are coerced to strings", async () => {
    const numeric = { PSACert: { ...psaFixture.PSACert, Year: 1999, CardNumber: 4 } };
    const res = await fetchPsaCert("1", "t-token-1234", jsonFetch(numeric));
    if (!res.ok) throw new Error("expected ok");
    expect(res.identity.year).toBe("1999");
    expect(res.identity.cardNo).toBe("4");
  });

  test("non-finite population (NaN / Infinity) → null", async () => {
    // JSON can't carry NaN/Infinity, so hand-roll a response whose json()
    // yields them directly — exercises num()'s non-finite guard.
    const nanFetch: TimedFetch = async () =>
      ({
        status: 200,
        ok: true,
        json: async () => ({
          PSACert: { TotalPopulation: Number.NaN, PopulationHigher: Number.POSITIVE_INFINITY },
        }),
      }) as unknown as Response;
    const res = await fetchPsaCert("1", "t-token-1234", nanFetch);
    if (!res.ok) throw new Error("expected ok");
    expect(res.popAtGrade).toBeNull();
    expect(res.popHigher).toBeNull();
  });

  test("carries the browser User-Agent through the queued fetch (with the bearer token)", async () => {
    // Object capture — see the header-spy test above for why not `let`.
    const seen: { ua: string | null; auth: string | null } = { ua: null, auth: null };
    const underlying: FetchImpl = async (_url, init) => {
      const h = new Headers(init?.headers);
      seen.ua = h.get("user-agent");
      seen.auth = h.get("authorization");
      return new Response(JSON.stringify(psaFixture), { status: 200 }) as Response;
    };
    const queued = createQueuedFetch(createHostQueue(0), underlying);
    await fetchPsaCert("49392223", "secret-token", queued);
    expect(seen.ua).toBe(BROWSER_USER_AGENT);
    expect(seen.auth).toBe("bearer secret-token");
  });
});

describe("fetchPsaCert failures", () => {
  test("no token → no-token (never fires a request)", async () => {
    let called = false;
    const res = await fetchPsaCert("1", null, async () => { called = true; return new Response("") as Response; });
    expect(res).toEqual({ ok: false, kind: "no-token" });
    expect(called).toBe(false);
  });

  test("blank token → no-token", async () => {
    const res = await fetchPsaCert("1", "   ", jsonFetch(psaFixture));
    expect(res).toEqual({ ok: false, kind: "no-token" });
  });

  test("429 → quota", async () => {
    const res = await fetchPsaCert("1", "t-token-1234", jsonFetch({}, 429));
    expect(res).toEqual({ ok: false, kind: "quota" });
  });

  test("500 → http", async () => {
    const res = await fetchPsaCert("1", "t-token-1234", jsonFetch({}, 500));
    expect(res).toEqual({ ok: false, kind: "http" });
  });

  test("non-JSON body → shape", async () => {
    const badJson: FetchImpl = async () => new Response("<html>not json</html>", { status: 200 }) as Response;
    const res = await fetchPsaCert("1", "t-token-1234", badJson);
    expect(res).toEqual({ ok: false, kind: "shape" });
  });

  test("missing PSACert envelope → shape", async () => {
    const res = await fetchPsaCert("1", "t-token-1234", jsonFetch({ error: "not found" }));
    expect(res).toEqual({ ok: false, kind: "shape" });
  });

  test("network throw → http", async () => {
    const res = await fetchPsaCert("1", "t-token-1234", async () => { throw new Error("ECONNREFUSED"); });
    expect(res).toEqual({ ok: false, kind: "http" });
  });

  test("delegates the 15s timeout budget to the queued fetch", async () => {
    // Timeout enforcement moved into createQueuedFetch; psa-api just passes
    // the budget through as the per-call timeoutMs.
    let seenTimeout: number | undefined;
    const capturing: TimedFetch = async (_url, _init, timeoutMs) => {
      seenTimeout = timeoutMs;
      return new Response(JSON.stringify(psaFixture), { status: 200 }) as Response;
    };
    await fetchPsaCert("49392223", "t-token-1234", capturing);
    expect(seenTimeout).toBe(15_000);
  });

  test("a timed-out (aborted) fetch surfaces as http", async () => {
    // End-to-end through the real queued fetch: a stalling underlying fetch
    // is aborted by the 5ms budget → psa-api maps the throw to http.
    const stalling: FetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const queued = createQueuedFetch(createHostQueue(0), stalling);
    // fetchPsaCert hardcodes 15_000; wrap to inject a tiny budget for the test.
    const fast: TimedFetch = (url, initArg) => queued(url, initArg, 5);
    const res = await fetchPsaCert("1", "t-token-1234", fast);
    expect(res).toEqual({ ok: false, kind: "http" });
  });
});
