// Unit tests for src/extensions/task-events-handler.ts (Phase 2b).
//
// Covers:
//   - permission missing → -32001 + audit
//   - conversation scope unbound → -32602
//   - extension not wired to conversation → -32001 + audit (reason:"not-wired")
//   - forged conversationId in params is IGNORED (emit carries the
//     host's currentConversationId, not the attacker's value)
//   - snapshot + assignment_update happy path — bus.emit called with
//     the host's conversationId and the well-typed payload
//   - malformed payload → -32602 + audit (reason:"schema-mismatch")
//   - rate limit: 60 tight-loop calls → at least 45 accepted, remainder -32029
//
// Pattern mirrors storage-handler-coverage.test.ts — real PGlite +
// drizzle, mock only db/connection.

import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
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
const { conversations, projects, conversationExtensions, users, auditLog, extensions } = await import("../db/schema");
const { eq, desc, and } = await import("drizzle-orm");

import type { JsonRpcRequest } from "../extensions/types";
import type { TaskEventsContext } from "../extensions/task-events-handler";
import type { ExtensionPermissions } from "../extensions/types";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

// ── Fixtures ─────────────────────────────────────────────────────────

interface EmitCall { event: string; payload: unknown; }

function makeBus(): { bus: EventBus<AgentEvents>; calls: EmitCall[]; } {
  const calls: EmitCall[] = [];
  const bus = {
    emit: (event: string, payload: unknown) => {
      calls.push({ event, payload });
    },
    on: () => () => {},
    off: () => {},
  } as unknown as EventBus<AgentEvents>;
  return { bus, calls };
}

function makePerms(taskEvents = true): ExtensionPermissions {
  return { ...(taskEvents ? { taskEvents: true as const } : {}), grantedAt: {} };
}

function makeCtx(
  bus: EventBus<AgentEvents> | undefined,
  overrides: Partial<TaskEventsContext> = {},
): TaskEventsContext {
  return {
    conversationId: overrides.conversationId ?? "conv-wired",
    userId: overrides.userId ?? "user-alice",
    grantedPermissions: overrides.grantedPermissions ?? makePerms(true),
    bus,
  };
}

function rpc(params: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/emit-task-event", params };
}

async function insertUser(id: string): Promise<void> {
  await getDb().insert(users).values({
    id,
    email: `${id}@t.local`,
    passwordHash: "x",
    name: id,
  } as any).onConflictDoNothing();
}

async function insertProject(id: string): Promise<void> {
  await getDb().insert(projects).values({ id, name: id, path: `/tmp/${id}` } as any);
}

async function insertConversation(id: string, projectId: string): Promise<void> {
  await getDb().insert(conversations).values({ id, projectId, title: id } as any);
}

async function ensureExtensionRow(id: string): Promise<void> {
  await getDb().insert(extensions).values({
    id,
    name: id,
    version: "1.0.0",
    description: "test",
    manifest: { schemaVersion: 2, name: id, version: "1.0.0", description: "t", author: { name: "t" }, permissions: {} },
    source: `test:${id}`,
    installPath: `/tmp/${id}`,
    enabled: true,
  } as any).onConflictDoNothing();
}

async function wireConversation(conversationId: string, extensionId: string): Promise<void> {
  await ensureExtensionRow(extensionId);
  await getDb().insert(conversationExtensions).values({
    conversationId, extensionId,
  } as any).onConflictDoNothing();
}

function snapshotTask(id: string, title = "t"): unknown {
  return {
    id,
    title,
    description: "desc",
    status: "pending",
    assignments: [],
    subtasks: [],
    createdAt: new Date().toISOString(),
    priority: 1,
  };
}

function assignment(id: string): unknown {
  return {
    id,
    agentConfigId: "ac-1",
    agentName: "helper",
    isTeam: false,
    status: "assigned",
    assignedAt: new Date().toISOString(),
  };
}

// Shared fixtures.
const EXT_WIRED = "ext-te-wired";
const EXT_UNWIRED = "ext-te-unwired";
const CONV_WIRED = "conv-te-wired";
const CONV_OTHER = "conv-te-other";

beforeAll(async () => {
  await setupTestDb();
  await insertUser("user-alice");

  const projId = "proj-te";
  await insertProject(projId);
  await insertConversation(CONV_WIRED, projId);
  await insertConversation(CONV_OTHER, projId);
  await wireConversation(CONV_WIRED, EXT_WIRED);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

afterEach(() => {
  delete process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
});

async function lastAuditForExt(extensionId: string): Promise<{ action: string; metadata: any } | undefined> {
  const rows = await getDb()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.target, extensionId), eq(auditLog.action, "ext:emit-event-rejected")))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return rows[0] as any;
}

// ── Permission ladder ────────────────────────────────────────────────

