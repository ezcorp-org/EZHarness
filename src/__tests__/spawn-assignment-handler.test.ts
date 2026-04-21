// Unit tests for src/extensions/spawn-assignment-handler.ts (Phase 2d).
//
// Covers the full enforcement ladder plus the dispatch path. Mocks:
//   - `startAssignment` via mock.module — returns a fixed
//     {subConversationId, agentRunId} without touching streamChat.
//   - `listAgentConfigs` via mock.module — returns the fixture set.
//   - Real PGlite for conversation_extensions + conversations.metadata
//     so the wiring-copy + spawn-depth persistence are verified
//     end-to-end.

import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { mock } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Module mocks (must be before the handler import) ────────────────

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

// startAssignment is the dispatch primitive; fake it so we never touch
// the real executor / streamChat path. Seed the sub-conversation row so
// FK-dependent writes (copyConversationExtensions, setConversationSpawnDepth)
// in the handler's post-dispatch phase succeed.
let nextAgentRunId = 1;
const startAssignmentCalls: Array<Record<string, unknown>> = [];
mock.module("../runtime/start-assignment", () => ({
  startAssignment: async (opts: Record<string, unknown>) => {
    startAssignmentCalls.push(opts);
    const runId = `run-${nextAgentRunId++}`;
    // Honor a pre-resolved reuse id (Phase 4 `reuseSubConversationFor`
    // path); otherwise fall back to a freshly-minted sub id.
    const subConversationId =
      typeof opts.reuseSubConversationId === "string" && opts.reuseSubConversationId
        ? (opts.reuseSubConversationId as string)
        : `sub-${runId}`;
    const assignment = opts.assignment as { id: string; status: string; agentRunId?: string; subConversationId?: string; startedAt?: string };
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
      title: "sub",
    } as any).onConflictDoNothing();
    return { subConversationId, agentRunId: runId };
  },
}));

// Fixture agent configs. The handler routes through resolveAgentConfigForUser
// → listAgentConfigs, so mock at that layer.
const FIXTURE_CONFIGS = [
  {
    id: "cfg-alice-helper",
    name: "alice-helper",
    description: "Alice's helper",
    prompt: "p",
    capabilities: ["llm"],
    references: { agents: [], extensions: [] },
    userId: "user-alice",
    model: null,
    provider: null,
  },
];
mock.module("../db/queries/agent-configs", () => ({
  listAgentConfigs: async (_userId?: string) => FIXTURE_CONFIGS,
}));

// Dynamic imports AFTER mocks are registered.
const { handleSpawnAssignmentRpc, MAX_SPAWN_DEPTH } = await import("../extensions/spawn-assignment-handler");
const { createSpawnQuota } = await import("../extensions/spawn-quota");
const { EventBus } = await import("../runtime/events");
const { getDb } = await import("../db/connection");
const { conversations, extensions: extensionsTable, projects, users, conversationExtensions, auditLog } =
  await import("../db/schema");

import type { JsonRpcRequest } from "../extensions/types";
import type { SpawnAssignmentContext } from "../extensions/spawn-assignment-handler";
import type { ExtensionPermissions } from "../extensions/types";
import type { AgentEvents } from "../types";
import type { AgentExecutor } from "../runtime/executor";

// ── Fixtures ───────────────────────────────────────────────────────

const EXT_WIRED = "ext-sa-wired";
const EXT_UNWIRED = "ext-sa-unwired";
const CONV_WIRED = "conv-sa-wired";

function makePerms(spawnAgents?: { maxPerHour: number; maxConcurrent?: number }): ExtensionPermissions {
  return { ...(spawnAgents ? { spawnAgents } : {}), grantedAt: {} };
}

