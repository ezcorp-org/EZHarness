/**
 * Integration test for the Phase 2b `ezcorp/agent-configs` reverse RPC.
 *
 * Spawns a real subprocess running the `test-agent-configs` example
 * extension. The extension calls `AgentConfigs.list()` and
 * `AgentConfigs.resolve()` over the real SDK; the host side drives the
 * REAL handler against a PGlite DB seeded with agents owned by two
 * distinct users.
 *
 * What this locks in beyond unit tests:
 *   - End-to-end wire contract matches between SDK and host.
 *   - The SDK's `.list()` unwraps `{configs: [...]}` into an array.
 *   - The SDK's `.resolve(null-returning)` surfaces `null`, not throws.
 *   - User scoping holds across the subprocess boundary.
 */

import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join } from "path";
import { mock } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mock.module("../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized — call setupTestDb() first");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

const { handleAgentConfigsRpc } = await import("../extensions/agent-configs-handler");
const { getDb } = await import("../db/connection");
const { users, agentConfigs } = await import("../db/schema");

import type { AgentConfigsContext } from "../extensions/agent-configs-handler";
import type { ExtensionPermissions } from "../extensions/types";

const EXT_ENTRY = join(
  import.meta.dir ?? process.cwd(),
  "..",
  "..",
  "docs",
  "extensions",
  "examples",
  "test-agent-configs",
  "index.ts",
);

const EXT_ID = "test-agent-configs";

// ── Subprocess harness (clone of scratchpad integration pattern) ──

interface TestProc {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  outbound: Record<string, unknown>[];
  inbound: (msg: Record<string, unknown>) => void;
  wait: (pred: (m: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown>>;
  kill: () => void;
}

function spawnExtension(): TestProc {
  const proc = spawn(["bun", "run", EXT_ENTRY], {
    cwd: "/home/dev/work/ez-corp-ai",
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env },
  }) as Subprocess<"pipe", "pipe", "pipe">;

  const outbound: Record<string, unknown>[] = [];
  let buffer = "";

  (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try { outbound.push(JSON.parse(line)); } catch { /* non-JSON */ }
        }
      }
    } catch { /* stream closed */ }
  })();

  (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    try { while (true) { const { done } = await reader.read(); if (done) return; } } catch { /* */ }
  })();

  function inbound(msg: Record<string, unknown>): void {
    (proc.stdin as { write(s: string): number }).write(JSON.stringify(msg) + "\n");
  }

  async function wait(
    pred: (m: Record<string, unknown>) => boolean,
    ms = 2000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = outbound.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("wait: predicate never satisfied within " + ms + "ms");
  }

  function kill(): void { try { proc.kill(); } catch { /* */ } }
  return { proc, outbound, inbound, wait, kill };
}

// ── Shared fixtures ───────────────────────────────────────────────

const aliceConfigId = crypto.randomUUID();

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values([
    { id: "user-alice-int", email: "ai@t.local", passwordHash: "x", name: "alice" } as any,
    { id: "user-bob-int", email: "bi@t.local", passwordHash: "x", name: "bob" } as any,
  ]);
  await getDb().insert(agentConfigs).values([
    {
      id: aliceConfigId,
      name: "alice-helper-int",
      description: "Alice's helper",
      prompt: "p",
      capabilities: ["llm"],
      references: { agents: [], extensions: [] },
      userId: "user-alice-int",
    } as any,
    {
      id: crypto.randomUUID(),
      name: "bob-private-int",
      description: "Bob's private",
      prompt: "p",
      capabilities: ["llm"],
      references: { agents: [], extensions: [] },
      userId: "user-bob-int",
    } as any,
  ]);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

let proc: TestProc | null = null;
beforeEach(() => { proc = spawnExtension(); });
afterEach(() => { if (proc) proc.kill(); proc = null; });

async function relayOneRpc(ctx: AgentConfigsContext): Promise<Record<string, unknown>> {
  // Wait for the extension to make an ezcorp/agent-configs request.
  const req = await proc!.wait((m) => m.method === "ezcorp/agent-configs");
  // Call the REAL handler.
  const resp = await handleAgentConfigsRpc(EXT_ID, req as any, ctx);
  // Send the response back to the subprocess.
  proc!.inbound({ jsonrpc: "2.0", id: req.id, ...(resp.result !== undefined ? { result: resp.result } : { error: resp.error }) });
  return req;
}

const grantedRead: ExtensionPermissions = {
  agentConfig: "read",
  grantedAt: { agentConfig: Date.now() },
};

// ── Tests ──────────────────────────────────────────────────────────

describe("agent-configs integration: real subprocess + real handler", () => {
  test("list() returns alice's own configs over the full SDK+wire+handler+DB stack", async () => {
    const TOOL_CALL_ID = 500;
    proc!.inbound({
      jsonrpc: "2.0", id: TOOL_CALL_ID, method: "tools/call",
      params: { name: "list_configs", arguments: {} },
    });
    await relayOneRpc({ userId: "user-alice-int", grantedPermissions: grantedRead });
    const toolResp = await proc!.wait((m) => m.id === TOOL_CALL_ID && m.result !== undefined);
    const result = toolResp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const configs = JSON.parse(result.content[0]!.text) as Array<{ name: string; ownerUserId: string }>;
    const names = configs.map((c) => c.name);
    expect(names).toContain("alice-helper-int");
    expect(names).not.toContain("bob-private-int");
  }, 5000);

  test("resolve() by name returns the matching summary", async () => {
    const TOOL_CALL_ID = 501;
    proc!.inbound({
      jsonrpc: "2.0", id: TOOL_CALL_ID, method: "tools/call",
      params: { name: "resolve_config", arguments: { idOrName: "alice-helper-int" } },
    });
    await relayOneRpc({ userId: "user-alice-int", grantedPermissions: grantedRead });
    const toolResp = await proc!.wait((m) => m.id === TOOL_CALL_ID && m.result !== undefined);
    const result = toolResp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const config = JSON.parse(result.content[0]!.text) as { name: string; id: string } | null;
    expect(config?.name).toBe("alice-helper-int");
    expect(config?.id).toBe(aliceConfigId);
  }, 5000);

  test("resolve() by missing name returns SDK null (not an error)", async () => {
    const TOOL_CALL_ID = 502;
    proc!.inbound({
      jsonrpc: "2.0", id: TOOL_CALL_ID, method: "tools/call",
      params: { name: "resolve_config", arguments: { idOrName: "does-not-exist" } },
    });
    await relayOneRpc({ userId: "user-alice-int", grantedPermissions: grantedRead });
    const toolResp = await proc!.wait((m) => m.id === TOOL_CALL_ID && m.result !== undefined);
    const result = toolResp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const config = JSON.parse(result.content[0]!.text) as unknown;
    expect(config).toBeNull();
  }, 5000);

  test("permission-denied host response surfaces as tool error, not hang", async () => {
    const TOOL_CALL_ID = 503;
    proc!.inbound({
      jsonrpc: "2.0", id: TOOL_CALL_ID, method: "tools/call",
      params: { name: "list_configs", arguments: {} },
    });
    // Relay with permissions REVOKED — handler returns -32001.
    await relayOneRpc({
      userId: "user-alice-int",
      grantedPermissions: { grantedAt: {} } /* no agentConfig grant */,
    });
    const toolResp = await proc!.wait((m) => m.id === TOOL_CALL_ID && m.result !== undefined);
    const result = toolResp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("agentConfig permission");
  }, 5000);
});