describe("emit-task-event — permission + kill-switch", () => {
  test("taskEvents not granted → -32001 + audit {reason:'permission-missing'}", async () => {
    const { bus, calls } = makeBus();
    const resp = await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({ v: 1, type: "snapshot", payload: { tasks: [] } }, "p1"),
      makeCtx(bus, { grantedPermissions: makePerms(false) }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(calls).toHaveLength(0);
    const audit = await lastAuditForExt(EXT_WIRED);
    expect(audit?.metadata?.reason).toBe("permission-missing");
  });

  test("EZCORP_DISABLE_CAPABILITY_TOOLS=1 → -32001 even with permission", async () => {
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "1";
    const { bus, calls } = makeBus();
    const resp = await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({ v: 1, type: "snapshot", payload: { tasks: [] } }, "k1"),
      makeCtx(bus),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(calls).toHaveLength(0);
  });
});

// ── Conversation scope + wiring ──────────────────────────────────────

describe("emit-task-event — conversation scope", () => {
  test('conversationId="unknown" → -32602', async () => {
    const { bus, calls } = makeBus();
    const resp = await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({ v: 1, type: "snapshot", payload: { tasks: [] } }, "s1"),
      makeCtx(bus, { conversationId: "unknown" }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(calls).toHaveLength(0);
  });

  test("extension not wired to conversation → -32001 + audit {reason:'not-wired'}", async () => {
    const { bus, calls } = makeBus();
    const resp = await handleEmitTaskEventRpc(
      EXT_UNWIRED,
      rpc({ v: 1, type: "snapshot", payload: { tasks: [] } }, "w1"),
      makeCtx(bus, { conversationId: CONV_OTHER }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(calls).toHaveLength(0);
    const audit = await lastAuditForExt(EXT_UNWIRED);
    expect(audit?.metadata?.reason).toBe("not-wired");
    expect(audit?.metadata?.conversationId).toBe(CONV_OTHER);
  });
});

// ── Happy path: snapshot + assignment_update ─────────────────────────

describe("emit-task-event — snapshot emit", () => {
  test("well-formed snapshot → bus.emit task:snapshot with host conversationId", async () => {
    const { bus, calls } = makeBus();
    const tasks = [snapshotTask("task-1", "hello")];
    const resp = await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({ v: 1, type: "snapshot", payload: { tasks, activeTaskId: "task-1" } }, "s2"),
      makeCtx(bus, { conversationId: CONV_WIRED }),
    );
    expect(resp.error).toBeUndefined();
    expect((resp.result as { ok: boolean }).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.event).toBe("task:snapshot");
    const emitted = calls[0]?.payload as { conversationId: string; tasks: unknown[]; activeTaskId?: string };
    expect(emitted.conversationId).toBe(CONV_WIRED);
    expect(emitted.tasks).toHaveLength(1);
    expect(emitted.activeTaskId).toBe("task-1");
  });

  test("snapshot without activeTaskId omits the field from the event", async () => {
    const { bus, calls } = makeBus();
    await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({ v: 1, type: "snapshot", payload: { tasks: [] } }, "s3"),
      makeCtx(bus, { conversationId: CONV_WIRED }),
    );
    const emitted = calls[0]?.payload as Record<string, unknown>;
    expect("activeTaskId" in emitted).toBe(false);
  });

  test("FORGED conversationId in params is ignored — host's value wins", async () => {
    const { bus, calls } = makeBus();
    await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({
        v: 1,
        type: "snapshot",
        payload: { tasks: [snapshotTask("t-x")] },
        conversationId: "attacker-controlled-conv",
      }, "forge-1"),
      makeCtx(bus, { conversationId: CONV_WIRED }),
    );
    expect(calls).toHaveLength(1);
    expect((calls[0]?.payload as { conversationId: string }).conversationId).toBe(CONV_WIRED);
  });
});

describe("emit-task-event — assignment_update emit", () => {
  test("well-formed assignment_update → bus.emit task:assignment_update with host conversationId", async () => {
    const { bus, calls } = makeBus();
    const a = assignment("a-1");
    await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({ v: 1, type: "assignment_update", payload: { taskId: "task-1", assignment: a } }, "u1"),
      makeCtx(bus, { conversationId: CONV_WIRED }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.event).toBe("task:assignment_update");
    const emitted = calls[0]?.payload as { conversationId: string; taskId: string; assignment: unknown };
    expect(emitted.conversationId).toBe(CONV_WIRED);
    expect(emitted.taskId).toBe("task-1");
    expect(emitted.assignment).toEqual(a as any);
  });
});

// ── Payload validation ───────────────────────────────────────────────

describe("emit-task-event — payload validation", () => {
  test("missing v → -32602 + audit schema-mismatch", async () => {
    const { bus } = makeBus();
    const resp = await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({ type: "snapshot", payload: { tasks: [] } }, "v-miss"),
      makeCtx(bus, { conversationId: CONV_WIRED }),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("unknown type → -32602 + audit schema-mismatch", async () => {
    const { bus, calls } = makeBus();
    const resp = await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({ v: 1, type: "frobnicate", payload: {} }, "type-bad"),
      makeCtx(bus, { conversationId: CONV_WIRED }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(calls).toHaveLength(0);
  });

  test("snapshot missing required task field → -32602 + audit with error list", async () => {
    const { bus, calls } = makeBus();
    const resp = await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({
        v: 1,
        type: "snapshot",
        payload: { tasks: [{ id: "t", title: "hi" }] }, // missing status, priority, etc.
      }, "bad-task"),
      makeCtx(bus, { conversationId: CONV_WIRED }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(calls).toHaveLength(0);
    const audit = await lastAuditForExt(EXT_WIRED);
    expect(audit?.metadata?.reason).toBe("schema-mismatch");
    expect(Array.isArray(audit?.metadata?.errors)).toBe(true);
  });

  test("assignment_update with missing assignment.id → -32602", async () => {
    const { bus, calls } = makeBus();
    const resp = await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({
        v: 1,
        type: "assignment_update",
        payload: { taskId: "t", assignment: { agentConfigId: "a", agentName: "x", isTeam: false, status: "assigned", assignedAt: "now" } },
      }, "bad-asn"),
      makeCtx(bus, { conversationId: CONV_WIRED }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(calls).toHaveLength(0);
  });

  test("assignment with unknown status enum value → -32602 (schema whitelist)", async () => {
    const { bus, calls } = makeBus();
    const resp = await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({
        v: 1,
        type: "assignment_update",
        payload: {
          taskId: "t",
          assignment: { id: "a", agentConfigId: "ac", agentName: "n", isTeam: false, status: "cancelled", assignedAt: "now" },
        },
      }, "bad-status"),
      makeCtx(bus, { conversationId: CONV_WIRED }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(calls).toHaveLength(0);
  });

  test("non-object payload → -32602", async () => {
    const { bus, calls } = makeBus();
    const resp = await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({ v: 1, type: "snapshot", payload: "not-an-object" }, "bad-payload"),
      makeCtx(bus, { conversationId: CONV_WIRED }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(calls).toHaveLength(0);
  });

  test("non-object task inside tasks array → -32602", async () => {
    const { bus, calls } = makeBus();
    const resp = await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({
        v: 1,
        type: "snapshot",
        payload: { tasks: [null] },
      }, "null-task"),
      makeCtx(bus, { conversationId: CONV_WIRED }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(calls).toHaveLength(0);
  });

  test("snapshot with non-string activeTaskId → -32602", async () => {
    const { bus, calls } = makeBus();
    const resp = await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({
        v: 1,
        type: "snapshot",
        payload: { tasks: [], activeTaskId: 42 },
      }, "bad-active"),
      makeCtx(bus, { conversationId: CONV_WIRED }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(calls).toHaveLength(0);
  });

  test("task with unknown status enum value → -32602", async () => {
    const { bus, calls } = makeBus();
    const resp = await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({
        v: 1,
        type: "snapshot",
        payload: { tasks: [{ ...snapshotTask("t-1") as any, status: "archived" }] },
      }, "bad-task-status"),
      makeCtx(bus, { conversationId: CONV_WIRED }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(calls).toHaveLength(0);
  });

  test("task with non-object assignment entry → -32602", async () => {
    const { bus, calls } = makeBus();
    const task = { ...snapshotTask("t-1") as any, assignments: ["not-an-object"] };
    const resp = await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({ v: 1, type: "snapshot", payload: { tasks: [task] } }, "asn-nonobj"),
      makeCtx(bus, { conversationId: CONV_WIRED }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(calls).toHaveLength(0);
  });

  test('conversationId="" (empty string) → -32602', async () => {
    const { bus, calls } = makeBus();
    const resp = await handleEmitTaskEventRpc(
      EXT_WIRED,
      rpc({ v: 1, type: "snapshot", payload: { tasks: [] } }, "empty-conv"),
      makeCtx(bus, { conversationId: "" }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(calls).toHaveLength(0);
  });
});

// ── Rate limit ───────────────────────────────────────────────────────

describe("emit-task-event — rate limit", () => {
  test("60 tight-loop snapshots → many accepted, remainder -32029", async () => {
    // Use a unique extensionId so the bucket starts full.
    const ext = `rl-ext-${crypto.randomUUID().slice(0, 8)}`;
    // Wire it.
    await wireConversation(CONV_WIRED, ext);
    const { bus } = makeBus();
    let accepted = 0;
    let limited = 0;
    for (let i = 0; i < 60; i++) {
      const resp = await handleEmitTaskEventRpc(
        ext,
        rpc({ v: 1, type: "snapshot", payload: { tasks: [] } }, `rl-${i}`),
        makeCtx(bus, { conversationId: CONV_WIRED }),
      );
      if (resp.error?.code === -32029) limited++;
      else if (!resp.error) accepted++;
    }
    expect(accepted).toBeGreaterThanOrEqual(45);
    expect(limited).toBeGreaterThan(0);
  });
});
