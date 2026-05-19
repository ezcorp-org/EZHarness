/**
 * Integration test for Phase 2d `ezcorp/spawn-assignment`.
 *
 * Spawns a real subprocess running
 * `docs/extensions/examples/test-spawn-assignment/`. The extension
 * wraps `spawnAssignment(...)` and surfaces any `JsonRpcError` as a
 * tool error so the test can assert the handler's exact response on
 * each enforcement rung. A second tool (`drain_updates`) returns
 * buffered `task:assignment_update` events the subprocess has
 * received via `registerEventHandler` — the Phase 2c round-trip.
 *
 * Pattern mirrors emit-task-event.integration.test.ts +
 * event-subscription.integration.test.ts:
 *   - Mock `startAssignment` at the module level so the handler's
 *     dispatch step succeeds without actually running a streamChat
 *     turn. The mock seeds the sub-conversation row so
 *     copyConversationExtensions + setConversationSpawnDepth land
 *     cleanly.
 *   - Drive the REAL `handleSpawnAssignmentRpc` when the subprocess
 *     emits an outbound `ezcorp/spawn-assignment` frame.
 *   - Wire a REAL `EventBus` + `EventSubscriptionDispatcher` to the
 *     subprocess stdin so bus-emitted `task:assignment_update` events
 *     round-trip back.
 *
 * Assertions:
 *   1. subprocess → RPC → handler → sub-conversation row created,
 *      response carries {subConversationId, agentRunId, taskId,
 *      assignmentId}.
 *   2. Parent's extension wiring inherits into the sub-conversation.
 *   3. Spawn depth persisted as `ctx.spawnDepth + 1` on the child.
 *   4. Concurrent cap (2) enforced on the third spawn (surface
 *      -32000 concurrent-exceeded via the tool error).
 *   5. `task:assignment_update` emitted on the parent conversation
 *      reaches the subprocess within 10s via the Phase 2c delivery
 *      path (this is the Phase 2d → 2c round-trip proof the plan
 *      promised — substituted for `agent:complete` since that is
 *      not a direct-carrier event).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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

// Mock startAssignment: seed the sub-conversation row (so FK-dependent
// post-dispatch writes succeed) and return a deterministic handle.
let nextRunId = 1;
mock.module("../runtime/start-assignment", () => ({
  startAssignment: async (opts: Record<string, unknown>) => {
    const runId = `run-int-${nextRunId++}`;
    const subConversationId = `sub-${runId}`;
    const assignment = opts.assignment as {
      id: string; status: string;
      agentRunId?: string;
      subConversationId?: string;
      startedAt?: string;
    };
    assignment.status = "running";
    assignment.agentRunId = runId;
    assignment.subConversationId = subConversationId;
    assignment.startedAt = new Date().toISOString();
    const { getDb } = await import("../db/connection");
    const { conversations } = await import("../db/schema");
    await getDb().insert(conversations).values({
      id: subConversationId,
      projectId: opts.projectId as string,
      parentConversationId: opts.conversationId as string,
      title: "int-sub",
    } as any).onConflictDoNothing();
    return { subConversationId, agentRunId: runId };
  },
}));

// Fixture agent config for resolveAgentConfigForUser → listAgentConfigs.
mock.module("../db/queries/agent-configs", () => ({
  listAgentConfigs: async () => [
    {
      id: "cfg-int-echo",
      name: "echo-agent",
      description: "",
      prompt: "echo",
      capabilities: ["llm"],
      references: { agents: [], extensions: [] },
      userId: "user-int",
      model: null,
      provider: null,
    },
  ],
}));

const { handleSpawnAssignmentRpc } = await import("../extensions/spawn-assignment-handler");
const { createSpawnQuota } = await import("../extensions/spawn-quota");
const eventsMod = await import("../runtime/events");
const { EventBus } = eventsMod;
const { EventSubscriptionDispatcher } = await import("../extensions/event-subscription-dispatcher");
type EventBusInstance = InstanceType<typeof EventBus<AgentEvents>>;
const { getDb } = await import("../db/connection");
const { addConversationExtensions, getConversationExtensionIds } = await import(
  "../db/queries/conversation-extensions"
);
const { getConversationSpawnDepth } = await import("../db/queries/conversations");
const {
  projects,
  conversations,
  users,
  extensions: extensionsTable,
} = await import("../db/schema");

import type { AgentEvents } from "../types";
import type { AgentExecutor } from "../runtime/executor";
import type { SpawnAssignmentContext } from "../extensions/spawn-assignment-handler";
import type { ExtensionRegistry } from "../extensions/registry";
import type { ExtensionPermissions } from "../extensions/types";

const EXT_ENTRY = join(
  import.meta.dir ?? process.cwd(),
  "..",
  "..",
  "docs",
  "extensions",
  "examples",
  "test-spawn-assignment",
  "index.ts",
);

const EXT_ID = "test-spawn-assignment";
const CONV_ID = "conv-sa-int-1";
const PROJ_ID = "proj-sa-int";
const USER_ID = "user-int";

// ── Subprocess harness (matches Phase 2b/2c integration tests) ──────

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
        let idx;
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
    try {
      while (true) { const { done } = await reader.read(); if (done) return; }
    } catch { /* */ }
  })();

  function inbound(msg: Record<string, unknown>): void {
    (proc.stdin as { write(s: string): number }).write(JSON.stringify(msg) + "\n");
  }

  async function wait(
    pred: (m: Record<string, unknown>) => boolean,
    ms = 5000,
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

// Stub registry exposing just the two methods the dispatcher reads:
//  - getProcessIfRunning → wraps stdin so sendNotification becomes an
//    inbound frame for the subprocess
//  - getManifest / getGrantedPermissions → unused by the dispatcher but
//    part of the ExtensionRegistry shape
function makeStubRegistry(proc: TestProc): ExtensionRegistry {
  const wrappedProc = {
    isRunning: true,
    sendNotification(method: string, params?: Record<string, unknown>): void {
      proc.inbound({
        jsonrpc: "2.0",
        method,
        ...(params !== undefined ? { params } : {}),
      });
    },
  };
  return {
    getProcessIfRunning: (extId: string) => (extId === EXT_ID ? wrappedProc : null),
    getManifest: () => undefined,
    getGrantedPermissions: () => null,
  } as unknown as ExtensionRegistry;
}

// ── Setup / teardown ────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values({
    id: USER_ID, email: "int@t.local", passwordHash: "x", name: "Int",
  } as any).onConflictDoNothing();
  await getDb().insert(projects).values({
    id: PROJ_ID, name: PROJ_ID, path: "/tmp/" + PROJ_ID,
  } as any);
  await getDb().insert(conversations).values({
    id: CONV_ID, projectId: PROJ_ID, title: "sa-int",
  } as any);
  await getDb().insert(extensionsTable).values({
    id: EXT_ID,
    name: EXT_ID,
    version: "1.0.0",
    description: "integration",
    manifest: {
      schemaVersion: 2,
      name: EXT_ID,
      version: "1.0.0",
      description: "integration",
      author: { name: "test" },
      permissions: {
        spawnAgents: { maxPerHour: 5, maxConcurrent: 2 },
        eventSubscriptions: ["task:assignment_update"],
      },
    },
    source: `test:${EXT_ID}`,
    installPath: `/tmp/${EXT_ID}`,
    enabled: true,
  } as any);
  await addConversationExtensions(CONV_ID, [{ extensionId: EXT_ID }]);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

