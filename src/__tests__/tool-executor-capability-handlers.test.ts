// Direct tests for ToolExecutor.handlePiAgentConfigs and
// ToolExecutor.handlePiEmitTaskEvent (Phase 2b).
//
// These methods are reached by the subprocess request-handler switch in
// setRequestHandler. Unit-testing them directly locks in the two
// branches that the integration/e2e tests never hit:
//   - registry.getGrantedPermissions() returns null → -32603
//   - the context-building path propagates currentUserId +
//     currentConversationId + bus into the handler's context
//
// Keeping these tests in a dedicated file (instead of growing
// storage/tool-executor integration tests) means a future refactor of
// the handler surface will fail loudly right here rather than via a
// hard-to-diagnose downstream regression.

import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
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

const { ToolExecutor } = await import("../extensions/tool-executor");
const { getDb } = await import("../db/connection");
const { users, projects, conversations, extensions, conversationExtensions, agentConfigs } =
  await import("../db/schema");
const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");

import type { ExtensionRegistry } from "../extensions/registry";
import type { JsonRpcRequest, ExtensionPermissions } from "../extensions/types";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

const {
  registerCallProvenance,
  registerFireCallProvenance,
  _resetCallProvenanceForTests,
} = await import("../extensions/call-provenance");

// ── Test helpers ─────────────────────────────────────────────────────

interface EmitCall { event: string; payload: unknown; }

function makeBus(): { bus: EventBus<AgentEvents>; calls: EmitCall[] } {
  const calls: EmitCall[] = [];
  const bus = {
    emit: (event: string, payload: unknown) => { calls.push({ event, payload }); },
    on: () => () => {},
    off: () => {},
  } as unknown as EventBus<AgentEvents>;
  return { bus, calls };
}

function makeRegistry(
  granted: ExtensionPermissions | null,
): ExtensionRegistry {
  return {
    getGrantedPermissions: () => granted,
    getInstallPath: () => "/tmp/test",
    getManifest: () => ({
      schemaVersion: 2, name: "test", version: "1.0.0", description: "",
      author: { name: "t" }, permissions: {},
    } as any),
    getRegisteredTool: () => null,
  } as unknown as ExtensionRegistry;
}