function makeCtx(
  overrides: Partial<SpawnAssignmentContext> = {},
): SpawnAssignmentContext {
  const bus = new EventBus<AgentEvents>();
  const quota = createSpawnQuota(bus);
  return {
    conversationId: overrides.conversationId ?? CONV_WIRED,
    userId: overrides.userId ?? "user-alice",
    projectId: overrides.projectId !== undefined ? overrides.projectId : "proj-sa",
    grantedPermissions: overrides.grantedPermissions ?? makePerms({ maxPerHour: 10, maxConcurrent: 3 }),
    executor: overrides.executor ?? ({} as unknown as AgentExecutor),
    bus: overrides.bus ?? bus,
    quota: overrides.quota ?? quota,
    spawnDepth: overrides.spawnDepth ?? 0,
    ...(overrides.parentModel !== undefined ? { parentModel: overrides.parentModel } : {}),
    ...(overrides.parentProvider !== undefined ? { parentProvider: overrides.parentProvider } : {}),
  };
}

function rpc(params: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/spawn-assignment", params };
}

async function ensureExtension(id: string): Promise<void> {
  await getDb().insert(extensionsTable).values({
    id,
    name: id,
    version: "1.0.0",
    description: "t",
    manifest: { schemaVersion: 2, name: id, version: "1.0.0", description: "t", author: { name: "t" }, permissions: {} },
    source: `test:${id}`,
    installPath: `/tmp/${id}`,
    enabled: true,
  } as any).onConflictDoNothing();
}

async function wireConversation(convId: string, extId: string): Promise<void> {
  await ensureExtension(extId);
  await getDb().insert(conversationExtensions).values({ conversationId: convId, extensionId: extId } as any).onConflictDoNothing();
}

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values({
    id: "user-alice", email: "a@t.local", passwordHash: "x", name: "Alice",
  } as any).onConflictDoNothing();
  await getDb().insert(projects).values({
    id: "proj-sa", name: "proj-sa", path: "/tmp/proj-sa",
  } as any);
  await getDb().insert(conversations).values({
    id: CONV_WIRED, projectId: "proj-sa", title: "sa",
  } as any);
  await wireConversation(CONV_WIRED, EXT_WIRED);
  await ensureExtension(EXT_UNWIRED);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

afterEach(() => {
  delete process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
  startAssignmentCalls.length = 0;
});

async function lastAudit(extId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await getDb()
    .select()
    .from(auditLog)
    .where((await import("drizzle-orm")).and(
      (await import("drizzle-orm")).eq(auditLog.target, extId),
      (await import("drizzle-orm")).eq(auditLog.action, "ext:spawn-quota-exceeded"),
    ))
    .orderBy((await import("drizzle-orm")).desc(auditLog.createdAt))
    .limit(1);
  return rows[0] as any;
}

// ── Enforcement ladder ─────────────────────────────────────────────

