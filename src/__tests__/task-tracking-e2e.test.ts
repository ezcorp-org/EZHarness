/**
 * End-to-end test for the task-tracking bundled extension (plan §8.4).
 *
 * Wires the REAL pieces together:
 *   - Subprocess running the real
 *     `docs/extensions/examples/task-tracking/index.ts`.
 *   - Real `handleStorageRpc` backed by a real PGlite.
 *   - Real `handleEmitTaskEventRpc` bridging to a real EventBus.
 *   - Real `handleAgentConfigsRpc` backed by a stub agent-configs
 *     fixture.
 *   - Real `handleSpawnAssignmentRpc` — the Phase 2d handler — with
 *     only `startAssignment` stubbed so we don't need a real executor
 *     or streamChat.
 *   - Real `EventSubscriptionDispatcher` so bus-emitted
 *     `task:assignment_update` events round-trip back to the
 *     subprocess's `registerEventHandler` subscription.
 *
 * This is the single test file that exercises the full
 *   executor → extension → spawn → run:complete → bridge → auto-advance
 * chain proof the plan called out. It absorbs the coverage that used
 * to live in the deleted executor-task-wiring.test.ts +
 * start-assignment-flow.test.ts + seam-team-orchestration-integration.
 *
 * What each test covers:
 *   1. task_plan round-trip persists to the real extension_storage row
 *      and re-reading produces the same snapshot.
 *   2. task_plan with assignTo actually triggers a spawn RPC that
 *      reaches the real handler, returns a handle, and flips the
 *      assignment to "running" with subConvId/agentRunId stamped.
 *   3. Pushing task:assignment_update with status="completed" via the
 *      real EventSubscriptionDispatcher drives the extension's
 *      subscription, which auto-advances the next task and persists
 *      the state back to storage — the two-hop bridge e2e proof.
 *   4. Sequential tool calls don't deadlock under the real handler
 *      pipeline — regression guard matching the SDK runLoop shape.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join } from "path";
import { mock } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mock.module("../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

// ── Stub startAssignment so spawn handlers return deterministically ──

let nextRunId = 1;
mock.module("../runtime/start-assignment", () => ({
  startAssignment: async (opts: Record<string, unknown>) => {
    const runId = `run-e2e-${nextRunId++}`;
    const subConvId = `sub-${runId}`;
    const assignment = opts.assignment as {
      id: string;
      status: string;
      agentRunId?: string;
      subConversationId?: string;
      startedAt?: string;
    };
    assignment.status = "running";
    assignment.agentRunId = runId;
    assignment.subConversationId = subConvId;
    assignment.startedAt = new Date().toISOString();
    const { getDb } = await import("../db/connection");
    const { conversations } = await import("../db/schema");
    await getDb().insert(conversations).values({
      id: subConvId,
      projectId: opts.projectId as string,
      parentConversationId: opts.conversationId as string,
      title: "e2e-sub",
    } as any).onConflictDoNothing();
    return { subConversationId: subConvId, agentRunId: runId };
  },
}));

// Fixture agent config used by agent-configs RPC + spawn dispatch.
mock.module("../db/queries/agent-configs", () => ({
  listAgentConfigs: async () => [
    {
      id: "cfg-builder",
      name: "builder",
      description: "Builds things",
      prompt: "p",
      capabilities: ["llm"],
      references: { agents: [], extensions: [] },
      userId: "user-e2e",
      model: null,
      provider: null,
    },
  ],
}));

const { handleStorageRpc } = await import("../extensions/storage-handler");
const { handleEmitTaskEventRpc } = await import("../extensions/task-events-handler");
const { handleAgentConfigsRpc } = await import("../extensions/agent-configs-handler");
const { handleSpawnAssignmentRpc } = await import("../extensions/spawn-assignment-handler");
const { createSpawnQuota } = await import("../extensions/spawn-quota");
const { EventBus } = await import("../runtime/events");
const { EventSubscriptionDispatcher } = await import(
  "../extensions/event-subscription-dispatcher"
);
const { getDb } = await import("../db/connection");
const {
  conversations,
  extensions: extensionsTable,
  projects,
  users,
} = await import("../db/schema");
const { addConversationExtensions } = await import("../db/queries/conversation-extensions");
const { getStorageValue } = await import("../db/queries/extension-storage");

import type { AgentEvents } from "../types";
import type { AgentExecutor } from "../runtime/executor";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";

const EXT_ENTRY = join(
  import.meta.dir ?? process.cwd(),
  "..",
  "..",
  "docs",
  "extensions",
  "examples",
  "task-tracking",
  "index.ts",
);

const EXT_ID = "ext-tt-e2e";
const CONV_ID = "conv-tt-e2e";
const PROJ_ID = "proj-tt-e2e";
const USER_ID = "user-e2e";

// ── Subprocess harness (shared pattern with other integration tests) ──

interface TestProc {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  outbound: Record<string, unknown>[];
  inbound: (msg: Record<string, unknown>) => void;
  waitAfter: (i: number, pred: (m: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown>>;
  kill: () => void;
}

function spawnExtension(): TestProc {
  const proc = spawn(["bun", "run", EXT_ENTRY], {
    cwd: "/home/dev/work/ez-corp-ai",
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
          try { outbound.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    } catch { /* */ }
  })();

  (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    try { while (true) { const { done } = await reader.read(); if (done) return; } } catch { /* */ }
  })();

  function inbound(msg: Record<string, unknown>): void {
    (proc.stdin as { write(s: string): number }).write(JSON.stringify(msg) + "\n");
  }

  async function waitAfter(
    i: number,
    pred: (m: Record<string, unknown>) => boolean,
    ms = 5000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      for (let k = i; k < outbound.length; k++) {
        const m = outbound[k]!;
        if (pred(m)) return m;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waitAfter(${i}) timed out`);
  }

  function kill(): void { try { proc.kill(); } catch { /* */ } }
  return { proc, outbound, inbound, waitAfter, kill };
}

// ── Manifest + permission fixtures matching the real extension ──────

const GRANTED: ExtensionPermissions = {
  storage: true,
  taskEvents: true,
  agentConfig: "read",
  spawnAgents: { maxPerHour: 50, maxConcurrent: 5 },
  eventSubscriptions: ["task:assignment_update"],
  grantedAt: {
    storage: Date.now(),
    taskEvents: Date.now(),
    agentConfig: Date.now(),
    spawnAgents: Date.now(),
    eventSubscriptions: Date.now(),
  },
};

const MANIFEST: ExtensionManifestV2 = {
  schemaVersion: 2,
  name: "task-tracking",
  version: "1.0.0",
  description: "e2e",
  author: { name: "test" },
  permissions: {
    storage: true,
    taskEvents: true,
    agentConfig: "read",
    spawnAgents: { maxPerHour: 50, maxConcurrent: 5 },
    eventSubscriptions: ["task:assignment_update"],
  },
};

// ── Pump: drain outbound RPCs and route each to its real handler ────

let bus: InstanceType<typeof EventBus<AgentEvents>>;
let quota: ReturnType<typeof createSpawnQuota>;
let dispatcher: InstanceType<typeof EventSubscriptionDispatcher>;

function makeStubRegistry(p: TestProc) {
  const wrapped = {
    isRunning: true,
    sendNotification(method: string, params?: Record<string, unknown>): void {
      p.inbound({
        jsonrpc: "2.0",
        method,
        ...(params !== undefined ? { params } : {}),
      });
    },
  };
  return {
    getProcessIfRunning: (id: string) => (id === EXT_ID ? wrapped : null),
    getManifest: () => MANIFEST,
    getGrantedPermissions: () => GRANTED,
  };
}

/**
 * Background pump: for every RPC request the subprocess emits,
 * dispatch to the real handler and feed the response back. Runs until
 * the subprocess exits. Exceptions inside the pump are swallowed —
 * the assertions ride on the test's waitAfter timeouts.
 */
function startHandlerPump(p: TestProc): void {
  (async () => {
    let next = 0;
    while (p.proc.exitCode === null) {
      for (; next < p.outbound.length; next++) {
        const m = p.outbound[next]!;
        if (typeof m.method !== "string" || m.id === undefined) continue;
        try {
          if (m.method === "ezcorp/storage") {
            const resp = await handleStorageRpc(EXT_ID, m as any, {
              conversationId: CONV_ID,
              userId: USER_ID,
              manifest: MANIFEST,
              grantedPermissions: GRANTED,
            });
            p.inbound(resp as unknown as Record<string, unknown>);
          } else if (m.method === "ezcorp/emit-task-event") {
            const resp = await handleEmitTaskEventRpc(EXT_ID, m as any, {
              conversationId: CONV_ID,
              userId: USER_ID,
              grantedPermissions: GRANTED,
              bus,
            });
            p.inbound(resp as unknown as Record<string, unknown>);
          } else if (m.method === "ezcorp/agent-configs") {
            const resp = await handleAgentConfigsRpc(EXT_ID, m as any, {
              userId: USER_ID,
              grantedPermissions: GRANTED,
            });
            p.inbound(resp as unknown as Record<string, unknown>);
          } else if (m.method === "ezcorp/spawn-assignment") {
            const resp = await handleSpawnAssignmentRpc(EXT_ID, m as any, {
              conversationId: CONV_ID,
              userId: USER_ID,
              projectId: PROJ_ID,
              grantedPermissions: GRANTED,
              executor: {} as unknown as AgentExecutor,
              bus,
              quota,
              spawnDepth: 0,
            });
            p.inbound(resp as unknown as Record<string, unknown>);
          }
        } catch {
          p.inbound({
            jsonrpc: "2.0",
            id: m.id as number | string,
            error: { code: -32603, message: "pump handler threw" },
          });
        }
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
}

// ── Tool-call helper ────────────────────────────────────────────────

async function callTool(
  p: TestProc,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const cursor = p.outbound.length;
  p.inbound({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: { ezConversationId: CONV_ID, ezOnBehalfOf: USER_ID },
    },
  });
  const resp = await p.waitAfter(cursor, (m) => m.id === id && (m.result !== undefined || m.error !== undefined));
  if (resp.error) {
    return { isError: true, text: JSON.stringify(resp.error) };
  }
  const r = resp.result as { content: Array<{ text: string }>; isError?: boolean };
  return {
    isError: Boolean(r.isError),
    text: r.content?.[0]?.text ?? "",
  };
}

// ── Setup / teardown ────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values({
    id: USER_ID, email: "e2e@t.local", passwordHash: "x", name: "E2E",
  } as any).onConflictDoNothing();
  await getDb().insert(projects).values({
    id: PROJ_ID, name: PROJ_ID, path: "/tmp/" + PROJ_ID,
  } as any).onConflictDoNothing();
  await getDb().insert(conversations).values({
    id: CONV_ID, projectId: PROJ_ID, title: "e2e-conv", userId: USER_ID,
  } as any).onConflictDoNothing();
  await getDb().insert(extensionsTable).values({
    id: EXT_ID,
    name: "task-tracking",
    version: "1.0.0",
    description: "e2e",
    manifest: MANIFEST,
    source: `test:${EXT_ID}`,
    installPath: `/tmp/${EXT_ID}`,
    enabled: true,
  } as any).onConflictDoNothing();
  await addConversationExtensions(CONV_ID, [{ extensionId: EXT_ID }]);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

beforeEach(async () => {
  // Each test starts from a clean extension_storage row so task_plan's
  // "keep non-pending, drop pending" logic doesn't observe leftovers
  // from a sibling test.
  const { deleteStorageValue } = await import("../db/queries/extension-storage");
  await deleteStorageValue(EXT_ID, "conversation", CONV_ID, "tasks");
});

// ── Tests ──────────────────────────────────────────────────────────

describe("task-tracking e2e: real subprocess + real host handlers + real bus", () => {
  test("task_plan round-trips: persists via real storage-handler, real task-events emits onto the bus", async () => {
    const proc = spawnExtension();
    bus = new EventBus<AgentEvents>();
    quota = createSpawnQuota(bus);
    dispatcher = new EventSubscriptionDispatcher(
      bus,
      makeStubRegistry(proc) as any,
      async () => [EXT_ID],
    );
    dispatcher.registerExtension(EXT_ID, ["task:assignment_update"]);
    dispatcher.start();
    startHandlerPump(proc);

    // Capture task:snapshot events the real task-events-handler emits.
    const snapshotEvents: Array<unknown> = [];
    bus.on("task:snapshot", (payload) => { snapshotEvents.push(payload); });

    const out = await callTool(proc, 100, "task_plan", {
      tasks: [{ title: "Build" }, { title: "Ship" }],
    });
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/Created task plan with 2 tasks/);

    // The real storage-handler must have written to PGlite.
    const row = await getStorageValue(EXT_ID, "conversation", CONV_ID, "tasks");
    expect(row).toBeDefined();
    const snap = row!.value as { tasks: Array<Record<string, unknown>>; activeTaskId?: string; schemaVersion?: number };
    expect(snap.tasks).toHaveLength(2);
    expect(snap.schemaVersion).toBe(1);
    expect(snap.activeTaskId).toBeDefined();

    // The real task-events-handler must have emitted task:snapshot on the bus.
    expect(snapshotEvents.length).toBeGreaterThanOrEqual(1);

    proc.kill();
  });

  test("task_plan with assignTo drives the REAL spawn handler → runs assignment → emits task:assignment_update", async () => {
    const proc = spawnExtension();
    bus = new EventBus<AgentEvents>();
    quota = createSpawnQuota(bus);
    dispatcher = new EventSubscriptionDispatcher(
      bus,
      makeStubRegistry(proc) as any,
      async () => [EXT_ID],
    );
    dispatcher.registerExtension(EXT_ID, ["task:assignment_update"]);
    dispatcher.start();
    startHandlerPump(proc);

    const assignmentEvents: Array<Record<string, unknown>> = [];
    bus.on("task:assignment_update", (p) => { assignmentEvents.push(p as Record<string, unknown>); });

    const out = await callTool(proc, 200, "task_plan", {
      tasks: [{ title: "Core", assignTo: "builder" }],
    });
    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/Auto-started @builder/);

    // Storage reflects the "running" state — the real spawn handler
    // returned a handle, and the extension re-persisted on success.
    const row = await getStorageValue(EXT_ID, "conversation", CONV_ID, "tasks");
    const snap = row!.value as {
      tasks: Array<{ title: string; assignments: Array<{ status: string; agentRunId?: string; subConversationId?: string }> }>;
    };
    const core = snap.tasks.find((t) => t.title === "Core")!;
    const assignment = core.assignments[0]!;
    expect(assignment.status).toBe("running");
    expect(assignment.agentRunId).toMatch(/^run-e2e-/);
    expect(assignment.subConversationId).toMatch(/^sub-/);

    // At least one task:assignment_update fired (the extension's own
    // emit after spawn success). The host's bus saw it.
    expect(assignmentEvents.some((e) => (e.assignment as { status: string }).status === "running")).toBe(true);

    proc.kill();
  });

  test("push task:assignment_update(completed) → real dispatcher delivers → extension auto-advances storage", async () => {
    const proc = spawnExtension();
    bus = new EventBus<AgentEvents>();
    quota = createSpawnQuota(bus);
    dispatcher = new EventSubscriptionDispatcher(
      bus,
      makeStubRegistry(proc) as any,
      async () => [EXT_ID],
    );
    dispatcher.registerExtension(EXT_ID, ["task:assignment_update"]);
    dispatcher.start();
    startHandlerPump(proc);

    // Clear any prior storage from sibling tests.
    const { deleteStorageValue } = await import("../db/queries/extension-storage");
    await deleteStorageValue(EXT_ID, "conversation", CONV_ID, "tasks");

    // Seed a two-task plan where A is running and B is pending. When A
    // completes via the bridge, B must become active.
    const planResp = await callTool(proc, 300, "task_plan", {
      tasks: [{ title: "A", assignTo: "builder" }, { title: "B" }],
    });
    expect(planResp.isError).toBe(false);

    const rowInit = await getStorageValue(EXT_ID, "conversation", CONV_ID, "tasks");
    const snapInit = rowInit!.value as {
      tasks: Array<{ id: string; title: string; status: string; assignments: Array<{ id: string; status: string }> }>;
      activeTaskId?: string;
    };
    const taskA = snapInit.tasks.find((t) => t.title === "A")!;
    const taskB = snapInit.tasks.find((t) => t.title === "B")!;
    const assnA = taskA.assignments[0]!;
    expect(assnA.status).toBe("running");
    expect(taskA.status).toBe("active");
    expect(taskB.status).toBe("pending");

    // Fire the bridge: push assignment_update for A with completed
    // status. Real EventSubscriptionDispatcher picks this up, delivers
    // it to the subprocess as a notification, and the extension's
    // subscription handler rewrites storage.
    bus.emit("task:assignment_update", {
      conversationId: CONV_ID,
      taskId: taskA.id,
      assignment: {
        id: assnA.id,
        agentConfigId: "cfg-builder",
        agentName: "builder",
        isTeam: false,
        status: "completed",
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        resultPreview: "done",
      },
    });

    // Poll storage until A is completed + B is active. The bridge
    // round-trip includes: host-dispatch → stdin inject → extension
    // subscription → storage RPC round-trip to PGlite. Generous
    // deadline: 3s.
    const deadline = Date.now() + 3000;
    let latest: typeof snapInit | undefined;
    while (Date.now() < deadline) {
      const r = await getStorageValue(EXT_ID, "conversation", CONV_ID, "tasks");
      const s = r!.value as typeof snapInit;
      const a = s.tasks.find((t) => t.id === taskA.id)!;
      const b = s.tasks.find((t) => t.id === taskB.id)!;
      if (a.status === "completed" && b.status === "active") {
        latest = s;
        break;
      }
      await new Promise((r2) => setTimeout(r2, 20));
    }
    expect(latest).toBeDefined();
    const aAfter = latest!.tasks.find((t) => t.id === taskA.id)!;
    const bAfter = latest!.tasks.find((t) => t.id === taskB.id)!;
    expect(aAfter.status).toBe("completed");
    expect(aAfter.assignments[0]!.status).toBe("completed");
    expect(bAfter.status).toBe("active");
    expect(latest!.activeTaskId).toBe(taskB.id);

    proc.kill();
  });

  test("sequential task_list calls don't deadlock through the full real pipeline", async () => {
    const proc = spawnExtension();
    bus = new EventBus<AgentEvents>();
    quota = createSpawnQuota(bus);
    dispatcher = new EventSubscriptionDispatcher(
      bus,
      makeStubRegistry(proc) as any,
      async () => [EXT_ID],
    );
    dispatcher.registerExtension(EXT_ID, ["task:assignment_update"]);
    dispatcher.start();
    startHandlerPump(proc);

    for (let i = 0; i < 5; i++) {
      const out = await callTool(proc, 400 + i, "task_list", {});
      expect(out.isError).toBe(false);
    }

    proc.kill();
  });
});
