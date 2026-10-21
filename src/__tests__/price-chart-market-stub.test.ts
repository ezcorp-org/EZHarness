import { afterAll, describe, expect, test } from "bun:test";
import { lookup } from "node:dns/promises";
import { guardedFetch } from "../search/egress";
import { PRICE_CHART_HOSTS, routeHostMarketTraffic, startMarketStub } from "./helpers/price-chart-market-stub";

const market = startMarketStub();
const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("other host") });
afterAll(() => { market.stop(); other.stop(true); });

describe("the loopback market stub", () => {
  test("records the URL the extension asked for from the pinned request's host header, and refuses an unstubbed path", async () => {
    const pinned = await market.fetchImpl("https://1.1.1.1/v8/finance/chart/AAPL?range=1y", { headers: { host: "query1.finance.yahoo.com" } });
    const chart = (await pinned.json()) as { chart: { result: Array<{ timestamp: number[] }> } };
    expect(chart.chart.result[0]!.timestamp).toHaveLength(252);
    expect(market.requests.at(-1)).toBe("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1y");
    expect((await market.fetchImpl("https://api.coingecko.com/api/v3/coins/ethereum")).status).toBe(404);
  });

  test("routes the host's own path (default DNS, global fetch) for the market hosts only, and restores both", async () => {
    const realFetch = globalThis.fetch;
    const restore = routeHostMarketTraffic(market);
    try {
      expect(await lookup(PRICE_CHART_HOSTS[0]!, { all: true })).toEqual([{ address: "1.1.1.1", family: 4 }]);
      expect((await lookup("localhost", { all: true })).length).toBeGreaterThan(0);
      // The broker's own guarded fetch, with its default resolver and the global fetch: the ToolExecutor path.
      const coin = await guardedFetch("https://api.coingecko.com/api/v3/coins/bitcoin", {}, { mode: "read" });
      expect(((await coin.json()) as { name: string }).name).toBe("Bitcoin");
      expect(market.requests.at(-1)).toBe("https://api.coingecko.com/api/v3/coins/bitcoin");
      expect(await (await fetch(other.url)).text()).toBe("other host");
    } finally {
      restore();
    }
    expect(globalThis.fetch).toBe(realFetch);
    expect((await lookup("localhost", { all: true })).length).toBeGreaterThan(0);
  });
});