let proc: TestProc | null = null;
beforeEach(() => { proc = spawnExtension(); });
afterEach(() => { if (proc) proc.kill(); proc = null; });

// ── Driver helpers ──────────────────────────────────────────────────

const GRANTED: ExtensionPermissions = {
  spawnAgents: { maxPerHour: 5, maxConcurrent: 2 },
  grantedAt: { spawnAgents: Date.now() },
};

function makeCtx(
  bus: EventBusInstance,
  quota: ReturnType<typeof createSpawnQuota>,
): SpawnAssignmentContext {
  return {
    conversationId: CONV_ID,
    userId: USER_ID,
    projectId: PROJ_ID,
    grantedPermissions: GRANTED,
    executor: {} as unknown as AgentExecutor,
    bus,
    quota,
    spawnDepth: 0,
  };
}

/**
 * Run a subprocess tool call that internally issues an
 * `ezcorp/spawn-assignment` RPC. We intercept the outbound RPC, route
 * it through the real handler against the shared bus+quota, then feed
 * the response back. Returns the parsed tool result.
 *
 * Note: `outbound` is a running log — we remember its length at start
 * and only look at entries added AFTER this call. Otherwise a find()
 * would match the previous spawn's RPC and we'd reply to the wrong id.
 */
async function driveSpawn(
  toolCallId: number,
  args: Record<string, unknown>,
  bus: EventBusInstance,
  quota: ReturnType<typeof createSpawnQuota>,
): Promise<{ isError: boolean; payload: unknown }> {
  const cursor = proc!.outbound.length;
  proc!.inbound({
    jsonrpc: "2.0",
    id: toolCallId,
    method: "tools/call",
    params: { name: "spawn_one", arguments: args },
  });
  const rpc = await waitAfter(
    cursor,
    (m) => m.method === "ezcorp/spawn-assignment",
  );
  const resp = await handleSpawnAssignmentRpc(
    EXT_ID,
    rpc as any,
    makeCtx(bus, quota),
  );
  proc!.inbound({
    jsonrpc: "2.0",
    id: rpc.id,
    ...(resp.result !== undefined ? { result: resp.result } : {}),
    ...(resp.error !== undefined ? { error: resp.error } : {}),
  });
  const toolResp = await waitAfter(
    cursor,
    (m) => m.id === toolCallId && (m.result !== undefined || m.error !== undefined),
  );
  const result = toolResp.result as { content: Array<{ text: string }>; isError?: boolean };
  const text = result.content?.[0]?.text ?? "";
  // The tool's happy path returns JSON-stringified handle; the error
  // path returns a bare message string. Try JSON first and fall back to
  // raw text — same shape the test expects via the `payload` field.
  let payload: unknown = text;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  return {
    isError: Boolean(result.isError),
    payload,
  };
}