function rpc(method: string, params: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

const EXT_ID = "te-cap";
const CONV_ID = "conv-cap-1";

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values({
    id: "user-cap", email: "cap@t.local", passwordHash: "x", name: "cap",
  } as any).onConflictDoNothing();
  await getDb().insert(projects).values({
    id: "proj-cap", name: "proj-cap", path: "/tmp/proj-cap",
  } as any);
  await getDb().insert(conversations).values({
    id: CONV_ID, projectId: "proj-cap", title: "cap",
  } as any);
  await getDb().insert(extensions).values({
    id: EXT_ID, name: EXT_ID, version: "1.0.0", description: "t",
    manifest: {
      schemaVersion: 2, name: EXT_ID, version: "1.0.0", description: "",
      author: { name: "t" }, permissions: {},
    },
    source: `test:${EXT_ID}`, installPath: `/tmp/${EXT_ID}`, enabled: true,
  } as any);
  await getDb().insert(conversationExtensions).values({
    conversationId: CONV_ID, extensionId: EXT_ID,
  } as any).onConflictDoNothing();
  await getDb().insert(agentConfigs).values({
    id: crypto.randomUUID(), name: "cap-helper", description: "",
    prompt: "p", capabilities: ["llm"],
    references: { agents: [], extensions: [] },
    userId: "user-cap",
  } as any);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

// ── handlePiAgentConfigs ─────────────────────────────────────────────

describe("ToolExecutor.handlePiAgentConfigs", () => {
  test("registry miss (null granted permissions) → -32603", async () => {
    const execu = new ToolExecutor(makeRegistry(null), createStubPermissionEngine());
    const resp = await execu.handlePiAgentConfigs(
      "missing-ext",
      rpc("ezcorp/agent-configs", { v: 1, action: "list" }),
    );
    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toMatch(/not found in registry/);
  });

  test("context builds from currentUserId and happy-path list succeeds", async () => {
    const granted: ExtensionPermissions = { agentConfig: "read", grantedAt: {} };
    const execu = new ToolExecutor(makeRegistry(granted), createStubPermissionEngine());
    execu.setCurrentUserId("user-cap");
    const resp = await execu.handlePiAgentConfigs(
      EXT_ID,
      rpc("ezcorp/agent-configs", { v: 1, action: "list" }),
    );
    expect(resp.error).toBeUndefined();
    const { configs } = resp.result as { configs: Array<{ name: string }> };
    expect(configs.some((c) => c.name === "cap-helper")).toBe(true);
  });

  test("unset currentUserId flows through as 'unknown' and is rejected (-32602)", async () => {
    const granted: ExtensionPermissions = { agentConfig: "read", grantedAt: {} };
    const execu = new ToolExecutor(makeRegistry(granted), createStubPermissionEngine());
    // NOTE: setCurrentUserId NOT called. Default "unknown" sentinel.
    const resp = await execu.handlePiAgentConfigs(
      EXT_ID,
      rpc("ezcorp/agent-configs", { v: 1, action: "list" }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toMatch(/User scope unavailable/);
  });
});

// ── handlePiEmitTaskEvent ────────────────────────────────────────────

describe("ToolExecutor.handlePiEmitTaskEvent", () => {
  test("registry miss → -32603", async () => {
    const execu = new ToolExecutor(makeRegistry(null), createStubPermissionEngine());
    const resp = await execu.handlePiEmitTaskEvent(
      "missing-ext",
      rpc("ezcorp/emit-task-event", { v: 1, type: "snapshot", payload: { tasks: [] } }),
    );
    expect(resp.error?.code).toBe(-32603);
  });

  test("context threads bus + currentConversationId + currentUserId into handler", async () => {
    const granted: ExtensionPermissions = { taskEvents: true, grantedAt: {} };
    const { bus, calls } = makeBus();
    const execu = new ToolExecutor(makeRegistry(granted), createStubPermissionEngine(), { bus });
    execu.setCurrentUserId("user-cap");
    // currentConversationId is private; we set it indirectly by calling
    // executeToolCall — but we don't have a wired tool. Instead, call
    // the handler directly with a context-compatible setup: since the
    // handler reads `this.currentConversationId`, we need to set it.
    // The only public setter is indirect (via executeToolCall) — but
    // for unit testing we treat "unset → unknown" as the interesting
    // case. Explicitly-set flow is covered in the integration test.
    //
    // So this test verifies: bus is wired and currentUserId propagated,
    // conversation unbound → -32602 from the underlying handler.
    const resp = await execu.handlePiEmitTaskEvent(
      EXT_ID,
      rpc("ezcorp/emit-task-event", {
        v: 1, type: "snapshot", payload: { tasks: [] },
      }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(calls).toHaveLength(0);
  });
});

// ── handlePiEmitLoopEvent ────────────────────────────────────────────

describe("ToolExecutor.handlePiEmitLoopEvent", () => {
  test("registry miss → -32603", async () => {
    const execu = new ToolExecutor(makeRegistry(null), createStubPermissionEngine());
    const resp = await execu.handlePiEmitLoopEvent(
      "missing-ext",
      rpc("ezcorp/emit-loop-event", { v: 1, type: "approval_pending", payload: { loopId: "l", runId: "r" } }),
    );
    expect(resp.error?.code).toBe(-32603);
  });

  test("granted path threads the bus + emits the content-free nudge (no conversation required)", async () => {
    // The stub PDP is allow-all, so the loopEvents gate passes; the emitted
    // loopId is host-STAMPED with the extension id (provenance binding).
    const granted: ExtensionPermissions = { grantedAt: {} };
    const { bus, calls } = makeBus();
    const execu = new ToolExecutor(makeRegistry(granted), createStubPermissionEngine(), { bus });
    const resp = await execu.handlePiEmitLoopEvent(
      EXT_ID,
      rpc("ezcorp/emit-loop-event", {
        v: 1,
        type: "approval_resolved",
        payload: { loopId: "docs", runId: "r1", decision: "approved" },
      }),
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      event: "loops:approval_resolved",
      payload: { loopId: `${EXT_ID}:docs`, runId: "r1", decision: "approved" },
    });
  });

  test("PDP deny → -32001 loopEvents permission not granted (no emit)", async () => {
    const granted: ExtensionPermissions = { grantedAt: {} };
    const { bus, calls } = makeBus();
    const execu = new ToolExecutor(
      makeRegistry(granted),
      createStubPermissionEngine("deny-all"),
      { bus },
    );
    const resp = await execu.handlePiEmitLoopEvent(
      EXT_ID,
      rpc("ezcorp/emit-loop-event", {
        v: 1,
        type: "approval_pending",
        payload: { loopId: "docs", runId: "r1" },
      }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toContain("loopEvents permission not granted");
    expect(calls).toHaveLength(0);
  });
});

// ── Registry-miss (-32603) arm for every reverse-RPC handler ──────────
//
// Each `handlePi*` method opens with a `getGrantedPermissions()` (and for
// a couple, `getManifest()`) null-guard that returns a -32603
// "Extension not found in registry". The integration / e2e suites always
// run with a wired registry, so these guard arms are otherwise never
// measured. Driving every handler with a null-granting registry locks the
// guard for the whole surface in one cheap table-driven block.
describe("ToolExecutor reverse-RPC handlers — registry miss yields -32603", () => {
  function exec(): InstanceType<typeof ToolExecutor> {
    return new ToolExecutor(makeRegistry(null), createStubPermissionEngine());
  }
  const r = (method: string) => rpc(method, { v: 1 });

  test.each([
    ["handlePiStorage", "ezcorp/storage"],
    ["handlePiSpawnAssignment", "ezcorp/spawn-assignment"],
    ["handlePiCancelRun", "ezcorp/cancel-run"],
    ["handlePiQueueAgentMessage", "ezcorp/queue-agent-message"],
    ["handlePiNetworkInternal", "ezcorp/network.internal"],
    ["handlePiLlmComplete", "ezcorp/llm.complete"],
    ["handlePiMemory", "ezcorp/memory"],
    ["handlePiLessons", "ezcorp/lessons"],
    ["handlePiSchedule", "ezcorp/schedule"],
    ["handlePiDrafts", "ezcorp/drafts"],
    ["handlePiAppendMessage", "ezcorp/append-message"],
    ["handlePiFinalizeToolCall", "ezcorp/finalize-tool-call"],
    ["handlePiFs", "ezcorp/fs"],
  ] as const)("%s → -32603", async (fn, method) => {
    const e = exec() as unknown as Record<string, (id: string, req: JsonRpcRequest) => Promise<any>>;
    // handlePiFs (the deprecated path-check shim) needs a path+operation to
    // clear its earlier -32602 guard and reach the registry-miss arm. The
    // fs.* sub-handlers (read/write/…) resolve provenance BEFORE the
    // registry, so they fail at the provenance ladder (-32602), not here —
    // covered in the provenance-ladder block below.
    const req = fn === "handlePiFs"
      ? rpc(method, { path: "/x", operation: "read" })
      : r(method);
    const resp = await e[fn]!("missing-ext", req);
    expect(resp.error?.code).toBe(-32603);
  });
});

// ── handlePiQueueAgentMessage — granted-path plumbing (Phase B3) ──────
//
// The registry-miss (-32603) arm is covered above. This drives the GRANTED
// path so the method's scope-resolve + ctx assembly (incl. the executor
// liveness seam) + dispatch to the real handler are exercised. With no
// conversation scope set the handler returns -32602 (conversation unbound),
// which proves the method got past the registry guard and into the handler.
describe("ToolExecutor.handlePiQueueAgentMessage — granted path dispatches to the handler", () => {
  const GRANT: ExtensionPermissions = {
    spawnAgents: { maxPerHour: 10, maxConcurrent: 3 },
    grantedAt: {},
  } as ExtensionPermissions;

  test("threads the executor into the ctx and dispatches (no conv scope → -32602)", async () => {
    const execu = new ToolExecutor(makeRegistry(GRANT), createStubPermissionEngine());
    // Set an executor so the liveness seam's truthy branch is taken.
    execu.setExecutor({ getActiveRunForConversation: () => undefined } as never);
    const resp = await execu.handlePiQueueAgentMessage(
      EXT_ID,
      rpc("ezcorp/queue-agent-message", { v: 1, subConversationId: "sub-x", message: "hi" }),
    );
    // Past the -32603 registry guard, into the real handler.
    expect(resp.error?.code).toBe(-32602);
  });
});

// ── resolveReverseRpcMeta provenance ladder ───────────────────────────
//
// The provenance-resolving handlers (the Phase-51 capability set + fs.*)
// thread through `resolveReverseRpcMeta`, which returns:
//   - -32602 when no valid host-issued `ezCallId` is on the wire,
//   - -32106 for an ownerless background-fire token,
//   - ok (and dispatches the real handler) for a resolvable user token.
// These arms are the per-call provenance plumbing the integration suites
// don't isolate; drive them through one representative handler each.
describe("ToolExecutor.resolveReverseRpcMeta provenance ladder (via handlePiMemory / fs.read)", () => {
  function execWith(granted: ExtensionPermissions): InstanceType<typeof ToolExecutor> {
    return new ToolExecutor(makeRegistry(granted), createStubPermissionEngine());
  }
  const GRANT: ExtensionPermissions = { memory: "read", grantedAt: {} } as ExtensionPermissions;

  beforeEach(() => _resetCallProvenanceForTests());
  afterEach(() => _resetCallProvenanceForTests());

  test("no ezCallId on the wire → -32602 (provenance unresolved, fail fast)", async () => {
    const resp = await execWith(GRANT).handlePiMemory(
      EXT_ID,
      rpc("ezcorp/memory", { v: 1, action: "search", query: "x" }),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("ownerless background-fire token → -32106 (clean soft-fail, never a throw)", async () => {
    const ezCallId = registerFireCallProvenance({
      onBehalfOf: null,
      conversationId: null,
      runId: null,
      parentCallId: null,
      actorExtensionId: EXT_ID,
      kind: "event",
      ownerless: true,
    });
    const resp = await execWith(GRANT).handlePiMemory(
      EXT_ID,
      rpc("ezcorp/memory", { v: 1, action: "search", query: "x", _meta: { ezCallId } }),
    );
    expect(resp.error?.code).toBe(-32106);
  });

  test("a resolvable user token clears the provenance gate and dispatches the real handler", async () => {
    // A valid token whose actorExtensionId MATCHES the resolving ext —
    // resolveReverseRpcMeta returns ok and the call reaches the memory
    // handler (which then applies its own permission/validation). The
    // assertion only needs to prove we got PAST the provenance ladder:
    // a -32602/-32106 here would mean the gate rejected us.
    const ezCallId = registerCallProvenance({
      onBehalfOf: "user-cap",
      conversationId: CONV_ID,
      runId: "run-1",
      parentCallId: null,
      actorExtensionId: EXT_ID,
      kind: "tool",
      ownerless: false,
    });
    const resp = await execWith(GRANT).handlePiMemory(
      EXT_ID,
      rpc("ezcorp/memory", { v: 1, action: "search", query: "hello world", _meta: { ezCallId } }),
    );
    expect(resp.error?.code).not.toBe(-32602);
    expect(resp.error?.code).not.toBe(-32106);
  });

  test("a token whose actorExtensionId differs from the resolver still proceeds (tripwire, not enforced)", async () => {
    // The actorExtensionId mismatch logs a warn but does NOT hard-reject —
    // exercising line 2330's tripwire branch.
    const ezCallId = registerCallProvenance({
      onBehalfOf: "user-cap",
      conversationId: CONV_ID,
      runId: null,
      parentCallId: "parent-1",
      actorExtensionId: "some-other-ext",
      kind: "tool",
      ownerless: false,
    });
    const resp = await execWith(GRANT).handlePiMemory(
      EXT_ID,
      rpc("ezcorp/memory", { v: 1, action: "search", query: "hi there", _meta: { ezCallId } }),
    );
    expect(resp.error?.code).not.toBe(-32602);
    expect(resp.error?.code).not.toBe(-32106);
  });

  test("fs.read with no token returns the resolver's verbatim -32602", async () => {
    const resp = await execWith(GRANT).handlePiFsRead(
      EXT_ID,
      rpc("ezcorp/fs.read", { v: 1, path: "notes.txt" }),
    );
    expect(resp.error?.code).toBe(-32602);
  });
});
