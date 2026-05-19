// Data fetchers for stocks (Yahoo Finance) and crypto (CoinGecko).
//
// Both endpoints are free and unauthenticated for the rates a personal
// chat extension produces. The sandbox-preload wraps `globalThis.fetch`
// with the host's per-host network allowlist (declared in ezcorp.config.ts),
// so a direct `fetch()` here is gated identically to `fetchPermitted`.
//
// Network failures surface as thrown errors so the index.ts handler
// can wrap them in `toolError` — keeps the fetcher API simple.

import type { ChartData, ChartPoint } from "./types";
import { clearbitLogoUrl, lookupStockDomain, resolveCryptoId } from "./tickers";

/** Tests inject a fake via `_setFetchForTests` so they can return
 *  canned JSON without opening the network. Production uses the
 *  sandbox-wrapped global. */
type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchFn = (input, init) => fetch(input, init);
export function _setFetchForTests(fake: FetchFn): void {
  fetchImpl = fake;
}
export function _resetFetchForTests(): void {
  fetchImpl = (input, init) => fetch(input, init);
}

// ── Yahoo Finance ─────────────────────────────────────────────────

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string;
        longName?: string;
        shortName?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        currency?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{ close?: Array<number | null> }>;
      };
    }>;
    error?: { code?: string; description?: string } | null;
  };
}

export async function fetchStockSeries(rawTicker: string): Promise<ChartData> {
  const ticker = rawTicker.trim().toUpperCase();
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=1y&interval=1d&includePrePost=false&events=div%2Csplit`;

  const res = await fetchImpl(url, {
    redirect: "manual",
    headers: { "User-Agent": "price-chart-ext/0.1" },
  });
  if (!res.ok) {
    throw new Error(`Yahoo Finance returned HTTP ${res.status} for ${ticker}`);
  }
  const json = (await res.json()) as YahooChartResponse;
  const result = json.chart?.result?.[0];
  if (!result) {
    const err = json.chart?.error?.description ?? "no result";
    throw new Error(`Yahoo Finance: ${err}`);
  }
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const points: ChartPoint[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    const ts = timestamps[i];
    if (typeof close === "number" && Number.isFinite(close) && typeof ts === "number") {
      points.push({ t: ts * 1000, v: close });
    }
  }
  if (points.length === 0) {
    throw new Error(`Yahoo Finance returned no closes for ${ticker}`);
  }

  const meta = result.meta ?? {};
  const firstPoint = points[0]!;
  const lastPoint = points[points.length - 1]!;
  const last = meta.regularMarketPrice ?? lastPoint.v;
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? firstPoint.v;
  const domain = lookupStockDomain(ticker);

  return {
    kind: "stock",
    symbol: meta.symbol ?? ticker,
    name: meta.longName ?? meta.shortName ?? ticker,
    logoUrl: domain ? clearbitLogoUrl(domain) : "",
    currency: meta.currency ?? "USD",
    points,
    lastPrice: last,
    prevClose: prev,
  };
}

// ── CoinGecko ─────────────────────────────────────────────────────

interface CoinGeckoCoin {
  id?: string;
  symbol?: string;
  name?: string;
  image?: { thumb?: string; small?: string; large?: string };
  market_data?: {
    current_price?: Record<string, number>;
    price_change_24h_in_currency?: Record<string, number>;
  };
}

interface CoinGeckoMarketChart {
  prices?: Array<[number, number]>;
}

export async function fetchCryptoSeries(rawSymbol: string): Promise<ChartData> {
  const id = resolveCryptoId(rawSymbol);
  const safeId = encodeURIComponent(id);

  const metaRes = await fetchImpl(
    `https://api.coingecko.com/api/v3/coins/${safeId}` +
      `?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`,
    { redirect: "manual", headers: { "User-Agent": "price-chart-ext/0.1" } },
  );
  if (!metaRes.ok) {
    throw new Error(`CoinGecko returned HTTP ${metaRes.status} for ${id}`);
  }
  const meta = (await metaRes.json()) as CoinGeckoCoin;

  const seriesRes = await fetchImpl(
    `https://api.coingecko.com/api/v3/coins/${safeId}/market_chart` +
      `?vs_currency=usd&days=365&interval=daily`,
    { redirect: "manual", headers: { "User-Agent": "price-chart-ext/0.1" } },
  );
  if (!seriesRes.ok) {
    throw new Error(`CoinGecko market_chart returned HTTP ${seriesRes.status} for ${id}`);
  }
  const series = (await seriesRes.json()) as CoinGeckoMarketChart;
  const prices = series.prices ?? [];
  const points: ChartPoint[] = prices
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
    .map(([t, v]) => ({ t, v }));
  if (points.length === 0) {
    throw new Error(`CoinGecko returned no price points for ${id}`);
  }

  const lastPoint = points[points.length - 1]!;
  const last = meta.market_data?.current_price?.usd ?? lastPoint.v;
  const change24h = meta.market_data?.price_change_24h_in_currency?.usd ?? 0;
  const prev = last - change24h;
  const symbol = (meta.symbol ?? rawSymbol).toUpperCase();
  const logoUrl = meta.image?.large ?? meta.image?.small ?? meta.image?.thumb ?? "";

  return {
    kind: "crypto",
    symbol,
    name: meta.name ?? symbol,
    logoUrl,
    currency: "USD",
    points,
    lastPrice: last,
    prevClose: prev,
  };
}
