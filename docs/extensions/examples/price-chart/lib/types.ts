// Shared types for the price-chart extension.

export type AssetKind = "stock" | "crypto";

export interface ChartPoint {
  /** Epoch ms — what Chart.js's time axis wants. */
  t: number;
  /** Close price for the bar / day. */
  v: number;
}

export interface ChartData {
  kind: AssetKind;
  /** Display ticker (uppercase for stocks, original-case for crypto). */
  symbol: string;
  /** Long name (e.g. "Apple Inc." / "Bitcoin"). May equal symbol when unknown. */
  name: string;
  /** Resolved logo URL — Clearbit for stocks, CoinGecko image for crypto. */
  logoUrl: string;
  /** Quote currency. "USD" for both providers in v1. */
  currency: string;
  /** Year-to-date or 1Y daily close series, oldest first. */
  points: ChartPoint[];
  /** Most recent close (may differ from `points.at(-1).v` when intraday available). */
  lastPrice: number;
  /** Reference close used for the % change shown in the header. */
  prevClose: number;
}
