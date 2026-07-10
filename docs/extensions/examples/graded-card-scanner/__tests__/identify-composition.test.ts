// END-TO-END composition test for the identify_slab pipeline: unlike
// lib/identify.test.ts (which injects every dep) and index.test.ts
// (which swaps the whole pipeline via _setIdentifyForTests), this runs
// the REAL wiring shape from index.ts's `realIdentify` — real
// `decodeSlabImage` over a generated ITF barcode PNG, real classify,
// and the real PSA / CGC / PriceCharting source modules — with ONLY the
// transport (fetch → fixtures) and the clock swapped. Deterministic +
// offline; asserts the full record shape AND the exact outbound URLs.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeSlabImage } from "../lib/decode";
import { buildIdentify } from "../lib/identify";
import type { Robots, TimedFetch } from "../lib/politeness";
import { fetchCgcCert } from "../lib/sources/cgc";
import { fetchPsaCert } from "../lib/sources/psa-api";
import { fetchAllPrices } from "../lib/sources/pricecharting";
import { renderItfRgba, rgbaToPng } from "./helpers/barcode-render";

const fixDir = join(import.meta.dir, "..", "__fixtures__");
const psaJson = readFileSync(join(fixDir, "psa-cert-response.json"), "utf8");
const searchHtml = readFileSync(join(fixDir, "pricecharting-search.html"), "utf8");
const productHtml = readFileSync(join(fixDir, "pricecharting-product.html"), "utf8");

const FIXED_NOW = "2026-07-09T00:00:00.000Z";

describe("identify pipeline composition (no test seam)", () => {
  test("generated ITF slab PNG → real decode → real classify → fixture-backed sources → full record", async () => {
    const fetched: string[] = [];
    const fixtureFetch: TimedFetch = async (url) => {
      fetched.push(url);
      if (url.startsWith("https://api.psacard.com/publicapi/cert/GetByCertNumber/")) {
        return new Response(psaJson, { status: 200 });
      }
      if (url.includes("/search-products")) {
        return new Response(searchHtml, { status: 200 });
      }
      if (url.includes("/game/")) {
        return new Response(productHtml, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const allowAll: Robots = { isAllowed: async () => true };

    const identify = buildIdentify({
      decodeImage: decodeSlabImage,
      getToken: async () => "psa-test-token",
      fetchPsa: (cert, token) => fetchPsaCert(cert, token, fixtureFetch),
      fetchCgc: (cert) => fetchCgcCert(cert, fixtureFetch, allowAll),
      fetchAllPrices: (identity) => fetchAllPrices(identity, fixtureFetch, allowAll),
      now: () => FIXED_NOW,
    });

    // The PSA front label's actual symbology: an ITF barcode of the
    // cert digits, rendered in-test (shared with lib/decode.test.ts).
    const bytes = rgbaToPng(renderItfRgba("49392223"));
    const record = await identify(bytes, "image/png");

    expect(record).toEqual({
      cert: "49392223",
      grader: "PSA",
      // From the PSA API fixture (identity strings verbatim).
      identity: {
        subject: "CHARIZARD",
        year: "1999",
        set: "POKEMON GAME",
        cardNo: "4",
        variety: "HOLO",
        grade: "MINT 9",
      },
      // From the product page's full price guide (per-company columns).
      grades: {
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
      },
      // Adjacent-grade % steps: companies sorted asc; CGC/SGC (one
      // priced grade each) draw nothing.
      deltas: [
        {
          company: "BGS",
          steps: [{ from: "9.5", to: "10", fromPrice: 3875, toPrice: 46000, pct: 1087.1 }],
        },
        {
          company: "PSA",
          steps: [
            { from: "1", to: "2", fromPrice: 120, toPrice: 185, pct: 54.2 },
            { from: "2", to: "3", fromPrice: 185, toPrice: 252.99, pct: 36.8 },
            { from: "3", to: "4", fromPrice: 252.99, toPrice: 322.02, pct: 27.3 },
            { from: "4", to: "5", fromPrice: 322.02, toPrice: 400, pct: 24.2 },
            { from: "5", to: "6", fromPrice: 400, toPrice: 495, pct: 23.8 },
            { from: "6", to: "7", fromPrice: 495, toPrice: 714.5, pct: 44.3 },
            { from: "7", to: "8", fromPrice: 714.5, toPrice: 1201.99, pct: 68.2 },
            { from: "8", to: "9", fromPrice: 1201.99, toPrice: 2587.5, pct: 115.3 },
            { from: "9", to: "10", fromPrice: 2587.5, toPrice: 30100, pct: 1063.3 },
          ],
        },
      ],
      sources: {
        decode: { source: "zxing", fetchedAt: FIXED_NOW },
        identity: { source: "psa-api", fetchedAt: FIXED_NOW },
        price: { source: "pricecharting", fetchedAt: FIXED_NOW },
      },
    });

    // Exactly three outbound requests, all to granted hosts: PSA API,
    // PriceCharting search, PriceCharting product page. The CGC source
    // never fires on the PSA path.
    expect(fetched).toEqual([
      "https://api.psacard.com/publicapi/cert/GetByCertNumber/49392223",
      `https://www.pricecharting.com/search-products?q=${encodeURIComponent(
        "1999 pokemon game charizard 4",
      )}&type=prices`,
      "https://www.pricecharting.com/game/pokemon-base-set/charizard-4",
    ]);
  });
});