describe("spawn-assignment — kill-switch + permission", () => {
  const validParams = { v: 1, task: "hi", agentConfigId: "cfg-alice-helper" };

  test("kill-switch → -32001 + audit permission-missing", async () => {
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "1";
    const resp = await handleSpawnAssignmentRpc(EXT_WIRED, rpc(validParams, "k1"), makeCtx());
    expect(resp.error?.code).toBe(-32001);
    expect(startAssignmentCalls).toHaveLength(0);
    const a = await lastAudit(EXT_WIRED);
    expect(a?.metadata).toMatchObject({ reason: "permission-missing" });
  });

  test("spawnAgents not granted → -32001 + audit", async () => {
    const resp = await handleSpawnAssignmentRpc(
      EXT_WIRED,
      rpc(validParams, "p1"),
      makeCtx({ grantedPermissions: makePerms() }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(startAssignmentCalls).toHaveLength(0);
  });

  test("maxPerHour === 0 → -32001 (degenerate grant)", async () => {
    const resp = await handleSpawnAssignmentRpc(
      EXT_WIRED,
      rpc(validParams, "p2"),
      makeCtx({ grantedPermissions: makePerms({ maxPerHour: 0 }) }),
    );
    expect(resp.error?.code).toBe(-32001);
  });
});

describe("spawn-assignment — scope gates", () => {
  const validParams = { v: 1, task: "hi", agentConfigId: "cfg-alice-helper" };

  test('conversationId="unknown" → -32602', async () => {
    const resp = await handleSpawnAssignmentRpc(
      EXT_WIRED, rpc(validParams, "s1"),
      makeCtx({ conversationId: "unknown" }),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("projectId=null → -32602", async () => {
    const resp = await handleSpawnAssignmentRpc(
      EXT_WIRED, rpc(validParams, "s2"),
      makeCtx({ projectId: null }),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("extension not wired → -32001 + audit not-wired", async () => {
    const resp = await handleSpawnAssignmentRpc(
      EXT_UNWIRED, rpc(validParams, "s3"), makeCtx(),
    );
    expect(resp.error?.code).toBe(-32001);
    const a = await lastAudit(EXT_UNWIRED);
    expect(a?.metadata).toMatchObject({ reason: "not-wired" });
  });
});

describe("spawn-assignment — rate + depth", () => {
  const validParams = { v: 1, task: "hi", agentConfigId: "cfg-alice-helper" };

  test("60 tight-loop requests → ~50 accepted, remainder -32029 + audit rate-limited", async () => {
    const ext = `rl-ext-${crypto.randomUUID().slice(0, 8)}`;
    await wireConversation(CONV_WIRED, ext);
    let accepted = 0;
    let limited = 0;
    for (let i = 0; i < 60; i++) {
      const resp = await handleSpawnAssignmentRpc(ext, rpc(validParams, `rl-${i}`), makeCtx());
      if (resp.error?.code === -32029) limited++;
      else if (!resp.error) accepted++;
    }
    expect(accepted).toBeGreaterThanOrEqual(45);
    expect(limited).toBeGreaterThan(0);
  });

  test("spawnDepth >= MAX_SPAWN_DEPTH → -32000 + audit depth-exceeded", async () => {
    const resp = await handleSpawnAssignmentRpc(
      EXT_WIRED, rpc(validParams, "d1"),
      makeCtx({ spawnDepth: MAX_SPAWN_DEPTH }),
    );
    expect(resp.error?.code).toBe(-32000);
    expect(resp.error?.message).toMatch(/Spawn depth/);
  });
});

describe("spawn-assignment — payload validation", () => {
  test("missing v → -32602", async () => {
    const resp = await handleSpawnAssignmentRpc(
      EXT_WIRED,
      rpc({ task: "hi", agentConfigId: "cfg-alice-helper" }, "v-miss"),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("empty task → -32602", async () => {
    const resp = await handleSpawnAssignmentRpc(
      EXT_WIRED,
      rpc({ v: 1, task: "   ", agentConfigId: "cfg-alice-helper" }, "t-empty"),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("missing both agentConfigId and agentName → -32602", async () => {
    const resp = await handleSpawnAssignmentRpc(
      EXT_WIRED, rpc({ v: 1, task: "hi" }, "a-miss"), makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("unknown agent → -32602 'Agent not found'", async () => {
    const resp = await handleSpawnAssignmentRpc(
      EXT_WIRED,
      rpc({ v: 1, task: "hi", agentConfigId: "nonexistent" }, "a-unk"),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toMatch(/Agent not found/);
  });
});

describe("spawn-assignment — quota", () => {
  const validParams = { v: 1, task: "hi", agentConfigId: "cfg-alice-helper" };

  test("maxPerHour exceeded → -32000 with data.reason=hourly-exceeded", async () => {
    const ext = `hq-ext-${crypto.randomUUID().slice(0, 8)}`;
    await wireConversation(CONV_WIRED, ext);
    const ctx = makeCtx({
      grantedPermissions: makePerms({ maxPerHour: 2, maxConcurrent: 10 }),
    });
    for (let i = 0; i < 2; i++) {
      const ok = await handleSpawnAssignmentRpc(ext, rpc(validParams, `hq-${i}`), ctx);
      expect(ok.error).toBeUndefined();
    }
    const over = await handleSpawnAssignmentRpc(ext, rpc(validParams, "hq-over"), ctx);
    expect(over.error?.code).toBe(-32000);
    expect((over.error?.data as { reason: string }).reason).toBe("hourly-exceeded");
  });

  test("maxConcurrent exceeded → -32000 with data.reason=concurrent-exceeded", async () => {
    const ext = `cc-ext-${crypto.randomUUID().slice(0, 8)}`;
    await wireConversation(CONV_WIRED, ext);
    const ctx = makeCtx({
      grantedPermissions: makePerms({ maxPerHour: 100, maxConcurrent: 2 }),
    });
    const a = await handleSpawnAssignmentRpc(ext, rpc(validParams, "cc-1"), ctx);
    const b = await handleSpawnAssignmentRpc(ext, rpc(validParams, "cc-2"), ctx);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    const c = await handleSpawnAssignmentRpc(ext, rpc(validParams, "cc-3"), ctx);
    expect(c.error?.code).toBe(-32000);
    expect((c.error?.data as { reason: string }).reason).toBe("concurrent-exceeded");
  });

  test("concurrent slot freed on bus run:complete → subsequent spawn succeeds", async () => {
    const ext = `cf-ext-${crypto.randomUUID().slice(0, 8)}`;
    await wireConversation(CONV_WIRED, ext);
    const ctx = makeCtx({
      grantedPermissions: makePerms({ maxPerHour: 100, maxConcurrent: 1 }),
    });
    const first = await handleSpawnAssignmentRpc(ext, rpc(validParams, "cf-1"), ctx);
    const firstRunId = (first.result as { agentRunId: string }).agentRunId;

    // Blocked while first is in flight.
    const blocked = await handleSpawnAssignmentRpc(ext, rpc(validParams, "cf-2"), ctx);
    expect(blocked.error?.code).toBe(-32000);

    // Release via bus.
    ctx.bus.emit("run:complete", { run: { id: firstRunId } } as AgentEvents["run:complete"]);
    const retry = await handleSpawnAssignmentRpc(ext, rpc(validParams, "cf-3"), ctx);
    expect(retry.error).toBeUndefined();
  });
});

// ── Dispatch path ──────────────────────────────────────────────────

describe("spawn-assignment — dispatch", () => {
  const validParams = { v: 1, task: "build a thing", agentConfigId: "cfg-alice-helper", title: "My task" };

  test("happy path returns {subConvId, agentRunId, taskId, assignmentId}; startAssignment called with parent conversationId", async () => {
    const ext = `ok-ext-${crypto.randomUUID().slice(0, 8)}`;
    await wireConversation(CONV_WIRED, ext);
    const ctx = makeCtx();

    const resp = await handleSpawnAssignmentRpc(ext, rpc(validParams, "ok-1"), ctx);
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      v: number;
      subConversationId: string;
      agentRunId: string;
      taskId: string;
      assignmentId: string;
    };
    expect(result.v).toBe(1);
    expect(result.subConversationId).toMatch(/^sub-run-/);
    expect(result.agentRunId).toMatch(/^run-/);
    expect(result.taskId).toBeDefined();
    expect(result.assignmentId).toBeDefined();

    expect(startAssignmentCalls).toHaveLength(1);
    const call = startAssignmentCalls[0]!;
    expect(call.conversationId).toBe(CONV_WIRED);
    expect(call.projectId).toBe("proj-sa");
    const task = call.task as { title: string; description: string };
    expect(task.title).toBe("My task"); // param override
    expect(task.description).toBe("build a thing");
  });

  test("forged conversationId in params is IGNORED — sub-conv is parented on ctx.conversationId", async () => {
    const ext = `fo-ext-${crypto.randomUUID().slice(0, 8)}`;
    await wireConversation(CONV_WIRED, ext);
    const paramsWithForged = { ...validParams, conversationId: "attacker-conv" };
    const resp = await handleSpawnAssignmentRpc(
      ext,
      rpc(paramsWithForged, "fo-1"),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    const call = startAssignmentCalls[0]!;
    expect(call.conversationId).toBe(CONV_WIRED);
    expect(call.conversationId).not.toBe("attacker-conv");
  });

  test("sub-conversation inherits parent's conversation_extensions", async () => {
    // Seed the parent with an additional sibling wiring; the mocked
    // startAssignment seeds the sub-conv row so the handler's
    // copyConversationExtensions call lands cleanly.
    const ext = `wi-ext-${crypto.randomUUID().slice(0, 8)}`;
    const sib = `wi-sib-${crypto.randomUUID().slice(0, 8)}`;
    await wireConversation(CONV_WIRED, ext);
    await wireConversation(CONV_WIRED, sib);

    const resp = await handleSpawnAssignmentRpc(
      ext, rpc(validParams, "wi-1"), makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    const { subConversationId } = resp.result as { subConversationId: string };
    const { getConversationExtensionIds } = await import("../db/queries/conversation-extensions");
    const childWiring = await getConversationExtensionIds(subConversationId);
    expect(childWiring).toEqual(expect.arrayContaining([ext, sib]));
  });

  test("caller-provided taskId + assignmentId are threaded verbatim into the handle and snapshot", async () => {
    const ext = `pt-ext-${crypto.randomUUID().slice(0, 8)}`;
    await wireConversation(CONV_WIRED, ext);
    const callerTaskId = "caller-task-fixed";
    const callerAssignmentId = "caller-assignment-fixed";
    const resp = await handleSpawnAssignmentRpc(
      ext,
      rpc({ ...validParams, taskId: callerTaskId, assignmentId: callerAssignmentId }, "pt-1"),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as { taskId: string; assignmentId: string };
    expect(result.taskId).toBe(callerTaskId);
    expect(result.assignmentId).toBe(callerAssignmentId);
    const call = startAssignmentCalls[0]!;
    expect(call.taskId).toBe(callerTaskId);
    expect((call.assignment as { id: string }).id).toBe(callerAssignmentId);
  });

  test("missing taskId/assignmentId falls back to generated UUIDs (back-compat)", async () => {
    const ext = `gen-ext-${crypto.randomUUID().slice(0, 8)}`;
    await wireConversation(CONV_WIRED, ext);
    const resp = await handleSpawnAssignmentRpc(
      ext, rpc(validParams, "gen-1"), makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as { taskId: string; assignmentId: string };
    expect(result.taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.assignmentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("spawn depth persisted as ctx.spawnDepth + 1 on the child conversation", async () => {
    const ext = `dp-ext-${crypto.randomUUID().slice(0, 8)}`;
    await wireConversation(CONV_WIRED, ext);
    const resp = await handleSpawnAssignmentRpc(
      ext, rpc(validParams, "dp-1"), makeCtx({ spawnDepth: 5 }),
    );
    expect(resp.error).toBeUndefined();
    const { subConversationId } = resp.result as { subConversationId: string };
    const { getConversationSpawnDepth } = await import("../db/queries/conversations");
    expect(await getConversationSpawnDepth(subConversationId)).toBe(6);
  });
});

// ── Phase 4 additions: pass-through of new SpawnAssignmentInput fields ──

describe("spawn-assignment — Phase 4 pass-through fields", () => {
  const baseParams = { v: 1, task: "build a thing", agentConfigId: "cfg-alice-helper" };

  test("reuseSubConversationFor: pre-existing sub-conv with matching agentConfigId is reused", async () => {
    const ext = `reuse-ext-${crypto.randomUUID().slice(0, 8)}`;
    await wireConversation(CONV_WIRED, ext);

    // Seed the agent config row in DB so the sub-conv FK can reference it.
    // (The resolveAgentConfigForUser path uses a separate mock list — the
    // fixture id "cfg-alice-helper" is what the handler actually resolves.)
    const { agentConfigs } = await import("../db/schema");
    await getDb().insert(agentConfigs).values({
      id: "cfg-alice-helper",
      name: "alice-helper",
      prompt: "p",
      userId: "user-alice",
    } as any).onConflictDoNothing();

    const parentConv = `conv-reuse-${crypto.randomUUID().slice(0, 8)}`;
    const seededSubConvId = `seeded-sub-${crypto.randomUUID().slice(0, 8)}`;
    await getDb().insert(conversations).values({
      id: parentConv, projectId: "proj-sa", title: "parent",
    } as any);
    await getDb().insert(conversations).values({
      id: seededSubConvId,
      projectId: "proj-sa",
      parentConversationId: parentConv,
      agentConfigId: "cfg-alice-helper",
      title: "pre-existing",
    } as any);
    await wireConversation(parentConv, ext);

    const resp = await handleSpawnAssignmentRpc(
      ext,
      rpc({ ...baseParams, reuseSubConversationFor: "cfg-alice-helper" }, "reuse-1"),
      makeCtx({ conversationId: parentConv }),
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as { subConversationId: string };
    expect(result.subConversationId).toBe(seededSubConvId);
    // And the mock startAssignment saw the pre-resolved id.
    expect(startAssignmentCalls).toHaveLength(1);
    expect(startAssignmentCalls[0]!.reuseSubConversationId).toBe(seededSubConvId);
  });

  test("parentMessageId: forwarded into startAssignment opts", async () => {
    const ext = `pmid-ext-${crypto.randomUUID().slice(0, 8)}`;
    await wireConversation(CONV_WIRED, ext);
    const anchor = "msg-anchor-xyz";
    const resp = await handleSpawnAssignmentRpc(
      ext,
      rpc({ ...baseParams, parentMessageId: anchor }, "pmid-1"),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    expect(startAssignmentCalls).toHaveLength(1);
    expect(startAssignmentCalls[0]!.parentMessageId).toBe(anchor);
  });

  test("overrides: flat TeamMemberOverrides bundle forwarded to startAssignment", async () => {
    const ext = `ov-ext-${crypto.randomUUID().slice(0, 8)}`;
    await wireConversation(CONV_WIRED, ext);
    const overrides = {
      model: "claude-3-5-sonnet",
      provider: "anthropic",
      systemPromptAppend: "Be concise.",
      permissionMode: "yolo",
      toolRestriction: "read-only",
      allowedTools: ["bash", "read"],
      deniedTools: ["write"],
      modeId: "mode-fast",
    };
    const resp = await handleSpawnAssignmentRpc(
      ext,
      rpc({ ...baseParams, overrides }, "ov-1"),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    expect(startAssignmentCalls).toHaveLength(1);
    expect(startAssignmentCalls[0]!.overrides).toEqual(overrides);
  });

  test("teamToolScope: forwarded to startAssignment", async () => {
    const ext = `tts-ext-${crypto.randomUUID().slice(0, 8)}`;
    await wireConversation(CONV_WIRED, ext);
    const teamToolScope = { allowedTools: ["read", "grep"], deniedTools: ["bash"] };
    const resp = await handleSpawnAssignmentRpc(
      ext,
      rpc({ ...baseParams, teamToolScope }, "tts-1"),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    expect(startAssignmentCalls).toHaveLength(1);
    expect(startAssignmentCalls[0]!.teamToolScope).toEqual(teamToolScope);
  });

  test("orchestrationDepth: forwarded to startAssignment as numeric value", async () => {
    const ext = `od-ext-${crypto.randomUUID().slice(0, 8)}`;
    await wireConversation(CONV_WIRED, ext);
    const resp = await handleSpawnAssignmentRpc(
      ext,
      rpc({ ...baseParams, orchestrationDepth: 3 }, "od-1"),
      makeCtx(),
    );
    expect(resp.error).toBeUndefined();
    expect(startAssignmentCalls).toHaveLength(1);
    expect(startAssignmentCalls[0]!.orchestrationDepth).toBe(3);
  });
});
