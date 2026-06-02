// Unit tests for the refactored price-chart extension.
//
// The extension no longer writes HTML or returns iframeSrc. It just
// fetches the price series and returns a JSON payload the host's
// PriceChartCard renders client-side. Tests verify: input validation,
// symbol resolution, and the happy-path payload shape (with mocked
// fetchers so no live network).

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  tools,
  start,
  _setFetchersForTests,
  _resetBindingsForTests,
} from "./index";
import { resolveCryptoId, lookupStockDomain, clearbitLogoUrl } from "./lib/tickers";
import type { ChartData, ChartPoint } from "./lib/types";

// ── helpers ────────────────────────────────────────────────────────

function expectText(out: unknown): string {
  const o = out as { content?: Array<{ type: string; text: string }> };
  const first = o.content?.[0];
  if (!first || first.type !== "text") throw new Error("tool-result has no text content");
  return first.text;
}

function expectIsError(out: unknown): boolean {
  return (out as { isError?: boolean }).isError === true;
}

function makeSeries(count: number, base = 100): ChartPoint[] {
  const now = Date.parse("2026-05-01T00:00:00Z");
  const day = 86400000;
  const points: ChartPoint[] = [];
  for (let i = 0; i < count; i++) {
    points.push({
      t: now - (count - 1 - i) * day,
      v: base + Math.sin(i / 5) * 10 + i * 0.1,
    });
  }
  return points;
}

function fakeStock(symbol: string, name: string): ChartData {
  return {
    kind: "stock",
    symbol,
    name,
    logoUrl: `https://logo.clearbit.com/${symbol.toLowerCase()}.com`,
    currency: "USD",
    points: makeSeries(252, 150),
    lastPrice: 152.34,
    prevClose: 150.0,
  };
}

function fakeCrypto(symbol: string, name: string): ChartData {
  return {
    kind: "crypto",
    symbol,
    name,
    logoUrl: `https://assets.coingecko.com/coins/images/1/large/${name.toLowerCase()}.png`,
    currency: "USD",
    points: makeSeries(365, 30000),
    lastPrice: 31000,
    prevClose: 30200,
  };
}

beforeEach(() => {
  _resetBindingsForTests();
});

afterEach(() => {
  _resetBindingsForTests();
});

// ── Input validation ───────────────────────────────────────────────

describe("input validation", () => {
  test("empty stock ticker → toolError", async () => {
    const out = await tools.get_stock_chart!({ ticker: "" });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toMatch(/ticker/i);
  });

  test("whitespace stock ticker → toolError", async () => {
    const out = await tools.get_stock_chart!({ ticker: "   " });
    expect(expectIsError(out)).toBe(true);
  });

  test("missing ticker argument → toolError", async () => {
    const out = await tools.get_stock_chart!({});
    expect(expectIsError(out)).toBe(true);
  });

  test("non-string ticker → toolError", async () => {
    const out = await tools.get_stock_chart!({ ticker: 42 });
    expect(expectIsError(out)).toBe(true);
  });

  test("empty crypto symbol → toolError", async () => {
    const out = await tools.get_crypto_chart!({ symbol: "" });
    expect(expectIsError(out)).toBe(true);
  });
});

// ── tickers / symbol resolution ────────────────────────────────────

describe("symbol resolution", () => {
  test("known crypto symbol → coingecko id", () => {
    expect(resolveCryptoId("BTC")).toBe("bitcoin");
    expect(resolveCryptoId("eth")).toBe("ethereum");
    expect(resolveCryptoId("SOL")).toBe("solana");
  });

  test("unknown crypto symbol → lowercased passthrough", () => {
    expect(resolveCryptoId("FAKECOIN-123")).toBe("fakecoin-123");
  });

  test("crypto id passed verbatim → unchanged after lowercase", () => {
    expect(resolveCryptoId("bitcoin")).toBe("bitcoin");
  });

  test("known stock ticker resolves to domain + Clearbit URL", () => {
    const domain = lookupStockDomain("AAPL");
    expect(domain).toBe("apple.com");
    expect(clearbitLogoUrl(domain!)).toBe("https://logo.clearbit.com/apple.com");
  });

  test("unknown stock ticker returns undefined", () => {
    expect(lookupStockDomain("ZZZZ")).toBeUndefined();
  });
});

