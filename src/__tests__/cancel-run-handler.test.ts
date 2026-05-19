// Unit tests for src/extensions/cancel-run-handler.ts (Phase 4 §5.3).
//
// Covers: permission gate, ownership gate, happy-path slot release,
// missing-run defensive release, and the §5.3 slot-release-under-cap
// case that proves a cancel frees up a quota slot immediately (rather
// than waiting for the async bus round-trip).
//
// We use a FAKE AgentExecutor — the handler only ever touches
// `executor.cancelRun(id)` so the fake just records calls + returns a
// scripted boolean.

import { test, expect, describe, beforeAll, afterAll, afterEach, mock } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── DB mock (must precede handler import) ─────────────────────────

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

// For the §5.3 slot-release test we need a working spawn path too.
// Fake `startAssignment` so we don't exercise the real executor.
let nextRunId = 1;
mock.module("../runtime/start-assignment", () => ({
  startAssignment: async (opts: Record<string, unknown>) => {
    const runId = `run-cr-${nextRunId++}`;
    const subConversationId = `sub-${runId}`;
    const assignment = opts.assignment as {
      id: string;
      status: string;
      agentRunId?: string;
      subConversationId?: string;
      startedAt?: string;
    };
    assignment.status = "running";
    assignment.agentRunId = runId;
    assignment.subConversationId = subConversationId;
    assignment.startedAt = new Date().toISOString();
    // Seed the sub-conv row so copyConversationExtensions / spawn-depth writes succeed.
    const { getDb } = await import("../db/connection");
    const { conversations } = await import("../db/schema");
    await getDb().insert(conversations).values({
      id: subConversationId,
      projectId: opts.projectId as string,
      parentConversationId: opts.conversationId as string,
      title: "sub",
    } as any).onConflictDoNothing();
    return { subConversationId, agentRunId: runId };
  },
}));

const FIXTURE_CONFIGS = [
  {
    id: "cfg-cr-helper",
    name: "cr-helper",
    description: "helper",
    prompt: "p",
    capabilities: ["llm"],
    references: { agents: [], extensions: [] },
    userId: "user-cr",
    model: null,
    provider: null,
  },
];
mock.module("../db/queries/agent-configs", () => ({
  listAgentConfigs: async (_userId?: string) => FIXTURE_CONFIGS,
}));

// ── Dynamic imports after mocks ────────────────────────────────────

const { handleCancelRunRpc } = await import("../extensions/cancel-run-handler");
const { handleSpawnAssignmentRpc } = await import("../extensions/spawn-assignment-handler");
const { createSpawnQuota } = await import("../extensions/spawn-quota");
const { EventBus } = await import("../runtime/events");
const { getDb } = await import("../db/connection");
const {
  conversations,
  extensions: extensionsTable,
  projects,
  users,
  conversationExtensions,
  auditLog,
} = await import("../db/schema");

import type { JsonRpcRequest } from "../extensions/types";
import type { CancelRunContext } from "../extensions/cancel-run-handler";
import type { SpawnAssignmentContext } from "../extensions/spawn-assignment-handler";
import type { ExtensionPermissions } from "../extensions/types";
import type { AgentEvents } from "../types";
import type { AgentExecutor } from "../runtime/executor";
import type { SpawnQuota } from "../extensions/spawn-quota";
import type { EventBus as EventBusT } from "../runtime/events";

// ── Fixtures ───────────────────────────────────────────────────────

const EXT_A = "ext-cr-a";
const EXT_B = "ext-cr-b";
const CONV = "conv-cr";

function makePerms(
  spawnAgents?: { maxPerHour: number; maxConcurrent?: number },
): ExtensionPermissions {
  return { ...(spawnAgents ? { spawnAgents } : {}), grantedAt: {} };
}

interface FakeExecutor {
  cancelRun: (id: string) => boolean;
  calls: string[];
  scripted: Map<string, boolean>;
}

function makeFakeExecutor(scripted: Record<string, boolean> = {}): FakeExecutor {
  const calls: string[] = [];
  const map = new Map(Object.entries(scripted));
  return {
    calls,
    scripted: map,
    cancelRun(id: string): boolean {
      calls.push(id);
      // Default: true (run existed and was cancelled) unless scripted otherwise.
      return map.has(id) ? map.get(id)! : true;
    },
  };
}

