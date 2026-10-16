/**
 * End-to-end test for the `price-chart` bundled extension.
 *
 * After the iframe→inline-SVG refactor, the extension no longer writes
 * HTML to disk. Tool result is a JSON payload (symbol/name/points/etc.)
 * that the host's PriceChartCard renders client-side.
 *
 * Layers exercised:
 *   1. Validation errors use the legacy direct subprocess because they do
 *      not request a capability.
 *   2. Network paths use a built v4 release and the host network broker;
 *      the broker's fetch goes to a loopback stub of the two market APIs
 *      (helpers/price-chart-market-stub.ts), so no test reaches the internet.
 *   3. ToolExecutor runs the same release with a stub PDP.
 *   4. `extensionToAgentTool.execute` runs it with the real DB-backed
 *      PermissionEngine and proves the chat-flow path.
 *
 * Run: bun test src/__tests__/price-chart.e2e.test.ts (needs rootless Podman
 * for the isolated release build, like every first-party release suite).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HostExtensionProcess } from "./helpers/host-extension-process";
import { ExtensionRegistry } from "../extensions/registry";
import { extensionToAgentTool, ToolExecutor } from "../extensions/tool-executor";
import { configureReleaseRuntime } from "../extensions/release-process";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import { buildFirstPartyRelease } from "./helpers/first-party-release";
import { PRICE_CHART_HOSTS, routeHostMarketTraffic, startMarketStub } from "./helpers/price-chart-market-stub";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { messages } from "../db/schema";

mockDbConnection();

const ROOT = join(import.meta.dir, "..", "..");
const EXT_ENTRY = join(ROOT, "docs", "extensions", "examples", "price-chart", "index.ts");

function buildEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    EZCORP_PROJECT_ROOT: ROOT,
    EZCORP_NETWORK_ALLOWED: "1",
    EZCORP_PERMITTED_HOSTS: PRICE_CHART_HOSTS.join(","),
    EZCORP_TOOL_NETWORK_CAPS: JSON.stringify({
      get_stock_chart: PRICE_CHART_HOSTS,
      get_crypto_chart: PRICE_CHART_HOSTS,
    }),
  };
}

interface Payload {
  kind?: string;
  symbol?: string;
  name?: string;
  logoUrl?: string;
  currency?: string;
  lastPrice?: number;
  prevClose?: number;
  points?: Array<{ t: number; v: number }>;
  iframeSrc?: unknown;
  _assistant_note?: string;
}

function parsePayload(textResult: { content?: Array<{ text?: string }> }): Payload {
  const text = textResult.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("no text in result");
  return JSON.parse(text) as Payload;
}

// ── Subprocess-only path ───────────────────────────────────────────

async function runRawToolCall(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown; error: unknown }> {
  const proc = new HostExtensionProcess(
    "price-chart-test",
    EXT_ENTRY,
    buildEnv(),
    { idleTimeoutMs: 60_000, callTimeoutMs: 25_000 },
  );
  try {
    const response = await proc.call("tools/call", { name: toolName, arguments: args });
    return { result: response.result, error: response.error };
  } finally {
    proc.kill();
  }
}

describe("price-chart e2e — non-network paths", () => {
  test("rejects empty ticker with toolError", async () => {
    const { result } = await runRawToolCall("get_stock_chart", { ticker: "" });
    const r = result as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toMatch(/ticker/i);
  });

  test("rejects whitespace ticker", async () => {
    const { result } = await runRawToolCall("get_stock_chart", { ticker: "   " });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  test("unknown tool name returns JSON-RPC error", async () => {
    const { result, error } = await runRawToolCall("not_a_real_tool", {});
    expect(result).toBeUndefined();
    expect(error).toBeDefined();
    expect((error as { message?: string }).message).toMatch(/not_a_real_tool|unknown/i);
  });
});

let release: Awaited<ReturnType<typeof buildFirstPartyRelease>>;
const market = startMarketStub();
// The ToolExecutor cases use the host's own broker path (real DNS, global fetch): route it to the stub too.
const restoreHostNetwork = routeHostMarketTraffic(market);

beforeAll(async () => {
  release = await buildFirstPartyRelease("price-chart");
}, 120_000);

afterAll(async () => {
  ExtensionRegistry.getInstance().killAll();
  await release.close();
  restoreHostNetwork();
  market.stop();
  await closeTestDb();
});

async function openInstalledSession() {
  await setupTestDb();
  return release.session({ networkHosts: PRICE_CHART_HOSTS, fetchImpl: market.fetchImpl, persistRelease: true });
}

function registerSessionTool(
  session: Awaited<ReturnType<typeof openInstalledSession>>,
  originalName: "get_stock_chart" | "get_crypto_chart",
) {
  const tool = release.manifest.tools?.find((candidate) => candidate.name === originalName);
  if (!tool) throw new Error(`Missing ${originalName} in built Price Chart manifest`);
  const name = `price-chart__${originalName}`;
  session.registry.registerToolForTest(name, {
    ...tool,
    name,
    originalName,
    extensionId: session.id,
    extensionName: release.manifest.name,
  });
  configureReleaseRuntime(session.runtime);
  return { name, tool };
}

async function seedMessage(conversationId: string) {
  const id = crypto.randomUUID();
  await getTestDb().insert(messages).values({ id, conversationId, role: "user", content: "Show price" });
  return id;
}

describe("price-chart e2e — installed v4 release + network broker (loopback market stub)", () => {
  test(
    "get_stock_chart(AAPL) returns JSON with points + no iframeSrc",
    async () => {
      const session = await openInstalledSession();
      try {
      const payload = parsePayload(await session.tool("get_stock_chart", { ticker: "AAPL" }));
      expect(payload.iframeSrc).toBeUndefined();
      expect(payload.symbol).toBe("AAPL");
      expect(payload.kind).toBe("stock");
      expect(payload.currency).toBe("USD");
      expect(typeof payload.lastPrice).toBe("number");
      expect(typeof payload.prevClose).toBe("number");
      expect(Array.isArray(payload.points)).toBe(true);
      expect(payload.points!.length).toBeGreaterThan(100);
      expect(typeof payload.points![0]!.t).toBe("number");
      expect(typeof payload.points![0]!.v).toBe("number");
      expect(payload._assistant_note).toMatch(/do NOT call this tool again/);
      // The extension asked for the production Yahoo URL; the broker carried it.
      expect(market.requests.at(-1)).toStartWith("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?");
      } finally { await session.close(); }
    },
    25_000,
  );

  test(
    "get_crypto_chart(BTC) returns JSON with points + Bitcoin name",
    async () => {
      const session = await openInstalledSession();
      try {
      const payload = parsePayload(await session.tool("get_crypto_chart", { symbol: "BTC" }));
      expect(payload.iframeSrc).toBeUndefined();
      expect(payload.kind).toBe("crypto");
      expect(payload.name).toBe("Bitcoin");
      expect(Array.isArray(payload.points)).toBe(true);
      expect(payload.points!.length).toBeGreaterThan(100);
      expect(typeof payload.logoUrl).toBe("string");
      expect(payload.logoUrl!.length).toBeGreaterThan(0);
      expect(market.requests.slice(-2)).toEqual([
        "https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false",
        "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365&interval=daily",
      ]);
      } finally { await session.close(); }
    },
    25_000,
  );

  test(
    "an upstream HTTP error comes back as a tool error that names the status",
    async () => {
      const session = await openInstalledSession();
      try {
        const result = await session.tool("get_crypto_chart", { symbol: "ETH" });
        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain("HTTP 404");
      } finally { await session.close(); }
    },
    25_000,
  );
});

describe("price-chart e2e — through ToolExecutor (stub PDP)", () => {
  test(
    "ToolExecutor.executeToolCall returns JSON payload",
    async () => {
      const session = await openInstalledSession();
      try {
      const { name } = registerSessionTool(session, "get_stock_chart");
      const executor = new ToolExecutor(session.registry, createStubPermissionEngine());
      executor.setCurrentUserId(session.userId);
      const messageId = await seedMessage(session.conversationId);

      const result = await executor.executeToolCall(
        name,
        { ticker: "AAPL" },
        session.conversationId,
        messageId,
      );

      expect(result.isError).toBe(false);
      expect(market.requests.at(-1)).toStartWith("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?");
      const payload = parsePayload(result);
      expect(payload.symbol).toBe("AAPL");
      expect(payload.kind).toBe("stock");
      expect(Array.isArray(payload.points)).toBe(true);
      expect(payload.iframeSrc).toBeUndefined();
      } finally { await session.close(); session.registry.killAll(); }
    },
    30_000,
  );
});

// Drives the same path the chat flow uses (extensionToAgentTool +
// real DB-backed PermissionEngine). The test owns a migrated PGlite DB.
describe("price-chart e2e — chat-flow path (real PDP)", () => {
  test(
    "extensionToAgentTool.execute returns JSON payload (no sensitive-cap prompt)",
    async () => {
      const { createPermissionEngine } = await import("../extensions/permission-engine");
      const { EventBus } = await import("../runtime/events");
      type AgentEventsType = import("../types").AgentEvents;

      const session = await openInstalledSession();
      try {
        const { name, tool } = registerSessionTool(session, "get_stock_chart");

        const bus = new EventBus<AgentEventsType>();
        const engine = createPermissionEngine({ registry: session.registry, bus, db: {} });
        const decisions: string[] = [];
        const authorize = engine.authorize.bind(engine);
        engine.authorize = async (...args: Parameters<typeof authorize>) => {
          const decision = await authorize(...args);
          decisions.push(decision.decision);
          return decision;
        };
        const executor = new ToolExecutor(session.registry, engine, { bus });
        executor.setCurrentUserId(session.userId);
        const messageId = await seedMessage(session.conversationId);

        const agentTool = extensionToAgentTool(
          {
            name,
            description: "fetch stock chart",
            inputSchema: tool.inputSchema,
          },
          executor,
          session.conversationId,
          messageId,
        );

        const result = await agentTool.execute(
          "tc-test-001",
          { ticker: "AAPL" },
          new AbortController().signal,
        );
        // The chat flow used to hang 90s on a `fs.write` sensitive-cap
        // prompt. Post-refactor the extension has no filesystem grant, so
        // the PDP answers `allow` and never `prompt`.
        expect(decisions.length).toBeGreaterThan(0);
        expect(decisions.every((decision) => decision === "allow")).toBe(true);
        expect(market.requests.at(-1)).toStartWith("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?");

        const payload = parsePayload(result as { content?: Array<{ text?: string }> });
        expect(payload.iframeSrc).toBeUndefined();
        expect(payload.symbol).toBe("AAPL");
        expect(Array.isArray(payload.points)).toBe(true);
      } finally {
        await session.close();
        session.registry.killAll();
      }
    },
    35_000,
  );
});