/**
 * Variant of `proc.wait` that starts scanning at `afterIndex` so we
 * don't match messages emitted by a previous step.
 */
async function waitAfter(
  afterIndex: number,
  pred: (m: Record<string, unknown>) => boolean,
  ms = 5000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (let i = afterIndex; i < proc!.outbound.length; i++) {
      const m = proc!.outbound[i]!;
      if (pred(m)) return m;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitAfter(${afterIndex}): predicate never satisfied within ${ms}ms`);
}

let drainIdCounter = 500;
async function drainUpdates(): Promise<unknown[]> {
  const toolCallId = ++drainIdCounter;
  const cursor = proc!.outbound.length;
  proc!.inbound({
    jsonrpc: "2.0",
    id: toolCallId,
    method: "tools/call",
    params: { name: "drain_updates", arguments: {} },
  });
  const toolResp = await waitAfter(
    cursor,
    (m) => m.id === toolCallId && m.result !== undefined,
  );
  const result = toolResp.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as unknown[];
}

// ── Tests ───────────────────────────────────────────────────────────

describe("spawn-assignment integration: real subprocess + real handler + bus", () => {
  test("happy path: handle returned; wiring inherits; spawn depth persisted; concurrent cap enforced", async () => {
    const bus = new EventBus<AgentEvents>();
    const quota = createSpawnQuota(bus);

    // 1. First spawn — succeeds.
    const first = await driveSpawn(
      100,
      { agentConfigId: "cfg-int-echo", task: "say hi #1" },
      bus, quota,
    );
    expect(first.isError).toBe(false);
    const firstHandle = first.payload as {
      subConversationId: string;
      agentRunId: string;
      taskId: string;
      assignmentId: string;
    };
    expect(firstHandle.subConversationId).toMatch(/^sub-run-int-/);
    expect(firstHandle.agentRunId).toMatch(/^run-int-/);

    // 2. Parent's extension wiring inherits on the child.
    const childWiring = await getConversationExtensionIds(firstHandle.subConversationId);
    expect(childWiring).toContain(EXT_ID);

    // 3. Spawn depth persisted as +1 on the child conversation.
    expect(await getConversationSpawnDepth(firstHandle.subConversationId)).toBe(1);

    // 4. Second spawn — also succeeds (concurrent: 2 cap).
    const second = await driveSpawn(
      101,
      { agentConfigId: "cfg-int-echo", task: "say hi #2" },
      bus, quota,
    );
    expect(second.isError).toBe(false);

    // 5. Third spawn — concurrent cap reached. The SDK channel now
    //    preserves the host's JSON-RPC error as JsonRpcError, and the
    //    test extension serializes `{code, message, data}` into the
    //    tool error. Assert on the structured shape so callers
    //    branching on `data.reason` (hourly-exceeded vs
    //    concurrent-exceeded) are exercised.
    const third = await driveSpawn(
      102,
      { agentConfigId: "cfg-int-echo", task: "say hi #3" },
      bus, quota,
    );
    expect(third.isError).toBe(true);
    const thirdErr = third.payload as {
      code: number;
      message: string;
      data: { reason?: string };
    };
    expect(thirdErr.code).toBe(-32000);
    expect(thirdErr.data.reason).toBe("concurrent-exceeded");

    quota.dispose();
  }, 15_000);

  test("Phase 2c round-trip: task:assignment_update reaches subprocess within 10s", async () => {
    const bus = new EventBus<AgentEvents>();
    const quota = createSpawnQuota(bus);

    // Wire the real dispatcher. The subprocess subscribes to
    // task:assignment_update at module load; the dispatcher must see
    // the same event name in its registration.
    const registry = makeStubRegistry(proc!);
    const wiringMap: Record<string, string[]> = {
      [CONV_ID]: [EXT_ID],
    };
    const dispatcher = new EventSubscriptionDispatcher(
      bus, registry,
      async (convId) => wiringMap[convId] ?? [],
    );
    dispatcher.registerExtension(EXT_ID, ["task:assignment_update"]);
    dispatcher.start();

    // Let the subprocess finish booting + register its handler.
    await new Promise((r) => setTimeout(r, 200));

    // Fire a synthetic update on the parent conversation.
    const start = Date.now();
    bus.emit("task:assignment_update", {
      conversationId: CONV_ID,
      taskId: "t-int-1",
      assignment: {
        id: "a-int-1",
        agentConfigId: "cfg-int-echo",
        agentName: "echo-agent",
        isTeam: false,
        status: "completed",
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        agentRunId: "run-int-sim",
      },
    } as AgentEvents["task:assignment_update"]);

    // Poll up to 10s for the subprocess to record the event.
    let received: unknown[] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      received = await drainUpdates();
      if (received.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const elapsed = Date.now() - start;

    expect(received).toHaveLength(1);
    expect((received[0] as { conversationId: string }).conversationId).toBe(CONV_ID);
    expect(elapsed).toBeLessThan(10_000);

    dispatcher.stop();
    quota.dispose();
  }, 15_000);
});