function makeCancelCtx(overrides: {
  grantedPermissions?: ExtensionPermissions;
  executor: FakeExecutor;
  quota: SpawnQuota;
  userId?: string;
  engine?: CancelRunContext["engine"];
  conversationId?: string;
}): CancelRunContext {
  return {
    userId: overrides.userId ?? "user-cr",
    grantedPermissions:
      overrides.grantedPermissions ?? makePerms({ maxPerHour: 10, maxConcurrent: 3 }),
    executor: overrides.executor as unknown as AgentExecutor,
    quota: overrides.quota,
    ...(overrides.engine ? { engine: overrides.engine } : {}),
    ...(overrides.conversationId ? { conversationId: overrides.conversationId } : {}),
  };
}

function rpc(params: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/cancel-run", params };
}

async function ensureExtension(id: string): Promise<void> {
  await getDb()
    .insert(extensionsTable)
    .values({
      id,
      name: id,
      version: "1.0.0",
      description: "t",
      manifest: {
        schemaVersion: 2,
        name: id,
        version: "1.0.0",
        description: "t",
        author: { name: "t" },
        permissions: {},
      },
      source: `test:${id}`,
      installPath: `/tmp/${id}`,
      enabled: true,
    } as any)
    .onConflictDoNothing();
}

async function wireConversation(convId: string, extId: string): Promise<void> {
  await ensureExtension(extId);
  await getDb()
    .insert(conversationExtensions)
    .values({ conversationId: convId, extensionId: extId } as any)
    .onConflictDoNothing();
}

async function lastCancelAudit(
  extId: string,
): Promise<Record<string, unknown> | undefined> {
  const { and, eq, desc } = await import("drizzle-orm");
  const rows = await getDb()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.target, extId), eq(auditLog.action, "ext:spawn-cancelled")))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return rows[0] as any;
}

