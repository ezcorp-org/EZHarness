// Unit tests for the PriceCharting source — fixture-based, no live
// network. Fixtures are trimmed from the live Charizard capture so the
// parser is exercised against real markup.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GRADE_PRICE_ID,
  companyForLabel,
  fetchAllPrices,
  fetchPrices,
  firstProductHref,
  isConfidentMatch,
  parseCompanyPrices,
  parsePrices,
  type PriceMap,
} from "./pricecharting";
import type { PsaIdentity } from "./psa-api";
import {
  BROWSER_USER_AGENT,
  createHostQueue,
  createQueuedFetch,
  type FetchImpl,
  type Robots,
} from "../politeness";

const fixDir = join(import.meta.dir, "..", "..", "__fixtures__");
const searchHtml = readFileSync(join(fixDir, "pricecharting-search.html"), "utf8");
const searchAbsoluteHtml = readFileSync(join(fixDir, "pricecharting-search-absolute.html"), "utf8");
const productHtml = readFileSync(join(fixDir, "pricecharting-product.html"), "utf8");
const blanksHtml = readFileSync(join(fixDir, "pricecharting-product-blanks.html"), "utf8");

function identity(overrides: Partial<PsaIdentity> = {}): PsaIdentity {
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

const allowAll: Robots = { isAllowed: async () => true };
const denyAll: Robots = { isAllowed: async () => false };

/** Dispatch on URL: /search-products → search page, /game/ → product page. */
function makeFetch(opts: {
  product?: string;
  searchStatus?: number;
  productStatus?: number;
  onCall?: (url: string) => void;
} = {}): FetchImpl {
  return async (url) => {
    opts.onCall?.(url);
    if (url.includes("/search-products")) {
      return new Response(searchHtml, { status: opts.searchStatus ?? 200 }) as Response;
    }
    return new Response(opts.product ?? productHtml, { status: opts.productStatus ?? 200 }) as Response;
  };
}

// ── pure parsers ────────────────────────────────────────────────────

describe("firstProductHref", () => {
  test("returns the first relative /game/ href", () => {
    expect(firstProductHref(searchHtml)).toBe("/game/pokemon-base-set/charizard-4");
  });
  test("returns the PATH of an absolute PriceCharting-origin href", () => {
    // Live results pages emit absolute URLs; we must still hand back the path.
    expect(firstProductHref(searchAbsoluteHtml)).toBe(
      "/game/pokemon-japanese-super-electric-breaker/pikachu-ex-132",
    );
  });
  test("null when no product link is present", () => {
    expect(firstProductHref("<html>no results</html>")).toBeNull();
  });
  test("ignores /game/ links on any OTHER host (SSRF guard)", () => {
    // A full URL on a foreign origin must NOT be treated as a product link —
    // only PriceCharting's own origin (or a bare path) is accepted.
    expect(
      firstProductHref('<a href="https://evil.example.com/game/pokemon-base-set/charizard-4">x</a>'),
    ).toBeNull();
  });
});

describe("isConfidentMatch", () => {
  test("confident when slug carries the card number and a subject token", () => {
    expect(isConfidentMatch("/game/pokemon-base-set/charizard-4", identity())).toBe(true);
  });
  test("rejects when the card number is absent from the slug", () => {
    expect(isConfidentMatch("/game/pokemon-base-set/charizard-4", identity({ cardNo: "2" }))).toBe(false);
  });
  test("rejects when no subject token appears in the slug", () => {
    expect(isConfidentMatch("/game/pokemon-base-set/charizard-4", identity({ subject: "Blastoise" }))).toBe(false);
  });
  test("rejects when the subject is empty (nothing to anchor on)", () => {
    expect(isConfidentMatch("/game/pokemon-base-set/charizard-4", identity({ subject: "" }))).toBe(false);
  });

  // ── digit-boundary card-number gate ──
  test("card #4 does NOT match a '-40' slug (digit boundary)", () => {
    expect(isConfidentMatch("/game/set/charizard-40", identity({ cardNo: "4" }))).toBe(false);
  });
  test("card #4 DOES match a '-4' slug", () => {
    expect(isConfidentMatch("/game/set/charizard-4", identity({ cardNo: "4" }))).toBe(true);
  });
  test("empty cardNo skips the number check and leans on the subject token", () => {
    expect(isConfidentMatch("/game/set/charizard-holo", identity({ cardNo: "" }))).toBe(true);
    expect(isConfidentMatch("/game/set/blastoise-holo", identity({ cardNo: "" }))).toBe(false);
  });

  // ── exact subject-token gate ──
  test("'mew' does NOT match a 'mewtwo' slug (exact token, not substring)", () => {
    expect(isConfidentMatch("/game/set/mewtwo-25", identity({ subject: "Mew", cardNo: "25" }))).toBe(false);
  });
  test("an exact subject token is accepted", () => {
    expect(isConfidentMatch("/game/set/mewtwo-25", identity({ subject: "Mewtwo", cardNo: "25" }))).toBe(true);
  });
  test("sub-3-char subject fragments are dropped (no anchor → reject)", () => {
    // "mr" (2 chars) is filtered; "mime" anchors the match.
    expect(isConfidentMatch("/game/set/mr-mime-10", identity({ subject: "Mr Mime", cardNo: "10" }))).toBe(true);
    expect(isConfidentMatch("/game/set/charizard-10", identity({ subject: "Ex", cardNo: "10" }))).toBe(false);
  });
});

describe("parsePrices", () => {
  test("maps each grade to its price column", () => {
    expect(parsePrices(productHtml)).toEqual({
      Ungraded: 381.55,
      "PSA 7": 714.5,
      "PSA 8": 1201.99,
      "PSA 9": 2587.5,
      "PSA 10": 30100,
    });
  });
  test("blank / absent price cells → null (never $0)", () => {
    expect(parsePrices(blanksHtml)).toEqual({
      Ungraded: null,
      "PSA 7": null,
      "PSA 8": 1201.99,
      "PSA 9": null,
      "PSA 10": 30100,
    });
  });
  test("the mapping covers exactly the five publishable grades", () => {
    expect(Object.keys(GRADE_PRICE_ID)).toEqual(["Ungraded", "PSA 7", "PSA 8", "PSA 9", "PSA 10"]);
  });
});

// ── per-company graded columns (identify_slab flow) ─────────────────

describe("companyForLabel", () => {
  test("explicit company rows map verbatim (case-insensitive)", () => {
    expect(companyForLabel("PSA 10")).toEqual({ company: "PSA", grade: "10" });
    expect(companyForLabel("bgs 9.5")).toEqual({ company: "BGS", grade: "9.5" });
    expect(companyForLabel("CGC 10")).toEqual({ company: "CGC", grade: "10" });
    expect(companyForLabel("SGC 10")).toEqual({ company: "SGC", grade: "10" });
  });

  test("generic 'Grade N' rows are PSA-tracked, EXCEPT 9.5 which is BGS", () => {
    expect(companyForLabel("Grade 7")).toEqual({ company: "PSA", grade: "7" });
    expect(companyForLabel("Grade 9.5")).toEqual({ company: "BGS", grade: "9.5" });
  });

  test("qualified and non-grade labels are ignored", () => {
    expect(companyForLabel("BGS 10 Black")).toBeNull();
    expect(companyForLabel("CGC 10 Pristine")).toBeNull();
    expect(companyForLabel("Ungraded")).toBeNull();
    expect(companyForLabel("Box Only")).toBeNull();
  });
});

describe("parseCompanyPrices", () => {
  test("captures every per-company graded column from the full price guide", () => {
    expect(parseCompanyPrices(productHtml)).toEqual({
      PSA: {
        "1": 120,
        "2": 185,
        "3": 252.99,
        "4": 322.02,
        "5": 400,
        "6": 495,
        "7": 714.5,
        "8": 1201.99,
        "9": 2587.5,
        "10": 30100,
      },
      BGS: { "9.5": 3875, "10": 46000 },
      CGC: { "10": 11300 },
      SGC: { "10": 8494.97 },
    });
  });

  test("blank / absent / non-dollar cells → null; absent rows → absent keys", () => {
    expect(parseCompanyPrices(blanksHtml)).toEqual({
      PSA: { "9": null, "10": 30100 },
      BGS: { "9.5": null },
      CGC: { "10": null },
      SGC: { "10": null },
    });
  });

  test("a page WITHOUT the full-prices table → {} (older captures degrade honestly)", () => {
    expect(parseCompanyPrices("<html><body>no table here</body></html>")).toEqual({});
  });
});

describe("fetchAllPrices", () => {
  test("one page fetch yields BOTH the summary map and the company map", async () => {
    let calls = 0;
    const prices = await fetchAllPrices(
      identity(),
      makeFetch({ onCall: () => calls++ }),
      allowAll,
    );
    expect(prices.prices["PSA 9"]).toBe(2587.5);
    expect(prices.companies.PSA?.["10"]).toBe(30100);
    expect(prices.companies.SGC).toEqual({ "10": 8494.97 });
    expect(calls).toBe(2); // search + product — same budget as fetchPrices
  });

  test("soft miss (unconfident match) → all-null summary + empty companies", async () => {
    const prices = await fetchAllPrices(
      identity({ subject: "Blastoise" }),
      makeFetch(),
      allowAll,
    );
    expect(prices.prices).toEqual(ALL_NULL);
    expect(prices.companies).toEqual({});
  });

  test("hard network error propagates (caller stamps pricecharting:error)", async () => {
    const boom: FetchImpl = async () => {
      throw new Error("ECONNRESET");
    };
    await expect(fetchAllPrices(identity(), boom, allowAll)).rejects.toThrow("ECONNRESET");
  });
});

// ── fetchPrices ─────────────────────────────────────────────────────

const ALL_NULL: PriceMap = { Ungraded: null, "PSA 7": null, "PSA 8": null, "PSA 9": null, "PSA 10": null };

describe("fetchPrices", () => {
  test("happy path: search → confident product → parsed prices", async () => {
    const prices = await fetchPrices(identity(), makeFetch(), allowAll);
    expect(prices).toEqual({
      Ungraded: 381.55,
      "PSA 7": 714.5,
      "PSA 8": 1201.99,
      "PSA 9": 2587.5,
      "PSA 10": 30100,
    });
  });

  test("blank price cells on the product page → null prices", async () => {
    const prices = await fetchPrices(identity(), makeFetch({ product: blanksHtml }), allowAll);
    expect(prices["PSA 8"]).toBe(1201.99);
    expect(prices.Ungraded).toBeNull();
    expect(prices["PSA 9"]).toBeNull();
  });

  test("unconfident match → all null (wrong card never gets prices)", async () => {
    const prices = await fetchPrices(identity({ subject: "Blastoise" }), makeFetch(), allowAll);
    expect(prices).toEqual(ALL_NULL);
  });

  test("robots-disallowed → all null, and no fetch is attempted", async () => {
    let fetched = false;
    const prices = await fetchPrices(identity(), makeFetch({ onCall: () => { fetched = true; } }), denyAll);
    expect(prices).toEqual(ALL_NULL);
    expect(fetched).toBe(false);
  });

  test("empty subject → all null with no request (polite short-circuit)", async () => {
    let fetched = false;
    const prices = await fetchPrices(identity({ subject: "" }), makeFetch({ onCall: () => { fetched = true; } }), allowAll);
    expect(prices).toEqual(ALL_NULL);
    expect(fetched).toBe(false);
  });

  test("search page returns non-200 → all null", async () => {
    const prices = await fetchPrices(identity(), makeFetch({ searchStatus: 503 }), allowAll);
    expect(prices).toEqual(ALL_NULL);
  });

  test("no product link in the search results → all null", async () => {
    const emptySearch: FetchImpl = async () => new Response("<html>no results</html>", { status: 200 }) as Response;
    const prices = await fetchPrices(identity(), emptySearch, allowAll);
    expect(prices).toEqual(ALL_NULL);
  });

  test("product page returns non-200 → all null", async () => {
    const prices = await fetchPrices(identity(), makeFetch({ productStatus: 500 }), allowAll);
    expect(prices).toEqual(ALL_NULL);
  });

  test("robots allows the search path but blocks the product path → all null", async () => {
    const robots: Robots = { isAllowed: async (_host, path) => path === "/search-products" };
    const prices = await fetchPrices(identity(), makeFetch(), robots);
    expect(prices).toEqual(ALL_NULL);
  });

  test("a hard network error propagates (pipeline stamps pricecharting:error)", async () => {
    const boom: FetchImpl = async () => { throw new Error("ECONNRESET"); };
    await expect(fetchPrices(identity(), boom, allowAll)).rejects.toThrow("ECONNRESET");
  });

  test("carries the browser User-Agent through the queued fetch on search + product", async () => {
    const uas: Array<string | null> = [];
    const underlying: FetchImpl = async (url, init) => {
      uas.push(new Headers(init?.headers).get("user-agent"));
      if (url.includes("/search-products")) return new Response(searchHtml, { status: 200 }) as Response;
      return new Response(productHtml, { status: 200 }) as Response;
    };
    const queued = createQueuedFetch(createHostQueue(0), underlying);
    await fetchPrices(identity(), queued, allowAll);
    expect(uas.length).toBeGreaterThanOrEqual(2); // search + product both fetched
    expect(uas.every((u) => u === BROWSER_USER_AGENT)).toBe(true);
  });
});

// A fake Response for the 307-redirect case: the search request lands on a
// product page (`url` is a /game/… path). Response.url is read-only, so we
// construct a duck-typed Response rather than `new Response(...)`.
function redirectedResponse(url: string, html: string, ok = true): Response {
  return { ok, url, text: async () => html } as unknown as Response;
}

describe("fetchPrices — search 307-redirects straight to the product", () => {
  test("parses the redirected product page with NO second fetch", async () => {
    let calls = 0;
    const redirectFetch: FetchImpl = async () => {
      calls++;
      // PriceCharting's real redirect target carries a ?q= query too.
      return redirectedResponse(
        "https://www.pricecharting.com/game/pokemon-base-set/charizard-1999-2000-4?q=charizard",
        productHtml,
      );
    };
    const prices = await fetchPrices(identity(), redirectFetch, allowAll);
    expect(prices["PSA 9"]).toBe(2587.5);
    expect(prices.Ungraded).toBe(381.55);
    expect(calls).toBe(1); // the search response WAS the product page
  });

  test("redirect to an unconfident product slug → all null, one fetch", async () => {
    let calls = 0;
    const redirectFetch: FetchImpl = async () => {
      calls++;
      return redirectedResponse("https://www.pricecharting.com/game/set/charizard-40", productHtml);
    };
    const prices = await fetchPrices(identity({ cardNo: "4" }), redirectFetch, allowAll);
    expect(prices).toEqual(ALL_NULL); // "4" must not match "-40"
    expect(calls).toBe(1);
  });

  test("redirect target that robots disallows → all null (body discarded)", async () => {
    const redirectFetch: FetchImpl = async () =>
      redirectedResponse("https://www.pricecharting.com/game/pokemon-base-set/charizard-4", productHtml);
    // Search path allowed, but the /game/ product path is not.
    const denyGame: Robots = { isAllowed: async (_host, path) => !path.startsWith("/game/") };
    const prices = await fetchPrices(identity(), redirectFetch, denyGame);
    expect(prices).toEqual(ALL_NULL);
  });

  test("empty Response.url falls back to the request url (results-page flow)", async () => {
    // A fake Response with url:"" must be treated as the search RESULTS page
    // (its request path is /search-products, not /game/) → legacy 2-fetch flow.
    let productFetched = false;
    const fetchImpl: FetchImpl = async (url) => {
      if (url.includes("/search-products")) return redirectedResponse("", searchHtml);
      productFetched = true;
      return redirectedResponse("", productHtml);
    };
    const prices = await fetchPrices(identity(), fetchImpl, allowAll);
    expect(prices["PSA 9"]).toBe(2587.5);
    expect(productFetched).toBe(true); // took the results-page branch
  });
});
