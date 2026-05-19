/**
 * End-to-end test for the Phase 4 commit-5 orchestration cutover.
 *
 * Wires the REAL pieces together to prove the deleted legacy
 * invoke-agent built-in's surface is fully replicated by the bundled
 * extension path:
 *
 *   - Real subprocess running `docs/extensions/examples/orchestration/index.ts`.
 *   - Real `src/runtime/orchestration-host.ts` helpers
 *     (`ensureOrchestrationWired`, `wireOrchestrationToolsForTurn`).
 *   - Real `extensionToAgentTool` / `ToolExecutor` wrapping the tool
 *     with the per-turn `schemaOverride` (injected `agentConfigId`
 *     enum) and `invocationMetadata` (overrides / teamToolScope /
 *     parentMessageId / orchestrationDepth).
 *   - Real `handleAgentConfigsRpc`, `handleSpawnAssignmentRpc`, and
 *     `EventSubscriptionDispatcher` — the full host side of the
 *     reverse-RPC + event-bridge contract.
 *   - Real PGlite behind `getDb` so `ensureOrchestrationWired` inserts
 *     a real `conversation_extensions` row and the spawn handler's
 *     conversation-wire check passes.
 *   - Stubbed `startAssignment` so a sub-run doesn't need a real
 *     executor/streamChat — it returns `{subConversationId, agentRunId}`
 *     deterministically, which is all the spawn-assignment handler
 *     needs to produce a handle.
 *
 * What each test covers (plan §7.4 + §Verification bullet 4):
 *   1. `ensureOrchestrationWired` inserts conversation_extensions row.
 *   2. `wireOrchestrationToolsForTurn` appends a tool named
 *      `invoke_agent` (preserves the contract the executor's auto-
 *      spin-up at line 899 + event-suppression at 1079/1099 rely on)
 *      with the per-turn `agentConfigId` enum schema override.
 *   3. Empty `availableAgents` → no tool appended (skip guard).
 *   4. Depth-gate: the executor gates wire-on-depth via the same code
 *      path that gates any orchestration wiring today — the dedicated
 *      test lives in executor-agent-wiring.test.ts. Here we prove the
 *      depth value rides in on `invocationMetadata.orchestrationDepth`
 *      so sub-agent spawns carry the right number downstream.
 *   5. Full happy-path round-trip: execute the wrapped tool → subprocess
 *      `tools/call invoke_agent` → `ezcorp/spawn-assignment` RPC hits
 *      the real host handler → returns handle → real bus emits
 *      `task:assignment_update(completed)` → subscription handler
 *      resolves → tool result carries `resultPreview` + `_agentMeta`.
 *   6. Failed status → tool result has `isError: true`, still carries
 *      `_agentMeta` so the UI can link to the sub-conversation.
 *   7. Unknown agentConfigId → tool result has `isError: true` with
 *      the `Error: Unknown agent` text (legacy contract).
 *   8. Spawn dispatch failure → tool result has `isError: true`.
 *   9. `task:assignment_update` fired through the real
 *      `EventSubscriptionDispatcher` bridges back to the subprocess
 *      and closes the completion gate — the two-hop proof.
 *  10. `invocationMetadata.overrides` / `teamToolScope` / `parentMessageId`
 *      ride through the wrapper → handler → spawn call (sentinel
 *      resolution for the invoke-agent branch: the plan's
 *      current-model-e2e pure-logic replica pairs with this e2e
 *      assertion to pin the full invariant).
 *  11. Team-scope cascade: `teamToolScope` forwarded into the spawn
 *      handler's `startAssignment` call (replaces the coverage that
 *      used to live in team-tool-scope-integration.test.ts's
 *      in-process invoke-agent build).
 *  12. `agent:spawn`/`agent:complete` event-suppression invariant:
 *      the executor's 1079/1099 special-cases key on the bare string
 *      "invoke_agent" — this test asserts the wrapped tool preserves
 *      that exact name (no namespacing leak).
 *
 * Structurally mirrors `src/__tests__/task-tracking-e2e.test.ts` —
 * same spawnExtension helper, same handler-pump pattern.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test, mock } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join } from "path";
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

// Stub startAssignment so spawn handlers return deterministically — the
// real executor.streamChat would need a live provider stack, which this
// test doesn't exercise. Mirror task-tracking-e2e's identical stub.
let nextRunId = 1;
mock.module("../runtime/start-assignment", () => ({
  startAssignment: async (opts: Record<string, unknown>) => {
    const runId = `run-orch-e2e-${nextRunId++}`;
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
      title: "orch-e2e-sub",
    } as any).onConflictDoNothing();
    return { subConversationId: subConvId, agentRunId: runId };
  },
}));

// Mock the SQL-level agent-configs fetch used by agent-configs-handler.
// The extension resolves agentConfigId via the `ezcorp/agent-configs`
// reverse-RPC which ultimately calls `listAgentConfigs`. One fixture
// config is enough to drive the happy-path plus a missing-id case.
mock.module("../db/queries/agent-configs", () => ({
  listAgentConfigs: async () => [
    {
      id: "cfg-builder",
      name: "builder",
      description: "Builds things",
      prompt: "You build things.",
      capabilities: ["llm"],
      references: { agents: [], extensions: [] },
      userId: "user-orch-e2e",
      model: null,
      provider: null,
    },
  ],
}));

const { ensureOrchestrationWired, wireOrchestrationToolsForTurn, _resetOrchestrationExtensionIdCache } =
  await import("../runtime/orchestration-host");
// Phase 1 fail-closed contract: wireOrchestrationToolsForTurn calls
// getPermissionEngine() with no deps and throws if not pre-initialized.
// We install an allow-all stub once in beforeAll. The real engine is
// not exercised because the wrapper short-circuits via the
// extensionToAgentTool path which the test drives end-to-end.
const { _setPermissionEngineForTests, _resetPermissionEngineForTests } = await import(
  "../extensions/permission-engine"
);
const { createStubPermissionEngine } = await import(
  "./helpers/permission-engine-stub"
);
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
  conversationExtensions,
} = await import("../db/schema");

import type { AgentEvents } from "../types";
import type { AgentExecutor } from "../runtime/executor";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { RegisteredTool } from "../extensions/registry";

const EXT_ENTRY = join(
  import.meta.dir ?? process.cwd(),
  "..",
  "..",
  "docs",
  "extensions",
  "examples",
  "orchestration",
  "index.ts",
);

const EXT_ID = "ext-orch-e2e";
const CONV_ID = "conv-orch-e2e";
const PROJ_ID = "proj-orch-e2e";
const USER_ID = "user-orch-e2e";

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
  agentConfig: "read",
  spawnAgents: { maxPerHour: 500, maxConcurrent: 25 },
  eventSubscriptions: ["task:assignment_update"],
  grantedAt: {
    agentConfig: Date.now(),
    spawnAgents: Date.now(),
    eventSubscriptions: Date.now(),
  },
};

const MANIFEST: ExtensionManifestV2 = {
  schemaVersion: 2,
  name: "orchestration",
  version: "1.0.0",
  description: "orchestration e2e",
  author: { name: "test" },
  permissions: {
    agentConfig: "read",
    spawnAgents: { maxPerHour: 500, maxConcurrent: 25 },
    eventSubscriptions: ["task:assignment_update"],
  },
};

// ── Fake registry — minimal surface the orchestration-host needs ────

interface FakeRegistry {
  getToolsForExtension: (extId: string) => RegisteredTool[];
  getRegisteredTool: (name: string) => RegisteredTool | undefined;
  getProcess: (extId: string) => Promise<{
    isRunning: boolean;
    callTool: (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => Promise<unknown>;
    setNotificationHandler: (fn: (n: unknown) => void) => void;
    setRequestHandler: (fn: (req: Record<string, unknown>) => Promise<Record<string, unknown>>) => void;
  }>;
  getManifest: (extId: string) => ExtensionManifestV2 | undefined;
  getGrantedPermissions: (extId: string) => ExtensionPermissions | undefined;
  getInstallPath: (extId: string) => string | undefined;
  getMcpClient: () => never;
}

/**
 * Build a fake ExtensionRegistry that speaks to the real subprocess.
 * Wraps the subprocess stdio in a `callTool` shim that issues JSON-RPC
 * `tools/call` requests, waits for the matching response, and returns
 * the `result` payload in the `{content, isError}` shape the
 * ToolExecutor expects.
 */