beforeAll(async () => {
  await setupTestDb();
  await getDb()
    .insert(users)
    .values({ id: "user-cr", email: "cr@t.local", passwordHash: "x", name: "CR" } as any)
    .onConflictDoNothing();
  await getDb()
    .insert(projects)
    .values({ id: "proj-cr", name: "proj-cr", path: "/tmp/proj-cr" } as any);
  await getDb()
    .insert(conversations)
    .values({ id: CONV, projectId: "proj-cr", title: "cr" } as any);
  await wireConversation(CONV, EXT_A);
  await wireConversation(CONV, EXT_B);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

afterEach(() => {
  delete process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
});

// ── Tests ──────────────────────────────────────────────────────────

describe("cancel-run — permission gate", () => {
  test("spawnAgents not granted → -32001", async () => {
    const bus = new EventBus<AgentEvents>();
    const quota = createSpawnQuota(bus);
    const executor = makeFakeExecutor();
    const resp = await handleCancelRunRpc(
      EXT_A,
      rpc({ v: 1, agentRunId: "run-x" }, "p1"),
      makeCancelCtx({
        grantedPermissions: makePerms(), // no spawnAgents
        executor,
        quota,
      }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(executor.calls).toHaveLength(0);
  });

  test("kill-switch → -32001 even with permission granted", async () => {
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "1";
    const bus = new EventBus<AgentEvents>();
    const quota = createSpawnQuota(bus);
    const executor = makeFakeExecutor();
    const resp = await handleCancelRunRpc(
      EXT_A,
      rpc({ v: 1, agentRunId: "run-x" }, "p2"),
      makeCancelCtx({ executor, quota }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(executor.calls).toHaveLength(0);
  });
});

describe("cancel-run — payload validation", () => {
  test("missing agentRunId → -32602", async () => {
    const bus = new EventBus<AgentEvents>();
    const quota = createSpawnQuota(bus);
    const executor = makeFakeExecutor();
    const resp = await handleCancelRunRpc(
      EXT_A,
      rpc({ v: 1 }, "v1"),
      makeCancelCtx({ executor, quota }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(executor.calls).toHaveLength(0);
  });
});

describe("cancel-run — ownership gate", () => {
  test("agentRunId belongs to another extension → { cancelled: false, reason: 'not-owned' }", async () => {
    const bus = new EventBus<AgentEvents>();
    const quota = createSpawnQuota(bus);
    const executor = makeFakeExecutor();

    // B owns run-b-1; A tries to cancel it.
    quota.reserve(EXT_B, "run-b-1");
    const before = quota._concurrentCount(EXT_B);

    const resp = await handleCancelRunRpc(
      EXT_A,
      rpc({ v: 1, agentRunId: "run-b-1" }, "own-1"),
      makeCancelCtx({ executor, quota }),
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ v: 1, cancelled: false, reason: "not-owned" });
    // Executor never called — no side-effect on B's reservation.
    expect(executor.calls).toHaveLength(0);
    expect(quota._concurrentCount(EXT_B)).toBe(before);

    const audit = await lastCancelAudit(EXT_A);
    expect(audit?.metadata).toMatchObject({ reason: "not-owned", agentRunId: "run-b-1" });
  });
});

describe("cancel-run — happy path", () => {
  test("caller owns run; executor cancels → { cancelled: true } + slot released + audit", async () => {
    const bus = new EventBus<AgentEvents>();
    const quota = createSpawnQuota(bus);
    const executor = makeFakeExecutor(); // default true

    quota.reserve(EXT_A, "run-a-1");
    expect(quota._concurrentCount(EXT_A)).toBe(1);
    expect(quota.isOwner(EXT_A, "run-a-1")).toBe(true);

    const resp = await handleCancelRunRpc(
      EXT_A,
      rpc({ v: 1, agentRunId: "run-a-1" }, "hp-1"),
      makeCancelCtx({ executor, quota }),
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ v: 1, cancelled: true });
    expect(executor.calls).toEqual(["run-a-1"]);
    // Slot released synchronously.
    expect(quota._concurrentCount(EXT_A)).toBe(0);
    expect(quota.isOwner(EXT_A, "run-a-1")).toBe(false);

    const audit = await lastCancelAudit(EXT_A);
    expect(audit?.metadata).toMatchObject({ reason: "cancelled", agentRunId: "run-a-1" });
    // Tight audit-row shape assertion (§5.3 audit gap #4 — don't just
    // check the handler wrote *something*, check the fixed columns too).
    expect(audit?.target).toBe(EXT_A);
    expect(audit?.action).toBe("ext:spawn-cancelled");
    expect(audit?.userId).toBe("user-cr");
  });
});

describe("cancel-run — missing run", () => {
  test("executor reports no such run → { cancelled: false, reason: 'missing-run' } + stale slot cleaned", async () => {
    const bus = new EventBus<AgentEvents>();
    const quota = createSpawnQuota(bus);
    // Scripted: executor returns false for this id (already torn down).
    const executor = makeFakeExecutor({ "run-a-stale": false });

    quota.reserve(EXT_A, "run-a-stale");
    expect(quota._concurrentCount(EXT_A)).toBe(1);

    const resp = await handleCancelRunRpc(
      EXT_A,
      rpc({ v: 1, agentRunId: "run-a-stale" }, "mr-1"),
      makeCancelCtx({ executor, quota }),
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ v: 1, cancelled: false, reason: "missing-run" });
    expect(executor.calls).toEqual(["run-a-stale"]);
    // Defensive cleanup: stale entry is removed from both the
    // concurrent-count tally AND the ownership map so a subsequent
    // cancel on the same id can't accidentally succeed. (Per §5.3 audit
    // gap #5 — missing-run defensive cleanup must clear `isOwner` too.)
    expect(quota._concurrentCount(EXT_A)).toBe(0);
    expect(quota.isOwner(EXT_A, "run-a-stale")).toBe(false);

    const audit = await lastCancelAudit(EXT_A);
    expect(audit?.metadata).toMatchObject({
      reason: "missing-run",
      agentRunId: "run-a-stale",
    });
    // Audit row shape — target is the acting extension, action is the
    // typed SPAWN_CANCELLED constant (ext:spawn-cancelled). `extensionId`
    // is redundant with `target` on the row; the key fact here is that
    // `target === extensionId` so permission audits can be filtered by
    // either without drift.
    expect(audit?.target).toBe(EXT_A);
    expect(audit?.action).toBe("ext:spawn-cancelled");
  });
});

// ── §5.3 slot-release-under-cap: the load-bearing invariant ───────

describe("cancel-run — slot release under concurrent cap (§5.3)", () => {
  test("spawn to cap, cancel one, next spawn succeeds immediately (no SPAWN_QUOTA_EXCEEDED)", async () => {
    // Use a fresh conversation + extension so this test doesn't share
    // the module-level rate-limit bucket with the permission-gate cases.
    const ext = `cr-cap-${crypto.randomUUID().slice(0, 8)}`;
    const convId = `conv-cr-cap-${crypto.randomUUID().slice(0, 8)}`;
    await getDb().insert(conversations).values({
      id: convId, projectId: "proj-cr", title: "cap",
    } as any);
    await wireConversation(convId, ext);

    const bus = new EventBus<AgentEvents>();
    const quota = createSpawnQuota(bus);
    const executor = makeFakeExecutor();

    // Smallest maxConcurrent that proves the invariant.
    const perms = makePerms({ maxPerHour: 100, maxConcurrent: 2 });
    const spawnCtx: SpawnAssignmentContext = {
      conversationId: convId,
      userId: "user-cr",
      projectId: "proj-cr",
      grantedPermissions: perms,
      executor: executor as unknown as AgentExecutor,
      bus: bus as unknown as EventBusT<AgentEvents>,
      quota,
      spawnDepth: 0,
    };

    const validSpawn = { v: 1, task: "go", agentConfigId: "cfg-cr-helper" };

    // Fill the cap.
    const s1 = await handleSpawnAssignmentRpc(
      ext,
      { jsonrpc: "2.0", id: "s1", method: "ezcorp/spawn-assignment", params: validSpawn },
      spawnCtx,
    );
    const s2 = await handleSpawnAssignmentRpc(
      ext,
      { jsonrpc: "2.0", id: "s2", method: "ezcorp/spawn-assignment", params: validSpawn },
      spawnCtx,
    );
    expect(s1.error).toBeUndefined();
    expect(s2.error).toBeUndefined();

    // 3rd spawn is blocked on concurrent-exceeded.
    const s3Blocked = await handleSpawnAssignmentRpc(
      ext,
      { jsonrpc: "2.0", id: "s3", method: "ezcorp/spawn-assignment", params: validSpawn },
      spawnCtx,
    );
    expect(s3Blocked.error?.code).toBe(-32000);
    expect((s3Blocked.error?.data as { reason: string }).reason).toBe("concurrent-exceeded");

    // Cancel the first. Grab its real agentRunId from the response.
    const firstRunId = (s1.result as { agentRunId: string }).agentRunId;
    const cancelResp = await handleCancelRunRpc(
      ext,
      rpc({ v: 1, agentRunId: firstRunId }, "c1"),
      makeCancelCtx({ grantedPermissions: perms, executor, quota }),
    );
    expect(cancelResp.error).toBeUndefined();
    expect(cancelResp.result).toEqual({ v: 1, cancelled: true });

    // Next spawn succeeds immediately — this is the §5.3 invariant.
    const s3Retry = await handleSpawnAssignmentRpc(
      ext,
      { jsonrpc: "2.0", id: "s3b", method: "ezcorp/spawn-assignment", params: validSpawn },
      spawnCtx,
    );
    expect(s3Retry.error).toBeUndefined();
  });
});

// ── Phase 6: PDP-deny path + quota-invalid audit reason ─────────────

describe("cancel-run — Phase 6 PDP-deny + quota-invalid reason", () => {
  test("ctx.engine returns deny → -32001 + audit permission-missing", async () => {
    const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");
    const engine = createStubPermissionEngine("deny-all");
    const ext = `pdp-deny-cr-${crypto.randomUUID().slice(0, 8)}`;
    await ensureExtension(ext);
    const bus = new EventBus<AgentEvents>();
    const quota = createSpawnQuota(bus);
    const executor = makeFakeExecutor();
    const resp = await handleCancelRunRpc(
      ext,
      rpc({ v: 1, agentRunId: "any-run-id" }, "pdp-deny-1"),
      makeCancelCtx({ executor, quota, engine }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toContain("spawnAgents permission not granted");
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0]!.needed).toEqual([{ kind: "ezcorp:agent:spawn" }]);
  });

  test("PDP allows + invalid quota → -32001 'quota config invalid' + audit quota-invalid", async () => {
    const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");
    const engine = createStubPermissionEngine("allow-all");
    const ext = `qi-cr-${crypto.randomUUID().slice(0, 8)}`;
    await ensureExtension(ext);
    const bus = new EventBus<AgentEvents>();
    const quota = createSpawnQuota(bus);
    const executor = makeFakeExecutor();
    const resp = await handleCancelRunRpc(
      ext,
      rpc({ v: 1, agentRunId: "any-run-id" }, "qi-1"),
      makeCancelCtx({
        executor,
        quota,
        engine,
        // PDP allows but the grant blob is structurally degenerate.
        grantedPermissions: makePerms({ maxPerHour: 0 }),
      }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toContain("quota config invalid");
    const a = await lastCancelAudit(ext);
    expect(a?.metadata).toMatchObject({ reason: "quota-invalid" });
  });
});
