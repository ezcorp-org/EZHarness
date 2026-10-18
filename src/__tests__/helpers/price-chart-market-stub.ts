/**
 * A loopback stand-in for the two market APIs the price-chart example calls
 * (Yahoo Finance chart, CoinGecko coin and market_chart), for the suites that
 * run the extension's real network path (W4H-33, ruling 3).
 *
 * The extension keeps its production URLs. Its fetch goes through the host's
 * network broker, which calls the session's `fetchImpl`; this stub's
 * `fetchImpl` records the URL the extension asked for and forwards the request
 * to a Bun.serve listener on 127.0.0.1 that answers with canned JSON. An
 * extension-side loopback URL would be refused by the broker's address guard
 * and by the manifest's host allowlist, so the broker is the seam.
 *
 * The broker pins the address it resolved: `fetchImpl` receives the URL with
 * that IP and the original host in the `host` header, so a recorded request
 * is rebuilt with that host (the URL the extension asked for).
 *
 * The ToolExecutor path calls the broker with no options, i.e. with the
 * host's real DNS and global fetch. `routeHostMarketTraffic` sends exactly the
 * two market hosts of THAT path to the stub too (a public placeholder address
 * from DNS, the stub from fetch), so no case reaches the internet; every other
 * host passes through untouched, and the returned function restores both.
 */
import { mock } from "bun:test";
import * as dnsPromises from "node:dns/promises";

/** Captured before any routing, so the stub's own forwarding never loops back into it. */
const REAL_FETCH = globalThis.fetch;
const REAL_DNS = { ...dnsPromises };
/** A public address for the market hosts; the stub answers, so nothing ever connects to it. */
const PLACEHOLDER_ADDRESS = "1.1.1.1";

/** The hosts the price-chart manifest declares; the network broker's allowlist for these suites. */
export const PRICE_CHART_HOSTS = ["query1.finance.yahoo.com", "api.coingecko.com"];

const DAY_MS = 86_400_000;
const POINTS = 252;
const START_S = 1_735_689_600; // 2025-01-01T00:00:00Z

function yahooChart(symbol: string) {
  const timestamp = Array.from({ length: POINTS }, (_, index) => START_S + index * 86_400);
  const close = timestamp.map((_, index) => 180 + index / 10);
  return {
    chart: {
      result: [{
        meta: { symbol, longName: "Apple Inc.", currency: "USD", regularMarketPrice: close.at(-1), chartPreviousClose: close[0] },
        timestamp,
        indicators: { quote: [{ close }] },
      }],
      error: null,
    },
  };
}

const COIN = {
  id: "bitcoin",
  symbol: "btc",
  name: "Bitcoin",
  image: { large: "https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png" },
  market_data: { current_price: { usd: 64_000 }, price_change_24h_in_currency: { usd: 1_200 } },
};

const MARKET_CHART = { prices: Array.from({ length: POINTS }, (_, index) => [START_S * 1000 + index * DAY_MS, 40_000 + index * 90]) };

/** Starts the loopback listener. `requests` holds every URL the extension asked the broker to fetch, in order. */
export function startMarketStub(): { fetchImpl: typeof fetch; requests: string[]; stop(): void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const chart = /^\/v8\/finance\/chart\/([^/]+)$/.exec(url.pathname);
      if (chart) return Response.json(yahooChart(decodeURIComponent(chart[1]!)));
      if (url.pathname === "/api/v3/coins/bitcoin") return Response.json(COIN);
      if (url.pathname === "/api/v3/coins/bitcoin/market_chart") return Response.json(MARKET_CHART);
      return new Response("not stubbed", { status: 404 });
    },
  });
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const target = new URL(String(input));
    const host = new Headers(init?.headers).get("host");
    if (host) target.host = host;
    requests.push(target.href);
    return REAL_FETCH(new URL(`${target.pathname}${target.search}`, server.url), init);
  }) as typeof fetch;
  return { fetchImpl, requests, stop: () => server.stop(true) };
}

/** Routes the host's own network path (real DNS, global fetch) for the market hosts to `market`; returns the restore. */
export function routeHostMarketTraffic(market: { fetchImpl: typeof fetch }): () => void {
  const isMarket = (host: string | null | undefined) => host !== null && host !== undefined && PRICE_CHART_HOSTS.includes(host);
  mock.module("node:dns/promises", () => ({
    ...REAL_DNS,
    lookup: (hostname: string, options?: unknown) =>
      isMarket(hostname) ? Promise.resolve([{ address: PLACEHOLDER_ADDRESS, family: 4 }]) : (REAL_DNS.lookup as (h: string, o?: unknown) => Promise<unknown>)(hostname, options),
  }));
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) =>
    isMarket(new Headers(init?.headers).get("host") ?? new URL(String(input)).hostname)
      ? market.fetchImpl(input, init)
      : REAL_FETCH(input, init)) as typeof fetch;
  return () => {
    globalThis.fetch = REAL_FETCH;
    mock.module("node:dns/promises", () => REAL_DNS);
  };
}