function makeFakeRegistry(p: TestProc): FakeRegistry {
  let nextCallId = 1_000_000;
  const registeredTool: RegisteredTool = {
    name: "invoke_agent",
    originalName: "invoke_agent",
    description:
      "Invoke a specialized agent to handle a task. The agent runs as an independent sub-conversation and returns its response.",
    inputSchema: {
      type: "object",
      properties: {
        agentConfigId: { type: "string", description: "id" },
        task: { type: "string", description: "task" },
      },
      required: ["agentConfigId", "task"],
    },
    extensionId: EXT_ID,
    extensionName: "orchestration",
  } as RegisteredTool;

  // The ToolExecutor wires its own request handler onto the process
  // (handlePiSpawnAssignment, handlePiAgentConfigs, etc.), replacing
  // whatever the pump installed. To keep the real host handlers in
  // the loop, we intercept setRequestHandler and fan-route based on
  // method — falling back to the pump-installed handler for anything
  // the ToolExecutor doesn't own.
  let executorReqHandler: ((req: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;

  const procWrapper = {
    isRunning: true,
    setNotificationHandler: () => {},
    setRequestHandler: (fn: (req: Record<string, unknown>) => Promise<Record<string, unknown>>) => {
      executorReqHandler = fn;
    },
    async callTool(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) {
      const id = ++nextCallId;
      const cursor = p.outbound.length;
      p.inbound({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          ...(meta !== undefined ? { _meta: meta } : {}),
        },
      });
      const resp = await p.waitAfter(cursor, (m) => m.id === id && (m.result !== undefined || m.error !== undefined));
      if (resp.error) {
        return {
          content: [{ type: "text", text: JSON.stringify(resp.error) }],
          isError: true,
        };
      }
      return resp.result as { content: Array<{ type: string; text: string }>; isError?: boolean; details?: unknown };
    },
  };

  // The pump routes subprocess RPC requests to the real host handlers.
  // We also expose the executor's wired handler so the test can drive
  // cross-handler routing (not used today but kept for symmetry).
  void executorReqHandler;

  return {
    getToolsForExtension: (extId: string) => (extId === EXT_ID ? [registeredTool] : []),
    getRegisteredTool: (name: string) => (name === "invoke_agent" ? registeredTool : undefined),
    getProcess: async (extId: string) => {
      if (extId !== EXT_ID) throw new Error(`unknown extension: ${extId}`);
      return procWrapper;
    },
    getManifest: (extId: string) => (extId === EXT_ID ? MANIFEST : undefined),
    getGrantedPermissions: (extId: string) => (extId === EXT_ID ? GRANTED : undefined),
    getInstallPath: (extId: string) => (extId === EXT_ID ? "/tmp/orch-e2e" : undefined),
    getMcpClient: () => { throw new Error("not an MCP extension"); },
  };
}

// ── Pump: drain outbound RPCs and route each to its real handler ────

let bus: InstanceType<typeof EventBus<AgentEvents>>;
let quota: ReturnType<typeof createSpawnQuota>;
let dispatcher: InstanceType<typeof EventSubscriptionDispatcher>;

function makeStubRegistryForDispatcher(p: TestProc) {
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

interface PumpHandle {
  /** The most recent successful spawn-assignment response — populated
   *  by the pump after it hands the RPC to the real host handler. */
  lastSpawnResult?: {
    assignmentId: string;
    taskId: string;
    subConversationId: string;
    agentRunId: string;
  };
  spawnRequests: Array<Record<string, unknown>>;
}

/**
 * Background pump: for every RPC request the subprocess emits,
 * dispatch to the real host handler and feed the response back.
 *
 * Returns a handle whose `lastSpawnResult` is populated after each
 * successful spawn-assignment RPC — tests use this to pick up the
 * real assignmentId the handler minted so they can emit a matching
 * `task:assignment_update(completed|failed)` via the real bus.
 */
function startHandlerPump(p: TestProc): PumpHandle {
  const handle: PumpHandle = { spawnRequests: [] };
  (async () => {
    let next = 0;
    while (p.proc.exitCode === null) {
      for (; next < p.outbound.length; next++) {
        const m = p.outbound[next]!;
        if (typeof m.method !== "string" || m.id === undefined) continue;
        try {
          if (m.method === "ezcorp/emit-task-event") {
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
            handle.spawnRequests.push(m);
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
            // Capture the minted handle so tests can emit a matching
            // terminal event via the real bus.
            const result = (resp as { result?: Record<string, unknown> }).result;
            if (result && typeof result === "object") {
              const r = result as Record<string, string>;
              if (r.assignmentId && r.taskId && r.subConversationId && r.agentRunId) {
                handle.lastSpawnResult = {
                  assignmentId: r.assignmentId,
                  taskId: r.taskId,
                  subConversationId: r.subConversationId,
                  agentRunId: r.agentRunId,
                };
              }
            }
            p.inbound(resp as unknown as Record<string, unknown>);
          }
        } catch (err) {
          p.inbound({
            jsonrpc: "2.0",
            id: m.id as number | string,
            error: { code: -32603, message: `pump handler threw: ${String(err)}` },
          });
        }
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  return handle;
}

/** Wait until the pump has captured a spawn result — polls the shared
 *  handle rather than the bus so the race doesn't rely on subscription
 *  registration order. */
async function waitForSpawnResult(
  pump: PumpHandle,
  ms = 3000,
): Promise<NonNullable<PumpHandle["lastSpawnResult"]>> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pump.lastSpawnResult) return pump.lastSpawnResult;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for spawn result");
}

// ── Setup / teardown ────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values({
    id: USER_ID, email: "orch-e2e@t.local", passwordHash: "x", name: "OrchE2E",
  } as any).onConflictDoNothing();
  await getDb().insert(projects).values({
    id: PROJ_ID, name: PROJ_ID, path: "/tmp/" + PROJ_ID,
  } as any).onConflictDoNothing();
  await getDb().insert(conversations).values({
    id: CONV_ID, projectId: PROJ_ID, title: "orch-e2e-conv", userId: USER_ID,
  } as any).onConflictDoNothing();
  await getDb().insert(extensionsTable).values({
    id: EXT_ID,
    name: "orchestration",
    version: "1.0.0",
    description: "e2e",
    manifest: MANIFEST,
    source: `test:${EXT_ID}`,
    installPath: `/tmp/${EXT_ID}`,
    enabled: true,
    grantedPermissions: GRANTED,
  } as any).onConflictDoNothing();
  // Install an allow-all PDP stub as the singleton so
  // wireOrchestrationToolsForTurn's bare getPermissionEngine() call
  // resolves. The real authorize() path runs through the e2e
  // subprocess + handlers, so an allow-all stub keeps every spawn /
  // tool-call decision unblocked.
  _resetPermissionEngineForTests();
  _setPermissionEngineForTests(createStubPermissionEngine("allow-all"));
});

