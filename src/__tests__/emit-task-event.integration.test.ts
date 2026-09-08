/**
 * Integration test for the Phase 2b `ezcorp/emit-task-event` reverse RPC.
 *
 * Spawns a real subprocess running the `test-task-events` example
 * extension. The test extension calls `TaskEvents.emitSnapshot(...)`
 * internally plus forges a `conversationId` in the raw params. The host
 * side is the REAL `handleEmitTaskEventRpc` hooked to a real EventBus;
 * we assert the bus emits `task:snapshot` carrying the HOST'S
 * conversationId, NOT the forged one.
 *
 * Pattern matches scratchpad-extension.integration.test.ts — simulate
 * the host side directly rather than boot the full registry stack.
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

const { handleEmitTaskEventRpc } = await import("../extensions/task-events-handler");
const { getDb } = await import("../db/connection");
const { addConversationExtensions } = await import("../db/queries/conversation-extensions");
const { users, projects, conversations, extensions: extensionsTable } = await import("../db/schema");
const { _resetTaskTrackingExtensionIdCache } = await import("../runtime/task-tracking-host");

import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import type { TaskEventsContext } from "../extensions/task-events-handler";
import type { ExtensionPermissions } from "../extensions/types";

const EXT_ENTRY = join(
  import.meta.dir ?? process.cwd(),
  "..",
  "..",
  "docs",
  "extensions",
  "examples",
  "test-task-events",
  "index.ts",
);

const EXT_ID = "test-task-events";
const CONV_ID = "conv-tte-int-1";

// ── Mini EventBus compatible with the real type shape ────────────

interface EmitCall { event: string; payload: unknown; }

interface ResponseState { settled: boolean; }

function makeBus(responseState: ResponseState): {
  bus: EventBus<AgentEvents>;
  calls: EmitCall[];
  eventBeforeResponse: Promise<void>;
} {
  const calls: EmitCall[] = [];
  const bus = new EventBus<AgentEvents>();
  let resolveEvent!: () => void;
  let rejectEvent!: (error: Error) => void;
  const eventBeforeResponse = new Promise<void>((resolve, reject) => {
    resolveEvent = resolve;
    rejectEvent = reject;
  });
  bus.on("task:snapshot", (payload) => {
    calls.push({ event: "task:snapshot", payload });
    // This microtask runs before the persistence await can settle the RPC.
    // It fails if a handler response was released before the host event.
    queueMicrotask(() => {
      if (responseState.settled) {
        rejectEvent(new Error("task:snapshot emitted after the RPC response settled"));
      } else {
        resolveEvent();
      }
    });
  });
  return { bus, calls, eventBeforeResponse };
}

async function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
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
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try { outbound.push(JSON.parse(line)); } catch { /* skip non-JSON */ }
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

beforeAll(async () => {
  await setupTestDb();
  _resetTaskTrackingExtensionIdCache();
  await getDb().insert(users).values({ id: "user-int", email: "task-int@test.local", name: "Owner", passwordHash: "unused", role: "admin", status: "active" });
  await getDb().insert(projects).values({
    id: "proj-tte-int",
    name: "proj-tte-int",
    path: "/tmp/proj-tte-int",
  } as any);
  await getDb().insert(conversations).values({
    id: CONV_ID,
    userId: "user-int",
    projectId: "proj-tte-int",
    title: "integration",
  } as any);
  await getDb().insert(extensionsTable).values({
    id: EXT_ID,
    name: EXT_ID,
    version: "1.0.0",
    description: "integration test",
    manifest: {
      schemaVersion: 2,
      name: EXT_ID,
      version: "1.0.0",
      description: "integration test",
      author: { name: "test" },
      permissions: { taskEvents: true },
    },
    source: `test:${EXT_ID}`,
    installPath: `/tmp/${EXT_ID}`,
    enabled: true,
  } as any);
  await getDb().insert(extensionsTable).values({ id: "task-tracking-store", name: "task-tracking", version: "1.0.0", manifest: { schemaVersion: 4, name: "task-tracking", version: "1.0.0", description: "Storage fixture", author: { name: "Test" }, permissions: {} }, enabled: true, source: "release-v4", creatorUserId: "user-int" });
  await addConversationExtensions(CONV_ID, [{ extensionId: EXT_ID }]);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

let proc: TestProc | null = null;

beforeEach(() => { proc = spawnExtension(); });
afterEach(() => { if (proc) proc.kill(); proc = null; });

// ── Test ──────────────────────────────────────────────────────────

describe("emit-task-event integration: real subprocess + real handler + bus", () => {
  test("emitSnapshot round-trips — host event precedes reply and uses the HOST conversationId", async () => {
    const responseState: ResponseState = { settled: false };
    const { bus, calls, eventBeforeResponse } = makeBus(responseState);
    const grantedPermissions: ExtensionPermissions = {
      taskEvents: true,
      grantedAt: { taskEvents: Date.now() },
    };

    // Kick the extension: invoke its `emit_snapshot` tool with a forged
    // conversationId the handler must ignore.
    const TOOL_CALL_ID = 100;
    proc!.inbound({
      jsonrpc: "2.0",
      id: TOOL_CALL_ID,
      method: "tools/call",
      params: {
        name: "emit_snapshot",
        arguments: {
          taskId: "int-task-1",
          conversationId: "attacker-controlled-conv-id",
        },
      },
    });

    // Extension emits a reverse ezcorp/emit-task-event RPC.
    const emitReq = await proc!.wait((m) => m.method === "ezcorp/emit-task-event");

    // Drive the REAL host handler with this RPC request.
    const ctx: TaskEventsContext = {
      conversationId: CONV_ID,
      userId: "user-int",
      grantedPermissions,
      bus,
    };
    const response = handleEmitTaskEventRpc(
      EXT_ID,
      emitReq as any,
      ctx,
    ).then((value) => {
      responseState.settled = true;
      return value;
    });

    // The persisted host event is observable before the RPC reply settles.
    const [, resp] = await within(Promise.all([eventBeforeResponse, response]));

    // Bus must have fired with the HOST's conversationId, not the forged one.
    expect(resp.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.event).toBe("task:snapshot");
    const emitted = calls[0]?.payload as { conversationId: string; tasks: unknown[] };
    expect(emitted.conversationId).toBe(CONV_ID);
    expect(emitted.conversationId).not.toBe("attacker-controlled-conv-id");
    expect(emitted.tasks).toHaveLength(1);

    // Close the loop so the extension's tool handler returns cleanly.
    proc!.inbound({ jsonrpc: "2.0", id: emitReq.id, result: resp.result });
    const toolResp = await proc!.wait((m) => m.id === TOOL_CALL_ID && m.result !== undefined);
    expect(toolResp.error).toBeUndefined();
    const result = toolResp.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(result.content?.[0]?.text).toContain("int-task-1");
  }, 5000);
});
