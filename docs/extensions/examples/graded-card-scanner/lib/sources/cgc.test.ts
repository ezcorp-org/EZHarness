// Unit tests for the CGC cert-page source — fixture-based, no live
// network (fixtures-first contract; live-markup verification belongs to
// the sanity script, mirroring psa-api.ts).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchCgcCert, parseCgcCertPage } from "./cgc";
import type { FetchImpl, Robots } from "../politeness";

const fixDir = join(import.meta.dir, "..", "..", "__fixtures__");
const certHtml = readFileSync(join(fixDir, "cgc-cert.html"), "utf8");

const allowAll: Robots = { isAllowed: async () => true };
const denyAll: Robots = { isAllowed: async () => false };

describe("parseCgcCertPage", () => {
  test("parses identity from the fixture (dt/dd AND th/td shapes)", () => {
    expect(parseCgcCertPage(certHtml)).toEqual({
      subject: "Charizard",
      year: "1999",
      set: "Pokemon Base Set",
      cardNo: "4",
      variety: "Holo",
      grade: "9.5",
    });
  });

  test("missing fields degrade to '' (null-honesty), not a throw", () => {
    const partial = "<dl><dt>Card Name</dt><dd>Pikachu</dd></dl>";
    expect(parseCgcCertPage(partial)).toEqual({
      subject: "Pikachu",
      year: "",
      set: "",
      cardNo: "",
      variety: "",
      grade: "",
    });
  });

  test("the FIRST occurrence of a field wins (defensive against dup labels)", () => {
    const dup =
      "<dl><dt>Grade</dt><dd>9.5</dd><dt>Grade</dt><dd>7</dd></dl>";
    expect(parseCgcCertPage(dup)?.grade).toBe("9.5");
  });

  test("unrecognized labels are ignored", () => {
    const html = "<dl><dt>Language</dt><dd>English</dd><dt>Grade</dt><dd>8</dd></dl>";
    const parsed = parseCgcCertPage(html);
    expect(parsed?.grade).toBe("8");
    expect(parsed?.subject).toBe("");
  });

  test("a page with NO known labels at all → null (shape miss)", () => {
    expect(parseCgcCertPage("<html><body>404 not found</body></html>")).toBeNull();
    expect(parseCgcCertPage("<dl><dt>Language</dt><dd>English</dd></dl>")).toBeNull();
  });
});

describe("fetchCgcCert", () => {
  const okFetch: FetchImpl = async () => new Response(certHtml, { status: 200 }) as Response;

  test("happy path: robots-gated fetch → parsed identity", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      urls.push(url);
      return new Response(certHtml, { status: 200 }) as Response;
    };
    const res = await fetchCgcCert("4189145001", fetchImpl, allowAll);
    expect(res).toEqual({
      ok: true,
      identity: {
        subject: "Charizard",
        year: "1999",
        set: "Pokemon Base Set",
        cardNo: "4",
        variety: "Holo",
        grade: "9.5",
      },
    });
    expect(urls).toEqual(["https://www.cgccards.com/certlookup/4189145001/"]);
  });

  test("robots-disallowed → typed 'robots' failure, no fetch fired", async () => {
    let fetched = false;
    const fetchImpl: FetchImpl = async () => {
      fetched = true;
      return new Response(certHtml) as Response;
    };
    const res = await fetchCgcCert("123456", fetchImpl, denyAll);
    expect(res).toEqual({ ok: false, kind: "robots" });
    expect(fetched).toBe(false);
  });

  test("network throw → 'http'", async () => {
    const boom: FetchImpl = async () => {
      throw new Error("ECONNRESET");
    };
    expect(await fetchCgcCert("123456", boom, allowAll)).toEqual({ ok: false, kind: "http" });
  });

  test("non-200 → 'http'", async () => {
    const notFound: FetchImpl = async () => new Response("nope", { status: 404 }) as Response;
    expect(await fetchCgcCert("123456", notFound, allowAll)).toEqual({
      ok: false,
      kind: "http",
    });
  });

  test("unparseable page → 'shape'", async () => {
    const empty: FetchImpl = async () =>
      new Response("<html>layout changed</html>", { status: 200 }) as Response;
    expect(await fetchCgcCert("123456", empty, allowAll)).toEqual({
      ok: false,
      kind: "shape",
    });
  });

  test("cert is URL-encoded into the lookup path (no injection)", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      urls.push(url);
      return new Response(certHtml, { status: 200 }) as Response;
    };
    await fetchCgcCert("12/..\\34", fetchImpl, allowAll);
    expect(urls[0]).toBe("https://www.cgccards.com/certlookup/12%2F..%5C34/");
  });

  test("robots gate receives the exact lookup path", async () => {
    const paths: string[] = [];
    const robots: Robots = {
      isAllowed: async (_host, path) => {
        paths.push(path);
        return true;
      },
    };
    await fetchCgcCert("4189145001", okFetch, robots);
    expect(paths).toEqual(["/certlookup/4189145001/"]);
  });
});