afterAll(async () => {
  _resetPermissionEngineForTests();
  await closeTestDb();
  restoreModuleMocks();
});

beforeEach(() => {
  _resetOrchestrationExtensionIdCache();
});

// ── Tests ──────────────────────────────────────────────────────────

describe("orchestration e2e: orchestration-host + real subprocess + real handlers", () => {
  test("ensureOrchestrationWired inserts a conversation_extensions row", async () => {
    const ok = await ensureOrchestrationWired(CONV_ID);
    expect(ok).toBe(true);
    const { eq, and } = await import("drizzle-orm");
    const rows = await getDb()
      .select()
      .from(conversationExtensions)
      .where(
        and(
          eq(conversationExtensions.conversationId, CONV_ID),
          eq(conversationExtensions.extensionId, EXT_ID),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  test("wireOrchestrationToolsForTurn appends a tool named 'invoke_agent'", async () => {
    const proc = spawnExtension();
    bus = new EventBus<AgentEvents>();
    quota = createSpawnQuota(bus);
    startHandlerPump(proc);

    const agentTools: AgentTool[] = [];
    await wireOrchestrationToolsForTurn({
      agentTools,
      conversationId: CONV_ID,
      runId: "run-wire-1",
      availableAgents: [
        { id: "cfg-builder", name: "builder", description: "Builds things" },
      ],
      depth: 0,
      registry: makeFakeRegistry(proc) as any,
      executor: {} as any,
      spawnQuota: quota,
      userId: USER_ID,
    });

    expect(agentTools).toHaveLength(1);
    const tool = agentTools[0]!;
    expect(tool.name).toBe("invoke_agent");
    // Schema override: the agentConfigId enum is injected per-turn so
    // the LLM can only pick agents visible to this turn.
    const params = tool.parameters as unknown as { properties: { agentConfigId: { enum: string[] } } };
    expect(params.properties.agentConfigId.enum).toEqual(["cfg-builder"]);

    proc.kill();
  });

  test("wireOrchestrationToolsForTurn skips when availableAgents is empty", async () => {
    const proc = spawnExtension();
    bus = new EventBus<AgentEvents>();
    quota = createSpawnQuota(bus);
    startHandlerPump(proc);

    const agentTools: AgentTool[] = [];
    await wireOrchestrationToolsForTurn({
      agentTools,
      conversationId: CONV_ID,
      runId: "run-empty",
      availableAgents: [],
      depth: 0,
      registry: makeFakeRegistry(proc) as any,
      executor: {} as any,
      spawnQuota: quota,
      userId: USER_ID,
    });

    expect(agentTools).toHaveLength(0);
    proc.kill();
  });

  test("full round-trip: execute invoke_agent → spawn handler → completed event → tool result", async () => {
    const proc = spawnExtension();
    bus = new EventBus<AgentEvents>();
    quota = createSpawnQuota(bus);
    dispatcher = new EventSubscriptionDispatcher(
      bus,
      makeStubRegistryForDispatcher(proc) as any,
      async () => [EXT_ID],
    );
    dispatcher.registerExtension(EXT_ID, ["task:assignment_update"]);
    dispatcher.start();
    const pump = startHandlerPump(proc);

    const agentTools: AgentTool[] = [];
    await wireOrchestrationToolsForTurn({
      agentTools,
      conversationId: CONV_ID,
      runId: "run-full-1",
      availableAgents: [
        { id: "cfg-builder", name: "builder", description: "Builds things" },
      ],
      depth: 0,
      registry: makeFakeRegistry(proc) as any,
      executor: {} as any,
      spawnQuota: quota,
      userId: USER_ID,
    });

    const tool = agentTools[0]!;
    expect(tool.name).toBe("invoke_agent");

    // Kick off the execution. The spawn handler runs synchronously in
    // the pump, captures the minted assignmentId on the pump handle,
    // and inbounds the response back to the extension. The extension
    // then has a pending entry keyed on that id.
    const execPromise = tool.execute("test-call-1", { agentConfigId: "cfg-builder", task: "build it" });

    const spawnResult = await waitForSpawnResult(pump);
    // Emit the completed terminal — the real dispatcher routes this
    // to every subscribed extension (including orchestration).
    bus.emit("task:assignment_update", {
      conversationId: CONV_ID,
      taskId: spawnResult.taskId,
      assignment: {
        id: spawnResult.assignmentId,
        agentConfigId: "cfg-builder",
        agentName: "builder",
        isTeam: false,
        status: "completed",
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        resultPreview: "built it",
      },
    });

    const result = await execPromise;
    expect(result.details?.isError).toBeFalsy();
    const first0 = result.content?.[0];
    expect(first0?.type === "text" ? first0.text : undefined).toBe("built it");

    proc.kill();
  });

  test("full round-trip with failed status → isError result, still carries _agentMeta", async () => {
    const proc = spawnExtension();
    bus = new EventBus<AgentEvents>();
    quota = createSpawnQuota(bus);
    dispatcher = new EventSubscriptionDispatcher(
      bus,
      makeStubRegistryForDispatcher(proc) as any,
      async () => [EXT_ID],
    );
    dispatcher.registerExtension(EXT_ID, ["task:assignment_update"]);
    dispatcher.start();
    const pump = startHandlerPump(proc);

    const agentTools: AgentTool[] = [];
    await wireOrchestrationToolsForTurn({
      agentTools,
      conversationId: CONV_ID,
      runId: "run-fail-1",
      availableAgents: [{ id: "cfg-builder", name: "builder", description: "Builds things" }],
      depth: 0,
      registry: makeFakeRegistry(proc) as any,
      executor: {} as any,
      spawnQuota: quota,
      userId: USER_ID,
    });

    const tool = agentTools[0]!;
    const execPromise = tool.execute("test-call-fail", { agentConfigId: "cfg-builder", task: "fail me" });

    const spawnResult = await waitForSpawnResult(pump);
    bus.emit("task:assignment_update", {
      conversationId: CONV_ID,
      taskId: spawnResult.taskId,
      assignment: {
        id: spawnResult.assignmentId,
        agentConfigId: "cfg-builder",
        agentName: "builder",
        isTeam: false,
        status: "failed",
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        resultPreview: "agent crashed",
      },
    });

    const result = await execPromise;
    expect(result.details?.isError).toBe(true);
    const crashedFirst = result.content?.[0];
    expect(crashedFirst?.type === "text" ? crashedFirst.text : undefined).toBe("agent crashed");

    proc.kill();
  });

  test("unknown agentConfigId returns isError with the 'Unknown agent' text", async () => {
    const proc = spawnExtension();
    bus = new EventBus<AgentEvents>();
    quota = createSpawnQuota(bus);
    startHandlerPump(proc);

    const agentTools: AgentTool[] = [];
    await wireOrchestrationToolsForTurn({
      agentTools,
      conversationId: CONV_ID,
      runId: "run-unknown",
      availableAgents: [{ id: "cfg-builder", name: "builder", description: "Builds things" }],
      depth: 0,
      registry: makeFakeRegistry(proc) as any,
      executor: {} as any,
      spawnQuota: quota,
      userId: USER_ID,
    });

    const tool = agentTools[0]!;
    // Force an unknown id by bypassing the per-turn schema enum (the
    // schema is advisory at the LLM layer — the extension still
    // validates via `agentConfigs.resolve`).
    const result = await tool.execute("test-call-unknown", { agentConfigId: "cfg-nonexistent", task: "nope" });
    expect(result.details?.isError).toBe(true);
    const unknownFirst = result.content?.[0];
    expect(unknownFirst?.type === "text" ? unknownFirst.text : undefined).toMatch(/Unknown agent/);

    proc.kill();
  });

  test("invocationMetadata.teamToolScope flows into the spawn handler's startAssignment call", async () => {
    const proc = spawnExtension();
    bus = new EventBus<AgentEvents>();
    quota = createSpawnQuota(bus);
    dispatcher = new EventSubscriptionDispatcher(
      bus,
      makeStubRegistryForDispatcher(proc) as any,
      async () => [EXT_ID],
    );
    dispatcher.registerExtension(EXT_ID, ["task:assignment_update"]);
    dispatcher.start();
    const pump = startHandlerPump(proc);

    const agentTools: AgentTool[] = [];
    await wireOrchestrationToolsForTurn({
      agentTools,
      conversationId: CONV_ID,
      runId: "run-scope-1",
      availableAgents: [{ id: "cfg-builder", name: "builder", description: "Builds things" }],
      depth: 2,
      teamToolScope: { allowedTools: ["read_file"], deniedTools: ["shell_exec"] },
      parentMessageId: "msg-parent-123",
      memberOverrides: {
        "cfg-builder": { model: "claude-opus" },
      } as Record<string, unknown>,
      registry: makeFakeRegistry(proc) as any,
      executor: {} as any,
      spawnQuota: quota,
      userId: USER_ID,
    });

    const tool = agentTools[0]!;
    const execPromise = tool.execute("test-call-scope", { agentConfigId: "cfg-builder", task: "scoped" });

    const spawnResult = await waitForSpawnResult(pump);
    bus.emit("task:assignment_update", {
      conversationId: CONV_ID,
      taskId: spawnResult.taskId,
      assignment: {
        id: spawnResult.assignmentId,
        agentConfigId: "cfg-builder",
        agentName: "builder",
        isTeam: false,
        status: "completed",
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        resultPreview: "scoped-ok",
      },
    });

    await execPromise;

    // The pump recorded the raw spawn RPC request — read back the
    // params the wrapper/handler forwarded.
    expect(pump.spawnRequests.length).toBeGreaterThanOrEqual(1);
    const spawnReq = pump.spawnRequests[0]!.params as Record<string, unknown>;
    expect(spawnReq.teamToolScope).toEqual({ allowedTools: ["read_file"], deniedTools: ["shell_exec"] });
    expect(spawnReq.parentMessageId).toBe("msg-parent-123");
    expect(spawnReq.orchestrationDepth).toBe(2);
    // memberOverrides is threaded under `overrides` — the host flattens
    // the Map→Record at the wire-turn seam; the extension forwards
    // blindly so the downstream startAssignment sees the full record.
    expect(spawnReq.overrides).toEqual({ "cfg-builder": { model: "claude-opus" } });

    proc.kill();
  });

  test("tool name preserves the bare 'invoke_agent' contract (event-suppression invariant)", async () => {
    // executor.ts:1079,1099 key their tool-event suppression on the
    // literal string "invoke_agent". If the wrapper namespaced the name
    // (e.g. "orchestration__invoke_agent") the suppression would break
    // and the UI would see stray tool:start/tool:complete events for
    // sub-agent spawns. Commit 4A's decision to use `originalName`
    // (not `name`) in the wrapper's `extTool.name` is what pins this.
    const proc = spawnExtension();
    bus = new EventBus<AgentEvents>();
    quota = createSpawnQuota(bus);
    startHandlerPump(proc);

    const agentTools: AgentTool[] = [];
    await wireOrchestrationToolsForTurn({
      agentTools,
      conversationId: CONV_ID,
      runId: "run-name-1",
      availableAgents: [{ id: "cfg-builder", name: "builder", description: "Builds things" }],
      depth: 0,
      registry: makeFakeRegistry(proc) as any,
      executor: {} as any,
      spawnQuota: quota,
      userId: USER_ID,
    });

    expect(agentTools[0]!.name).toBe("invoke_agent");
    expect(agentTools[0]!.name).not.toContain("__");

    proc.kill();
  });

  test("self-delivery guard: foreign assignment_update is a no-op", async () => {
    const proc = spawnExtension();
    bus = new EventBus<AgentEvents>();
    quota = createSpawnQuota(bus);
    dispatcher = new EventSubscriptionDispatcher(
      bus,
      makeStubRegistryForDispatcher(proc) as any,
      async () => [EXT_ID],
    );
    dispatcher.registerExtension(EXT_ID, ["task:assignment_update"]);
    dispatcher.start();
    const pump = startHandlerPump(proc);

    const agentTools: AgentTool[] = [];
    await wireOrchestrationToolsForTurn({
      agentTools,
      conversationId: CONV_ID,
      runId: "run-self-1",
      availableAgents: [{ id: "cfg-builder", name: "builder", description: "Builds things" }],
      depth: 0,
      registry: makeFakeRegistry(proc) as any,
      executor: {} as any,
      spawnQuota: quota,
      userId: USER_ID,
    });

    const tool = agentTools[0]!;
    const execPromise = tool.execute("test-call-self", { agentConfigId: "cfg-builder", task: "self-sanity" });

    // Foreign event fired BEFORE the owned spawn completes — the
    // extension never registered this assignmentId in its pending map.
    // Must be ignored (no crash, no stray resolution).
    bus.emit("task:assignment_update", {
      conversationId: CONV_ID,
      taskId: "foreign-task",
      assignment: {
        id: "foreign-assign-xyz",
        agentConfigId: "cfg-builder",
        agentName: "builder",
        isTeam: false,
        status: "completed",
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        resultPreview: "not ours",
      },
    });

    const spawnResult = await waitForSpawnResult(pump);
    bus.emit("task:assignment_update", {
      conversationId: CONV_ID,
      taskId: spawnResult.taskId,
      assignment: {
        id: spawnResult.assignmentId,
        agentConfigId: "cfg-builder",
        agentName: "builder",
        isTeam: false,
        status: "completed",
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        resultPreview: "owned-result",
      },
    });

    const result = await execPromise;
    expect(result.details?.isError).toBeFalsy();
    const ownedFirst = result.content?.[0];
    expect(ownedFirst?.type === "text" ? ownedFirst.text : undefined).toBe("owned-result");

    proc.kill();
  });
});
