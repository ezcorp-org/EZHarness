// Unit tests for the identify_slab pipeline seam (buildIdentify) — all
// deps injected, no I/O. Pins every grader branch, the null-honesty
// stamps, and the price/delta wiring.

import { describe, expect, test } from "bun:test";
import { buildIdentify, emptyIdentity, type IdentifyDeps } from "./identify";
import type { PsaIdentity } from "./sources/psa-api";

const BYTES = new Uint8Array([1, 2, 3]);

function fullIdentity(overrides: Partial<PsaIdentity> = {}): PsaIdentity {
  return {
    subject: "Charizard",
    year: "1999",
    set: "Pokemon Base Set",
    cardNo: "4",
    variety: "Holo",
    grade: "PSA 9",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<IdentifyDeps> = {}): IdentifyDeps {
  return {
    decodeImage: () => "49392223",
    getToken: async () => "psa-token",
    fetchPsa: async () => ({
      ok: true,
      identity: fullIdentity(),
      popAtGrade: 1234,
      popHigher: 99,
    }),
    fetchCgc: async () => ({ ok: true, identity: fullIdentity({ grade: "9.5" }) }),
    fetchAllPrices: async () => ({
      prices: { Ungraded: 381.55, "PSA 9": 2587.5, "PSA 10": 30100 },
      companies: { PSA: { "9": 2587.5, "10": 30100 }, CGC: { "10": 11300 } },
    }),
    now: () => "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildIdentify — PSA path", () => {
  test("bare ITF decode → PSA identity + per-company prices + deltas", async () => {
    const identify = buildIdentify(makeDeps());
    const record = await identify(BYTES, "image/png");
    expect(record.cert).toBe("49392223");
    expect(record.grader).toBe("PSA");
    expect(record.identity.subject).toBe("Charizard");
    expect(record.grades).toEqual({
      PSA: { "9": 2587.5, "10": 30100 },
      CGC: { "10": 11300 },
    });
    // Deltas: CGC has one priced grade → omitted; PSA 9→10.
    expect(record.deltas).toEqual([
      {
        company: "PSA",
        steps: [{ from: "9", to: "10", fromPrice: 2587.5, toPrice: 30100, pct: 1063.3 }],
      },
    ]);
    expect(record.sources).toEqual({
      decode: { source: "zxing", fetchedAt: "2026-07-09T00:00:00.000Z" },
      identity: { source: "psa-api", fetchedAt: "2026-07-09T00:00:00.000Z" },
      price: { source: "pricecharting", fetchedAt: "2026-07-09T00:00:00.000Z" },
    });
  });

  test("no token → honest nulls with psa-api:no-token, prices NOT searched", async () => {
    let priceCalls = 0;
    const identify = buildIdentify(
      makeDeps({
        getToken: async () => null,
        fetchPsa: async (_cert, token) => {
          expect(token).toBeNull();
          return { ok: false, kind: "no-token" };
        },
        fetchAllPrices: async () => {
          priceCalls++;
          return { prices: {}, companies: {} };
        },
      }),
    );
    const record = await identify(BYTES, "image/png");
    expect(record.grader).toBe("PSA");
    expect(record.identity).toEqual(emptyIdentity());
    expect(record.sources.identity.source).toBe("psa-api:no-token");
    expect(record.sources.price.source).toBe("not-searched");
    expect(priceCalls).toBe(0);
    expect(record.grades).toEqual({});
    expect(record.deltas).toEqual([]);
  });

  test("PSA API failure kinds stamp psa-api:error(kind)", async () => {
    const identify = buildIdentify(
      makeDeps({ fetchPsa: async () => ({ ok: false, kind: "quota" }) }),
    );
    const record = await identify(BYTES, "image/png");
    expect(record.sources.identity.source).toBe("psa-api:error(quota)");
  });
});

describe("buildIdentify — CGC path", () => {
  test("cgccards URL decode → CGC identity from the cert page", async () => {
    const certs: string[] = [];
    const identify = buildIdentify(
      makeDeps({
        decodeImage: () => "https://www.cgccards.com/certlookup/4189145001/",
        fetchCgc: async (cert) => {
          certs.push(cert);
          return { ok: true, identity: fullIdentity({ grade: "9.5" }) };
        },
      }),
    );
    const record = await identify(BYTES, "image/png");
    expect(record.grader).toBe("CGC");
    expect(record.cert).toBe("4189145001");
    expect(certs).toEqual(["4189145001"]);
    expect(record.identity.grade).toBe("9.5");
    expect(record.sources.identity.source).toBe("cgc-cert-page");
    expect(record.sources.price.source).toBe("pricecharting");
  });

  test("CGC failure kinds stamp cgc-cert-page:error(kind)", async () => {
    const identify = buildIdentify(
      makeDeps({
        decodeImage: () => "https://www.cgccards.com/certlookup/4189145001/",
        fetchCgc: async () => ({ ok: false, kind: "shape" }),
      }),
    );
    const record = await identify(BYTES, "image/png");
    expect(record.identity).toEqual(emptyIdentity());
    expect(record.sources.identity.source).toBe("cgc-cert-page:error(shape)");
    expect(record.sources.price.source).toBe("not-searched");
  });
});

describe("buildIdentify — BGS / SGC decode-only (v1)", () => {
  test("BGS: cert + grader, identity honest nulls, stamped decode-only", async () => {
    const identify = buildIdentify(
      makeDeps({
        decodeImage: () => "https://www.beckett.com/grading/card-lookup?item=0012345678",
      }),
    );
    const record = await identify(BYTES, "image/png");
    expect(record.grader).toBe("BGS");
    expect(record.cert).toBe("0012345678");
    expect(record.identity).toEqual(emptyIdentity());
    expect(record.sources.identity.source).toBe("decode-only");
    expect(record.sources.price.source).toBe("not-searched");
  });

  test("SGC mirrors the BGS branch", async () => {
    const identify = buildIdentify(
      makeDeps({ decodeImage: () => "https://gosgc.com/cert-code-lookup/1234567" }),
    );
    const record = await identify(BYTES, "image/png");
    expect(record.grader).toBe("SGC");
    expect(record.sources.identity.source).toBe("decode-only");
  });
});

describe("buildIdentify — unknown / no-decode", () => {
  test("no barcode found → grader unknown, zxing:none stamp, honest nulls", async () => {
    const identify = buildIdentify(makeDeps({ decodeImage: () => null }));
    const record = await identify(BYTES, "image/png");
    expect(record).toEqual({
      cert: null,
      grader: "unknown",
      identity: emptyIdentity(),
      grades: {},
      deltas: [],
      sources: {
        decode: { source: "zxing:none", fetchedAt: "2026-07-09T00:00:00.000Z" },
        identity: { source: "none", fetchedAt: "2026-07-09T00:00:00.000Z" },
        price: { source: "not-searched", fetchedAt: "2026-07-09T00:00:00.000Z" },
      },
    });
  });

  test("unclassifiable decode payload → unknown", async () => {
    const identify = buildIdentify(makeDeps({ decodeImage: () => "hello world" }));
    const record = await identify(BYTES, "image/png");
    expect(record.grader).toBe("unknown");
    expect(record.sources.decode.source).toBe("zxing");
  });

  test("SSRF pin: malicious QR payloads → grader unknown, ZERO fetch invocations", async () => {
    // A hostile slab could QR-encode an attacker URL. Neither a lookalike
    // path (`/certlookup/…` on evil.com) nor a grader-host string smuggled
    // into the query may classify — and, critically, NO fetcher (PSA, CGC,
    // PriceCharting) may fire.
    const payloads = [
      "https://evil.com/certlookup/12345",
      "https://evil.com/?cgccards.com",
    ];
    for (const payload of payloads) {
      let fetchCalls = 0;
      const identify = buildIdentify(
        makeDeps({
          decodeImage: () => payload,
          getToken: async () => {
            fetchCalls++; // token resolution only happens on the PSA path
            return "psa-token";
          },
          fetchPsa: async () => {
            fetchCalls++;
            return { ok: false, kind: "http" };
          },
          fetchCgc: async () => {
            fetchCalls++;
            return { ok: false, kind: "http" };
          },
          fetchAllPrices: async () => {
            fetchCalls++;
            return { prices: {}, companies: {} };
          },
        }),
      );
      const record = await identify(BYTES, "image/png");
      expect(record.grader).toBe("unknown");
      expect(record.cert).toBeNull();
      expect(record.identity).toEqual(emptyIdentity());
      expect(record.sources.identity.source).toBe("none");
      expect(record.sources.price.source).toBe("not-searched");
      expect(fetchCalls).toBe(0);
    }
  });

  test("undecodable bytes THROW (tool layer maps to toolError)", async () => {
    const identify = buildIdentify(
      makeDeps({
        decodeImage: () => {
          throw new Error("unsupported image MIME");
        },
      }),
    );
    await expect(identify(BYTES, "text/plain")).rejects.toThrow("unsupported image MIME");
  });
});

describe("buildIdentify — price failure isolation", () => {
  test("a throwing PriceCharting lookup stamps pricecharting:error with empty grades", async () => {
    const identify = buildIdentify(
      makeDeps({
        fetchAllPrices: async () => {
          throw new Error("ECONNRESET");
        },
      }),
    );
    const record = await identify(BYTES, "image/png");
    expect(record.identity.subject).toBe("Charizard"); // identity survived
    expect(record.grades).toEqual({});
    expect(record.deltas).toEqual([]);
    expect(record.sources.price.source).toBe("pricecharting:error");
  });

  test("whitespace-only subject is treated as unsearchable", async () => {
    let priceCalls = 0;
    const identify = buildIdentify(
      makeDeps({
        fetchPsa: async () => ({
          ok: true,
          identity: fullIdentity({ subject: "   " }),
          popAtGrade: null,
          popHigher: null,
        }),
        fetchAllPrices: async () => {
          priceCalls++;
          return { prices: {}, companies: {} };
        },
      }),
    );
    const record = await identify(BYTES, "image/png");
    expect(priceCalls).toBe(0);
    expect(record.sources.price.source).toBe("not-searched");
  });
});
