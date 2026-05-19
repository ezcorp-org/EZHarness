#!/usr/bin/env bun
// price-chart — bundled example extension demonstrating a fully
// client-rendered custom card. No filesystem permission, no on-disk
// HTML, no iframe: the LLM-callable tools fetch a price series and
// return it as a JSON payload; the host's PriceChartCard.svelte renders
// an inline SVG line chart directly in the chat bubble.
//
// Architecture:
//   1. LLM emits a tool_use for `get_stock_chart` or `get_crypto_chart`.
//      The manifest declares `cardType: "price-chart"` on both tools.
//   2. This handler validates inputs, fetches data via the SDK's
//      sandbox-gated `fetch()`, and returns a JSON payload with symbol,
//      name, logo URL, last price, prev close, currency, and a 1Y daily
//      `points` array.
//   3. The host routes `cardType: "price-chart"` to PriceChartCard.svelte,
//      which renders the chart inline. Range buttons (1W/1M/3M/1Y) are
//      pure client-side state in the card component.
//
// Permission contract (see ezcorp.config.ts):
//   - network: yahoo finance, coingecko, clearbit, coingecko CDNs.
//     No filesystem grant — the chart is never written to disk, so the
//     `fs.write` sensitive-capability prompt never fires.

import {
  createToolDispatcher,
  getChannel,
  toolError,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import { fetchStockSeries, fetchCryptoSeries } from "./lib/fetchers";
import type { ChartData } from "./lib/types";

// ── Capability bindings (swappable for tests) ──────────────────────
//
// The two side-effecting steps — fetch stock and fetch crypto — are
// indirected through these seams so unit tests can drive the full
// pipeline (input validation → response shape) without opening the
// network.

type StockFetcher = (ticker: string) => Promise<ChartData>;
type CryptoFetcher = (symbol: string) => Promise<ChartData>;

let fetchStockImpl: StockFetcher = fetchStockSeries;
let fetchCryptoImpl: CryptoFetcher = fetchCryptoSeries;

export function _setFetchersForTests(opts: {
  stock?: StockFetcher;
  crypto?: CryptoFetcher;
}): void {
  if (opts.stock) fetchStockImpl = opts.stock;
  if (opts.crypto) fetchCryptoImpl = opts.crypto;
}
export function _resetBindingsForTests(): void {
  fetchStockImpl = fetchStockSeries;
  fetchCryptoImpl = fetchCryptoSeries;
}

// ── Result payload ─────────────────────────────────────────────────

function buildResultPayload(data: ChartData): string {
  const change = data.lastPrice - data.prevClose;
  const changePct = data.prevClose === 0 ? 0 : (change / data.prevClose) * 100;
  const sign = changePct >= 0 ? "+" : "";
  // Lead with `_assistant_note` so the LLM understands the chart is
  // rendered inline and it should respond briefly, not loop on the tool.
  return JSON.stringify({
    _assistant_note:
      `Chart for ${data.symbol} (${data.name}) rendered inline ` +
      `(${data.currency} ${data.lastPrice.toFixed(2)}, ${sign}${changePct.toFixed(2)}%). ` +
      `Respond with ONE short sentence summarizing the move; do NOT call this tool again.`,
    kind: data.kind,
    symbol: data.symbol,
    name: data.name,
    logoUrl: data.logoUrl,
    currency: data.currency,
    lastPrice: data.lastPrice,
    prevClose: data.prevClose,
    points: data.points,
  });
}

// ── get_stock_chart ────────────────────────────────────────────────

const getStockChart: ToolHandler = async (args) => {
  const { ticker } = args as { ticker?: unknown };
  if (typeof ticker !== "string" || ticker.trim().length === 0) {
    return toolError("'ticker' is required and must be a non-empty string");
  }
  try {
    const data = await fetchStockImpl(ticker);
    return toolResult(buildResultPayload(data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolError(`Failed to fetch ${ticker}: ${msg}`);
  }
};

// ── get_crypto_chart ───────────────────────────────────────────────

const getCryptoChart: ToolHandler = async (args) => {
  const { symbol } = args as { symbol?: unknown };
  if (typeof symbol !== "string" || symbol.trim().length === 0) {
    return toolError("'symbol' is required and must be a non-empty string");
  }
  try {
    const data = await fetchCryptoImpl(symbol);
    return toolResult(buildResultPayload(data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolError(`Failed to fetch ${symbol}: ${msg}`);
  }
};

export const tools: Record<string, ToolHandler> = {
  get_stock_chart: getStockChart,
  get_crypto_chart: getCryptoChart,
};

/** Wire the dispatcher + start the channel. */
export function start(): void {
  const ch = getChannel();
  createToolDispatcher(tools);
  ch.start();
}

if (import.meta.main) start();
