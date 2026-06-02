// Unit tests for the price-chart data fetchers (Yahoo Finance + CoinGecko).
//
// index.test.ts injects whole fetcher functions via `_setFetchersForTests`,
// so the REAL fetchers.ts never runs there. This suite exercises it
// directly through the `_setFetchForTests` seam — a fake `fetch` returns
// canned JSON so no network is touched — covering both happy paths and
// every thrown-error branch.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  fetchStockSeries,
  fetchCryptoSeries,
  _setFetchForTests,
  _resetFetchForTests,
} from "./fetchers";

/** Build a minimal Response-like object for the fetcher's `res.ok` /
 *  `res.status` / `res.json()` usage. */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => _resetFetchForTests());

describe("fetchStockSeries (Yahoo Finance)", () => {
  const YAHOO_OK = {
    chart: {
      result: [
        {
          meta: {
            symbol: "AAPL",
            longName: "Apple Inc.",
            regularMarketPrice: 200,
            chartPreviousClose: 190,
            currency: "USD",
          },
          timestamp: [1700000000, 1700086400],
          indicators: { quote: [{ close: [190, 200] }] },
        },
      ],
      error: null,
    },
  };

  test("happy path maps timestamps+closes into ms-scaled points and meta fields", async () => {
    _setFetchForTests(async () => jsonResponse(YAHOO_OK));
    const data = await fetchStockSeries("aapl");
    expect(data.kind).toBe("stock");
    expect(data.symbol).toBe("AAPL");
    expect(data.name).toBe("Apple Inc.");
    expect(data.currency).toBe("USD");
    expect(data.lastPrice).toBe(200);
    expect(data.prevClose).toBe(190);
    expect(data.points).toEqual([
      { t: 1700000000 * 1000, v: 190 },
      { t: 1700086400 * 1000, v: 200 },
    ]);
    // AAPL has a known domain → a clearbit logo URL.
    expect(data.logoUrl).toContain("apple.com");
  });

  test("falls back to ticker + last/first point when meta fields are absent", async () => {
    _setFetchForTests(async () =>
      jsonResponse({
        chart: {
          result: [
            {
              meta: {},
              timestamp: [1, 2],
              // null close is filtered out
              indicators: { quote: [{ close: [null, 42] }] },
            },
          ],
        },
      }),
    );
    const data = await fetchStockSeries("zzzz");
    expect(data.symbol).toBe("ZZZZ");
    expect(data.name).toBe("ZZZZ");
    expect(data.currency).toBe("USD");
    expect(data.points).toEqual([{ t: 2000, v: 42 }]);
    // last/prev derive from the single point when meta prices are missing.
    expect(data.lastPrice).toBe(42);
    expect(data.prevClose).toBe(42);
    // Unknown ticker → no domain → empty logo.
    expect(data.logoUrl).toBe("");
  });

  test("non-ok HTTP throws", async () => {
    _setFetchForTests(async () => jsonResponse({}, { ok: false, status: 503 }));
    await expect(fetchStockSeries("AAPL")).rejects.toThrow(/HTTP 503/);
  });

  test("missing result throws with the chart error description", async () => {
    _setFetchForTests(async () =>
      jsonResponse({ chart: { result: [], error: { description: "Not Found" } } }),
    );
    await expect(fetchStockSeries("NOPE")).rejects.toThrow(/Not Found/);
  });

  test("missing result with no error description falls back to 'no result'", async () => {
    _setFetchForTests(async () => jsonResponse({ chart: {} }));
    await expect(fetchStockSeries("NOPE")).rejects.toThrow(/no result/);
  });

  test("a result with zero usable closes throws", async () => {
    _setFetchForTests(async () =>
      jsonResponse({
        chart: {
          result: [{ meta: {}, timestamp: [1], indicators: { quote: [{ close: [null] }] } }],
        },
      }),
    );
    await expect(fetchStockSeries("AAPL")).rejects.toThrow(/no closes/);
  });
});

describe("fetchCryptoSeries (CoinGecko)", () => {
  const COIN_META = {
    symbol: "btc",
    name: "Bitcoin",
    image: { large: "https://img/large.png", small: "https://img/small.png" },
    market_data: {
      current_price: { usd: 50000 },
      price_change_24h_in_currency: { usd: 1000 },
    },
  };
  const COIN_SERIES = { prices: [[1, 49000], [2, 50000]] as Array<[number, number]> };

  test("happy path: two fetches (meta + series) produce a crypto ChartData", async () => {
    let call = 0;
    _setFetchForTests(async () => {
      call += 1;
      return jsonResponse(call === 1 ? COIN_META : COIN_SERIES);
    });
    const data = await fetchCryptoSeries("btc");
    expect(data.kind).toBe("crypto");
    expect(data.symbol).toBe("BTC");
    expect(data.name).toBe("Bitcoin");
    expect(data.currency).toBe("USD");
    expect(data.logoUrl).toBe("https://img/large.png");
    expect(data.points).toEqual([
      { t: 1, v: 49000 },
      { t: 2, v: 50000 },
    ]);
    expect(data.lastPrice).toBe(50000);
    // prev = last - change24h
    expect(data.prevClose).toBe(49000);
  });

  test("falls back to symbol/last-point/empty-logo when meta market_data is absent", async () => {
    let call = 0;
    _setFetchForTests(async () => {
      call += 1;
      return jsonResponse(call === 1 ? { symbol: "eth" } : COIN_SERIES);
    });
    const data = await fetchCryptoSeries("eth");
    expect(data.symbol).toBe("ETH");
    expect(data.name).toBe("ETH");
    expect(data.logoUrl).toBe("");
    expect(data.lastPrice).toBe(50000); // last point's value
    expect(data.prevClose).toBe(50000); // change24h defaults to 0
  });

  test("non-ok meta HTTP throws", async () => {
    _setFetchForTests(async () => jsonResponse({}, { ok: false, status: 429 }));
    await expect(fetchCryptoSeries("btc")).rejects.toThrow(/HTTP 429/);
  });

  test("non-ok series HTTP (second fetch) throws", async () => {
    let call = 0;
    _setFetchForTests(async () => {
      call += 1;
      return call === 1 ? jsonResponse(COIN_META) : jsonResponse({}, { ok: false, status: 500 });
    });
    await expect(fetchCryptoSeries("btc")).rejects.toThrow(/market_chart returned HTTP 500/);
  });

  test("empty price series throws", async () => {
    let call = 0;
    _setFetchForTests(async () => {
      call += 1;
      return jsonResponse(call === 1 ? COIN_META : { prices: [] });
    });
    await expect(fetchCryptoSeries("btc")).rejects.toThrow(/no price points/);
  });
});
