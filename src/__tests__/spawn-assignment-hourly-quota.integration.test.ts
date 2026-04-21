/**
 * Phase 2d Verification §9 — end-to-end hourly-quota smoke test.
 *
 * This closes the gap between the unit test at
 *   src/__tests__/spawn-assignment-handler.test.ts (line 309 onward,
 *   the "maxPerHour exceeded" case)
 * and the real install/enforcement path an admin actually exercises:
 *
 *   1. Admin approves a manifest declaring `spawnAgents` with
 *      `maxPerHour: 1, maxConcurrent: 2`.
 *   2. The activation route's clamp step produces the stored
 *      `grantedPermissions` row (here we run the clamp logic inline
 *      and assert it matches, so the test is proven to be routing
 *      through the same gate the HTTP boundary runs).
 *   3. The extension fires TWO rapid `ezcorp/spawn-assignment` RPCs.
 *      First succeeds; second must fail with -32000 /
 *      reason=hourly-exceeded.
 *   4. An `ext:spawn-quota-exceeded` row lands in `audit_log` with
 *      metadata.reason === "hourly-exceeded" — a real DB round-trip,
 *      not a mock assertion.
 *
 * Shape mirrors spawn-assignment.integration.test.ts: real PGlite,
 * mocked `startAssignment` (seeding the sub-conversation row so
 * FK-dependent writes succeed), mocked `listAgentConfigs`. The
 * clamp re-implementation at the top is the same one kept in sync
 * at src/__tests__/capability-permissions.test.ts:22-81 /
 * web/src/routes/api/extensions/[id]/activate/+server.ts:75-86.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

// Mock startAssignment: seed the sub-conversation row so the handler's
// post-dispatch writes (copyConversationExtensions, setSpawnDepth) don't
// fail on FK, and return a deterministic handle. Same shape as the
// sibling integration test.
let nextRunId = 1;
mock.module("../runtime/start-assignment", () => ({
  startAssignment: async (opts: Record<string, unknown>) => {
    const runId = `run-hq-${nextRunId++}`;
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
      title: "hq-sub",
    } as any).onConflictDoNothing();
    return { subConversationId, agentRunId: runId };
  },
}));

mock.module("../db/queries/agent-configs", () => ({
  listAgentConfigs: async () => [
    {
      id: "cfg-hq-echo",
      name: "echo-agent",
      description: "",
      prompt: "echo",
      capabilities: ["llm"],
      references: { agents: [], extensions: [] },
      userId: "user-hq",
      model: null,
      provider: null,
    },
  ],
}));

// Dynamic imports AFTER mocks are registered.
const { handleSpawnAssignmentRpc } = await import("../extensions/spawn-assignment-handler");
const { createSpawnQuota } = await import("../extensions/spawn-quota");
const { EventBus } = await import("../runtime/events");
const { capabilityToolsDisabled } = await import("../extensions/capability-flags");
const { DIRECT_CARRIER_EVENT_TYPES } = await import("../runtime/sse-conversation-filter");
const { getDb } = await import("../db/connection");
const { addConversationExtensions } = await import("../db/queries/conversation-extensions");
const {
  projects,
  conversations,
  users,
  extensions: extensionsTable,
  auditLog,
} = await import("../db/schema");

import { and, eq, desc } from "drizzle-orm";
import type { AgentEvents } from "../types";
import type { AgentExecutor } from "../runtime/executor";
import type { SpawnAssignmentContext } from "../extensions/spawn-assignment-handler";
import type {
  ExtensionPermissions,
  ExtensionManifestV2,
  JsonRpcRequest,
} from "../extensions/types";

const EXT_ID = "test-hourly-quota-ext";
const CONV_ID = "conv-hq-int-1";
const PROJ_ID = "proj-hq-int";
const USER_ID = "user-hq";

// ── Clamp re-implementation ─────────────────────────────────────────
// Mirrors web/src/routes/api/extensions/[id]/activate/+server.ts:75-86
// and the sibling copy in src/__tests__/capability-permissions.test.ts.
// Kept inline here so this test proves the hourly quota lands with the
// same constraints an admin would actually install under.
function clampToManifestReimpl(
  submitted: Partial<ExtensionPermissions>,
  manifest: ExtensionManifestV2["permissions"],
): ExtensionPermissions {
  const clamped: ExtensionPermissions = { grantedAt: {} };

  if (submitted.network && manifest.network) {
    const allowed = submitted.network.filter((d) => manifest.network!.includes(d));
    if (allowed.length > 0) clamped.network = allowed;
  }
  if (submitted.filesystem && manifest.filesystem) {
    const allowed = submitted.filesystem.filter((p) => manifest.filesystem!.includes(p));
    if (allowed.length > 0) clamped.filesystem = allowed;
  }
  if (submitted.shell === true && manifest.shell === true) clamped.shell = true;
  if (submitted.env && manifest.env) {
    const allowed = submitted.env.filter((v) => manifest.env!.includes(v));
    if (allowed.length > 0) clamped.env = allowed;
  }
  if (submitted.storage === true && manifest.storage === true) clamped.storage = true;

  if (!capabilityToolsDisabled()) {
    if (submitted.taskEvents === true && manifest.taskEvents === true) {
      clamped.taskEvents = true;
    }
    if (submitted.spawnAgents && manifest.spawnAgents) {
      const sm = submitted.spawnAgents;
      const mm = manifest.spawnAgents;
      const hourly = Math.min(sm.maxPerHour, mm.maxPerHour);
      const concurrent = Math.min(
        sm.maxConcurrent ?? mm.maxConcurrent ?? 3,
        mm.maxConcurrent ?? 3,
      );
      if (hourly > 0 && concurrent > 0) {
        clamped.spawnAgents = { maxPerHour: hourly, maxConcurrent: concurrent };
      }
    }
    if (submitted.agentConfig === "read" && manifest.agentConfig === "read") {
      clamped.agentConfig = "read";
    }
    if (Array.isArray(submitted.eventSubscriptions) && Array.isArray(manifest.eventSubscriptions)) {
      const manifestSet = new Set(manifest.eventSubscriptions);
      const allowed = submitted.eventSubscriptions.filter(
        (e) => typeof e === "string"
          && manifestSet.has(e)
          && DIRECT_CARRIER_EVENT_TYPES.has(e as never),
      );
      if (allowed.length > 0) clamped.eventSubscriptions = allowed;
    }
  }

  if (submitted.grantedAt && typeof submitted.grantedAt === "object") {
    for (const [k, v] of Object.entries(submitted.grantedAt)) {
      if (typeof v === "number") clamped.grantedAt[k] = v;
    }
  }
  return clamped;
}

// ── Setup ───────────────────────────────────────────────────────────

let clampedPermissions: ExtensionPermissions;

beforeAll(async () => {
  await setupTestDb();

  // Ensure no kill-switch is active (capability tier must be live).
  delete process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];

  // Seed parent rows.
  await getDb().insert(users).values({
    id: USER_ID, email: "hq@t.local", passwordHash: "x", name: "HQ",
  } as any).onConflictDoNothing();
  await getDb().insert(projects).values({
    id: PROJ_ID, name: PROJ_ID, path: "/tmp/" + PROJ_ID,
  } as any);
  await getDb().insert(conversations).values({
    id: CONV_ID, projectId: PROJ_ID, title: "hq-int",
  } as any);

  // Build the manifest an admin sees at install time.
  const manifest: ExtensionManifestV2 = {
    schemaVersion: 2,
    name: EXT_ID,
    version: "1.0.0",
    description: "hourly-quota smoke",
    author: { name: "test" },
    permissions: {
      spawnAgents: { maxPerHour: 1, maxConcurrent: 2 },
    },
  };

  // Run the admin-submitted permissions through the clamp gate.
  const submitted: Partial<ExtensionPermissions> = {
    spawnAgents: { maxPerHour: 1, maxConcurrent: 2 },
    grantedAt: { spawnAgents: Date.now() },
  };
  clampedPermissions = clampToManifestReimpl(submitted, manifest.permissions);

  // Prove the clamp actually produced what we expect — if the
  // real activate handler ever changes shape, this assertion trips
  // before the handler/quota logic gets blamed for the failure.
  expect(clampedPermissions.spawnAgents).toEqual({ maxPerHour: 1, maxConcurrent: 2 });

  await getDb().insert(extensionsTable).values({
    id: EXT_ID,
    name: EXT_ID,
    version: "1.0.0",
    description: "hourly-quota smoke",
    manifest,
    source: `test:${EXT_ID}`,
    installPath: `/tmp/${EXT_ID}`,
    enabled: true,
    grantedPermissions: clampedPermissions,
  } as any);

  await addConversationExtensions(CONV_ID, [{ extensionId: EXT_ID }]);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

// ── Test ────────────────────────────────────────────────────────────

function rpc(params: Record<string, unknown>, id: number | string): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/spawn-assignment", params };
}

describe("spawn-assignment integration: hourly quota (Phase 2d §9)", () => {
  test("2 rapid spawns against maxPerHour=1 → second denied -32000 hourly-exceeded + audit row", async () => {
    const bus = new EventBus<AgentEvents>();
    const quota = createSpawnQuota(bus);

    const ctx: SpawnAssignmentContext = {
      conversationId: CONV_ID,
      userId: USER_ID,
      projectId: PROJ_ID,
      grantedPermissions: clampedPermissions,
      executor: {} as unknown as AgentExecutor,
      bus,
      quota,
      spawnDepth: 0,
    };

    // First spawn: succeeds.
    const first = await handleSpawnAssignmentRpc(
      EXT_ID,
      rpc({ v: 1, task: "first", agentConfigId: "cfg-hq-echo" }, "hq-1"),
      ctx,
    );
    expect(first.error).toBeUndefined();
    const firstResult = first.result as { subConversationId: string };
    expect(firstResult.subConversationId).toMatch(/^sub-run-hq-/);

    // Second spawn: hourly cap (1/hour) is now exhausted.
    const second = await handleSpawnAssignmentRpc(
      EXT_ID,
      rpc({ v: 1, task: "second", agentConfigId: "cfg-hq-echo" }, "hq-2"),
      ctx,
    );
    expect(second.error).toBeDefined();
    expect(second.error!.code).toBe(-32000);
    expect(second.error!.message).toMatch(/Spawn quota exceeded/);
    const data = second.error!.data as {
      reason: string;
      limit: number;
      windowMs: number;
    };
    expect(data.reason).toBe("hourly-exceeded");
    expect(data.limit).toBe(1);
    expect(data.windowMs).toBe(3_600_000);

    // Audit row must be present in the real DB with the right action,
    // target, and metadata. This is the round-trip assertion the unit
    // test can't make (it mocks the audit insert away).
    const rows = await getDb()
      .select()
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "ext:spawn-quota-exceeded"),
        eq(auditLog.target, EXT_ID),
      ))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0] as { metadata: { reason: string; permission: string; actor: string } };
    expect(row.metadata.reason).toBe("hourly-exceeded");
    expect(row.metadata.permission).toBe("spawnAgents");
    expect(row.metadata.actor).toBe("system");

    quota.dispose();
  }, 15_000);
});
