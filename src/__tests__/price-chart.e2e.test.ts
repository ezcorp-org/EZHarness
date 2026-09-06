/**
 * End-to-end test for the `price-chart` bundled extension.
 *
 * After the iframe→inline-SVG refactor, the extension no longer writes
 * HTML to disk. Tool result is a JSON payload (symbol/name/points/etc.)
 * that the host's PriceChartCard renders client-side.
 *
 * Layers exercised:
 *   1. Direct subprocess via `ExtensionProcess.callTool` — validates the
 *      sandbox env wiring + fetch wrapper for the price-chart subprocess.
 *   2. Through `ToolExecutor.executeToolCall` with a stub PDP — proves
 *      the registry/executor wiring.
 *   3. Through `extensionToAgentTool.execute` with the REAL DB-backed
 *      PermissionEngine — proves the chat-flow path. Gated on
 *      `EZCORP_E2E_REAL_PDP=1` since it needs a writable Postgres.
 *
 * Run: bun test src/__tests__/price-chart.e2e.test.ts
 * Live network: EZCORP_E2E_NETWORK=1 bun test ...
 * Real PDP:     EZCORP_E2E_NETWORK=1 EZCORP_E2E_REAL_PDP=1 bun test ...
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExtensionProcess } from "../extensions/subprocess";
import { ExtensionRegistry } from "../extensions/registry";
import { extensionToAgentTool, ToolExecutor } from "../extensions/tool-executor";
import { configureReleaseRuntime } from "../extensions/release-process";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import { buildFirstPartyRelease } from "./helpers/first-party-release";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { messages } from "../db/schema";

mockDbConnection();

const ROOT = join(import.meta.dir, "..", "..");
const EXT_ENTRY = join(ROOT, "docs", "extensions", "examples", "price-chart", "index.ts");
const NETWORK_HOSTS = ["query1.finance.yahoo.com", "api.coingecko.com"];

function buildEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    EZCORP_PROJECT_ROOT: ROOT,
    EZCORP_NETWORK_ALLOWED: "1",
    EZCORP_PERMITTED_HOSTS: NETWORK_HOSTS.join(","),
    EZCORP_TOOL_NETWORK_CAPS: JSON.stringify({
      get_stock_chart: NETWORK_HOSTS,
      get_crypto_chart: NETWORK_HOSTS,
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
  const proc = new ExtensionProcess(
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

const NETWORK = process.env.EZCORP_E2E_NETWORK === "1";
const describeNetwork = NETWORK ? describe : describe.skip;

let release: Awaited<ReturnType<typeof buildFirstPartyRelease>>;

beforeAll(async () => {
  if (NETWORK) release = await buildFirstPartyRelease("price-chart");
}, 120_000);

afterAll(async () => {
  ExtensionRegistry.getInstance().killAll();
  if (release) await release.close();
  await closeTestDb();
});

async function openInstalledSession() {
  await setupTestDb();
  return release.session({
    networkHosts: NETWORK_HOSTS,
    fetchImpl: fetch,
    resolveHost: async (hostname) => {
      const records = await Bun.dns.lookup(hostname, { family: 0 });
      return records.map((record) => record.address);
    },
    persistRelease: true,
  });
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

describeNetwork("price-chart e2e — live subprocess + network", () => {
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
      } finally { await session.close(); }
    },
    25_000,
  );
});

describeNetwork("price-chart e2e — through ToolExecutor (stub PDP)", () => {
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
// real DB-backed PermissionEngine). Requires `DATABASE_URL` pointing
// at a writable PG.
const REAL_PDP = process.env.EZCORP_E2E_REAL_PDP === "1" && NETWORK;
const describeRealPdp = REAL_PDP ? describe : describe.skip;

describeRealPdp("price-chart e2e — chat-flow path (real PDP)", () => {
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

        const t0 = Date.now();
        const result = await agentTool.execute(
          "tc-test-001",
          { ticker: "AAPL" },
          new AbortController().signal,
        );
        const elapsed = Date.now() - t0;
        // The chat flow used to hang 90s on a `fs.write` sensitive-cap
        // prompt. Post-refactor the extension has no filesystem grant
        // → PDP returns `allow` directly → no prompt → completes fast.
        expect(elapsed).toBeLessThan(10_000);

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