// ── End-to-end handler happy paths ─────────────────────────────────

describe("get_stock_chart happy path", () => {
  test("returns JSON payload with symbol/name/points (no iframeSrc)", async () => {
    _setFetchersForTests({
      stock: async (ticker) => fakeStock(ticker.toUpperCase(), `${ticker} Inc.`),
    });

    const out = await tools.get_stock_chart!({ ticker: "AAPL" });
    expect(expectIsError(out)).toBe(false);
    const payload = JSON.parse(expectText(out));
    expect(payload.symbol).toBe("AAPL");
    expect(payload.kind).toBe("stock");
    expect(payload.lastPrice).toBe(152.34);
    expect(payload.prevClose).toBe(150);
    expect(Array.isArray(payload.points)).toBe(true);
    expect(payload.points.length).toBeGreaterThan(0);
    expect(typeof payload.points[0].t).toBe("number");
    expect(typeof payload.points[0].v).toBe("number");
    expect(payload.iframeSrc).toBeUndefined();
    expect(payload.logoUrl).toContain("clearbit.com");
  });

  test("includes an _assistant_note reminding the LLM not to retry", async () => {
    _setFetchersForTests({
      stock: async () => fakeStock("AAPL", "Apple Inc."),
    });
    const out = await tools.get_stock_chart!({ ticker: "AAPL" });
    const payload = JSON.parse(expectText(out));
    expect(typeof payload._assistant_note).toBe("string");
    expect(payload._assistant_note).toMatch(/do NOT call this tool again/);
  });

  test("network error from fetcher → toolError", async () => {
    _setFetchersForTests({
      stock: async () => {
        throw new Error("Yahoo Finance returned HTTP 500 for AAPL");
      },
    });
    const out = await tools.get_stock_chart!({ ticker: "AAPL" });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toMatch(/Failed to fetch AAPL/);
  });
});

describe("get_crypto_chart happy path", () => {
  test("returns JSON payload with symbol/name/points for crypto", async () => {
    _setFetchersForTests({
      crypto: async () => fakeCrypto("BTC", "Bitcoin"),
    });

    const out = await tools.get_crypto_chart!({ symbol: "BTC" });
    expect(expectIsError(out)).toBe(false);
    const payload = JSON.parse(expectText(out));
    expect(payload.symbol).toBe("BTC");
    expect(payload.name).toBe("Bitcoin");
    expect(payload.kind).toBe("crypto");
    expect(payload.lastPrice).toBe(31000);
    expect(payload.points.length).toBe(365);
    expect(payload.iframeSrc).toBeUndefined();
  });

  test("CoinGecko id is also accepted", async () => {
    _setFetchersForTests({ crypto: async () => fakeCrypto("ETH", "Ethereum") });
    const out = await tools.get_crypto_chart!({ symbol: "ethereum" });
    expect(expectIsError(out)).toBe(false);
    const payload = JSON.parse(expectText(out));
    expect(payload.name).toBe("Ethereum");
  });

  test("network error from the crypto fetcher → toolError", async () => {
    _setFetchersForTests({
      crypto: async () => {
        throw new Error("CoinGecko returned HTTP 429 for bitcoin");
      },
    });
    const out = await tools.get_crypto_chart!({ symbol: "BTC" });
    expect(expectIsError(out)).toBe(true);
    expect(expectText(out)).toMatch(/Failed to fetch BTC/);
  });
});

describe("production boot wiring", () => {
  test("start() wires the dispatcher + boots the channel without throwing", () => {
    // start() is idempotent (channel `started` guard) and non-blocking
    // (runLoop is fire-and-forget), so calling it here is safe and covers
    // the in-file boot path that `bun run index.ts` exercises in prod.
    expect(() => start()).not.toThrow();
  });
});
