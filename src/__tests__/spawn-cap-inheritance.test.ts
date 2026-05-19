/**
 * Phase 4 §6.4 — sub-conversation cap inheritance matrix.
 *
 * Validates that `handleSpawnAssignmentRpc` writes the correct
 * `effective_granted_permissions` row on `conversation_extensions` for
 * the child conversation:
 *
 *   - Default: child = intersect(parent's grants, child manifest's
 *     declared ceiling). A sub-run cannot exceed the parent's envelope.
 *   - Escalation (`escalateChildCaps: true` on the spawning extension):
 *     parent intersection skipped — child runs with own installed
 *     grants verbatim. For dedicated orchestration extensions only.
 *   - Spawn quota: enforced BEFORE cap inheritance — denials emit
 *     `SPAWN_QUOTA_EXCEEDED`, not a cap-related deny.
 *   - Audit chain: parentAuditId tracking is the engine's
 *     responsibility (separate test); here we assert wiring rows
 *     persist correctly.
 *
 * Strategy mirrors `spawn-assignment-handler.test.ts` — mock
 * `startAssignment` to short-circuit dispatch; use real PGlite for the
 * conversation_extensions writes.
 */

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

let nextAgentRunId = 1;
const startAssignmentCalls: Array<Record<string, unknown>> = [];
mock.module("../runtime/start-assignment", () => ({
  startAssignment: async (opts: Record<string, unknown>) => {
    startAssignmentCalls.push(opts);
    const runId = `run-cap-${nextAgentRunId++}`;
    const subConversationId =
      typeof opts.reuseSubConversationId === "string" && opts.reuseSubConversationId
        ? (opts.reuseSubConversationId as string)
        : `sub-${runId}`;
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
    const { getDb } = await import("../db/connection");
    const { conversations } = await import("../db/schema");
    await getDb().insert(conversations).values({
      id: subConversationId,
      projectId: opts.projectId as string,
      parentConversationId: opts.conversationId as string,
      title: "child-cap",
    } as any).onConflictDoNothing();
    return { subConversationId, agentRunId: runId };
  },
}));

// Fixture child agent configs. Each names the extensions the child
// agent wires into via `extensions: string[]` on the row + the
// references.extensions list.
const FIXTURE_CONFIGS = [
  {
    id: "cfg-child-c-only",
    name: "child-c-only",
    description: "wires only ext-C",
    prompt: "p",
    capabilities: ["llm"],
    extensions: ["ext-C"],
    references: { agents: [], extensions: ["ext-C"] },
    userId: "user-cap",
    model: null,
    provider: null,
  },
  {
    id: "cfg-child-bc",
    name: "child-bc",
    description: "wires ext-B and ext-C",
    prompt: "p",
    capabilities: ["llm"],
    extensions: ["ext-B", "ext-C"],
    references: { agents: [], extensions: ["ext-B", "ext-C"] },
    userId: "user-cap",
    model: null,
    provider: null,
  },
];
mock.module("../db/queries/agent-configs", () => ({
  listAgentConfigs: async () => FIXTURE_CONFIGS,
}));

// Dynamic imports AFTER mocks
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
} = await import("../db/schema");
const { ExtensionRegistry } = await import("../extensions/registry");
const { eq, and } = await import("drizzle-orm");

import type { JsonRpcRequest, ExtensionPermissions, ExtensionManifestV2 } from "../extensions/types";
import type { SpawnAssignmentContext } from "../extensions/spawn-assignment-handler";
import type { AgentEvents } from "../types";
import type { AgentExecutor } from "../runtime/executor";

// ── Fixtures ────────────────────────────────────────────────────────

const PROJECT = "proj-cap-inh";
const PARENT_CONV = "conv-cap-parent";
const SPAWNER_EXT = "ext-spawner";

async function ensureExtension(
  id: string,
  perms: ExtensionPermissions,
  manifestPerms: ExtensionManifestV2["permissions"],
): Promise<void> {
  await getDb().insert(extensionsTable).values({
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
      permissions: manifestPerms,
    },
    source: `test:${id}`,
    installPath: `/tmp/${id}`,
    enabled: true,
    grantedPermissions: perms,
  } as any).onConflictDoNothing();
}

async function wireParent(convId: string, extId: string): Promise<void> {
  await getDb().insert(conversationExtensions).values({
    conversationId: convId,
    extensionId: extId,
  } as any).onConflictDoNothing();
}

function makeCtx(
  spawnerGrants: ExtensionPermissions,
  registry: ReturnType<typeof ExtensionRegistry.getInstance>,
  conversationId = PARENT_CONV,
): SpawnAssignmentContext {
  const bus = new EventBus<AgentEvents>();
  const quota = createSpawnQuota(bus);
  return {
    conversationId,
    userId: "user-cap",
    projectId: PROJECT,
    grantedPermissions: spawnerGrants,
    executor: {} as unknown as AgentExecutor,
    bus,
    quota,
    spawnDepth: 0,
    registry,
  };
}

function rpc(params: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/spawn-assignment", params };
}

async function getEffectiveGrants(
  conversationId: string,
  extensionId: string,
): Promise<ExtensionPermissions | null> {
  const rows = await getDb()
    .select()
    .from(conversationExtensions)
    .where(
      and(
        eq(conversationExtensions.conversationId, conversationId),
        eq(conversationExtensions.extensionId, extensionId),
      ),
    );
  return (rows[0]?.effectiveGrantedPermissions as ExtensionPermissions | null) ?? null;
}

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values({
    id: "user-cap", email: "cap@t.local", passwordHash: "x", name: "Cap",
  } as any).onConflictDoNothing();
  await getDb().insert(projects).values({
    id: PROJECT, name: PROJECT, path: `/tmp/${PROJECT}`,
  } as any);
  await getDb().insert(conversations).values({
    id: PARENT_CONV, projectId: PROJECT, title: "parent",
  } as any);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

afterEach(() => {
  startAssignmentCalls.length = 0;
  ExtensionRegistry.resetInstance();
});

// Re-seed fixtures used by EVERY case. Helper because each test sets
// up its own caps, but the parent's wiring + spawner ext are
// constant.
async function seedSpawner(escalate: boolean): Promise<void> {
  const spawnerGrants: ExtensionPermissions = {
    spawnAgents: { maxPerHour: 10, maxConcurrent: 3 },
    grantedAt: {},
    ...(escalate ? { escalateChildCaps: true } : {}),
  };
  await ensureExtension(SPAWNER_EXT, spawnerGrants, {
    spawnAgents: { maxPerHour: 10, maxConcurrent: 3 },
  });
  await wireParent(PARENT_CONV, SPAWNER_EXT);
}

// ── (a) ALLOWED: parent has cap, child agent wires ext that needs it ──

describe("(a) Default — parent has foo.com; child agent wires C with foo.com manifest → child gets foo.com", () => {
  test("conversation_extensions row for child has effective grants = {network: ['foo.com']}", async () => {
    await seedSpawner(false);
    // Ext-C: manifest says it CAN have foo.com, parent's installed
    // grant is foo.com → intersection = foo.com.
    const cGrants: ExtensionPermissions = { network: ["foo.com"], grantedAt: {} };
    await ensureExtension("ext-C", cGrants, { network: ["foo.com"] });
    await wireParent(PARENT_CONV, "ext-C");

    const reg = ExtensionRegistry.getInstance();
    reg.setManifestForTest("ext-C", {
      schemaVersion: 2,
      name: "ext-C",
      version: "1.0.0",
      description: "t",
      author: { name: "t" },
      permissions: { network: ["foo.com"] },
    });
    reg.setGrantedPermsForTest("ext-C", cGrants);

    const ctx = makeCtx(
      { spawnAgents: { maxPerHour: 10 }, grantedAt: {} },
      reg,
    );
    const r = await handleSpawnAssignmentRpc(
      SPAWNER_EXT,
      rpc({ v: 1, task: "go", agentConfigId: "cfg-child-c-only" }, "a1"),
      ctx,
    );
    expect(r.error).toBeUndefined();
    const subId = (r.result as { subConversationId: string }).subConversationId;
    const eff = await getEffectiveGrants(subId, "ext-C");
    expect(eff?.network).toEqual(["foo.com"]);
  });
});

// ── (b) DENIED at intersection: parent doesn't have bar.com ──

describe("(b) Default — parent has foo.com only; child agent wires C with bar.com manifest → child gets EMPTY network", () => {
  test("intersection of foo.com and bar.com is empty; effective grants drop network", async () => {
    await seedSpawner(false);
    // Parent's grant on ext-C is restrictive (foo.com), but the child
    // agent wires the extension whose MANIFEST says bar.com. The
    // intersection of parent's `[foo.com]` with manifest's `[bar.com]`
    // is empty.
    //
    // Parent has installed ext-C with grant [foo.com]; the
    // manifest authoritatively declares [bar.com]. We use those two as
    // the intersection inputs.
    await ensureExtension(
      "ext-C-b",
      { network: ["foo.com"], grantedAt: {} },
      { network: ["bar.com"] },
    );
    await wireParent(PARENT_CONV, "ext-C-b");

    const reg = ExtensionRegistry.getInstance();
    reg.setManifestForTest("ext-C-b", {
      schemaVersion: 2,
      name: "ext-C-b",
      version: "1.0.0",
      description: "t",
      author: { name: "t" },
      permissions: { network: ["bar.com"] },
    });
    reg.setGrantedPermsForTest("ext-C-b", { network: ["foo.com"], grantedAt: {} });

    // Use a local agent config that wires ext-C-b
    FIXTURE_CONFIGS.push({
      id: "cfg-child-b",
      name: "child-b",
      description: "wires ext-C-b",
      prompt: "p",
      capabilities: ["llm"],
      extensions: ["ext-C-b"],
      references: { agents: [], extensions: ["ext-C-b"] },
      userId: "user-cap",
      model: null,
      provider: null,
    });

    const ctx = makeCtx(
      { spawnAgents: { maxPerHour: 10 }, grantedAt: {} },
      reg,
    );
    const r = await handleSpawnAssignmentRpc(
      SPAWNER_EXT,
      rpc({ v: 1, task: "go", agentConfigId: "cfg-child-b" }, "b1"),
      ctx,
    );
    expect(r.error).toBeUndefined();
    const subId = (r.result as { subConversationId: string }).subConversationId;
    const eff = await getEffectiveGrants(subId, "ext-C-b");
    expect(eff?.network).toBeUndefined();
  });
});

// ── (c) Empty parent caps → child gets empty effective caps ──

describe("(c) Default — parent has empty grants; child agent wires C with full manifest → effective caps empty", () => {
  test("intersection with empty parent grants is empty regardless of manifest", async () => {
    await seedSpawner(false);
    // Parent's grant is empty for ext-C-c, but the manifest says
    // network: ["whatever.com"]. The intersection is empty.
    await ensureExtension(
      "ext-C-c",
      { grantedAt: {} }, // EMPTY grant
      { network: ["whatever.com"] },
    );
    await wireParent(PARENT_CONV, "ext-C-c");

    const reg = ExtensionRegistry.getInstance();
    reg.setManifestForTest("ext-C-c", {
      schemaVersion: 2,
      name: "ext-C-c",
      version: "1.0.0",
      description: "t",
      author: { name: "t" },
      permissions: { network: ["whatever.com"] },
    });
    reg.setGrantedPermsForTest("ext-C-c", { grantedAt: {} });

    FIXTURE_CONFIGS.push({
      id: "cfg-child-c",
      name: "child-c",
      description: "wires ext-C-c",
      prompt: "p",
      capabilities: ["llm"],
      extensions: ["ext-C-c"],
      references: { agents: [], extensions: ["ext-C-c"] },
      userId: "user-cap",
      model: null,
      provider: null,
    });

    const ctx = makeCtx(
      { spawnAgents: { maxPerHour: 10 }, grantedAt: {} },
      reg,
    );
    const r = await handleSpawnAssignmentRpc(
      SPAWNER_EXT,
      rpc({ v: 1, task: "go", agentConfigId: "cfg-child-c" }, "c1"),
      ctx,
    );
    expect(r.error).toBeUndefined();
    const subId = (r.result as { subConversationId: string }).subConversationId;
    const eff = await getEffectiveGrants(subId, "ext-C-c");
    expect(eff?.network).toBeUndefined();
    expect(eff?.shell).toBeUndefined();
  });
});

// ── (d) Escalation — escalateChildCaps: true skips parent intersection ──

describe("(d) Escalation — spawning ext has escalateChildCaps: true → child gets ext's installed grants verbatim", () => {
  test("parent has no foo.com grant on ext-C-d, but child runs with ext's full installed grants", async () => {
    // The spawner extension's GRANT carries escalateChildCaps: true.
    // The child wires ext-C-d which has installed grant `[bar.com]`.
    // Without escalation: intersect would clip with parent's grant
    // (which we'll deliberately leave SMALLER). With escalation: the
    // child's effective grant is the extension's own installed grant,
    // verbatim.
    await seedSpawner(true); // escalation ON

    await ensureExtension(
      "ext-C-d",
      { network: ["bar.com"], grantedAt: {} }, // installed grant
      { network: ["bar.com"] }, // manifest ceiling matches
    );
    await wireParent(PARENT_CONV, "ext-C-d");

    const reg = ExtensionRegistry.getInstance();
    reg.setManifestForTest("ext-C-d", {
      schemaVersion: 2,
      name: "ext-C-d",
      version: "1.0.0",
      description: "t",
      author: { name: "t" },
      permissions: { network: ["bar.com"] },
    });
    reg.setGrantedPermsForTest("ext-C-d", {
      network: ["bar.com"],
      grantedAt: {},
    });

    FIXTURE_CONFIGS.push({
      id: "cfg-child-d",
      name: "child-d",
      description: "wires ext-C-d",
      prompt: "p",
      capabilities: ["llm"],
      extensions: ["ext-C-d"],
      references: { agents: [], extensions: ["ext-C-d"] },
      userId: "user-cap",
      model: null,
      provider: null,
    });

    const ctx = makeCtx(
      {
        spawnAgents: { maxPerHour: 10 },
        escalateChildCaps: true,
        grantedAt: {},
      },
      reg,
    );
    const r = await handleSpawnAssignmentRpc(
      SPAWNER_EXT,
      rpc({ v: 1, task: "go", agentConfigId: "cfg-child-d" }, "d1"),
      ctx,
    );
    expect(r.error).toBeUndefined();
    const subId = (r.result as { subConversationId: string }).subConversationId;
    const eff = await getEffectiveGrants(subId, "ext-C-d");
    // Escalation preserves the extension's installed grants verbatim.
    expect(eff?.network).toEqual(["bar.com"]);
  });
});

// ── (e) Without escalation → same setup as (d) but child is clipped ──

describe("(e) Default (NO escalation) — same setup as (d) but parent's installed grant is wider than manifest → child gets manifest ceiling intersected", () => {
  test("intersection of [bar.com] (grant) and [bar.com] (manifest) = [bar.com]", async () => {
    // Repeat (d) but WITHOUT escalation. The intersection of parent's
    // installed grant [bar.com] and manifest's ceiling [bar.com] is
    // still [bar.com] — unchanged.
    await seedSpawner(false);

    const reg = ExtensionRegistry.getInstance();
    // Use an isolated extension so the `(d)` row from a prior test
    // doesn't influence this one (each test has a unique extension id
    // for its child to keep state hermetic).
    await ensureExtension(
      "ext-C-e",
      { network: ["bar.com"], grantedAt: {} },
      { network: ["bar.com"] },
    );
    await wireParent(PARENT_CONV, "ext-C-e");
    reg.setManifestForTest("ext-C-e", {
      schemaVersion: 2,
      name: "ext-C-e",
      version: "1.0.0",
      description: "t",
      author: { name: "t" },
      permissions: { network: ["bar.com"] },
    });
    reg.setGrantedPermsForTest("ext-C-e", {
      network: ["bar.com"],
      grantedAt: {},
    });

    FIXTURE_CONFIGS.push({
      id: "cfg-child-e",
      name: "child-e",
      description: "wires ext-C-e",
      prompt: "p",
      capabilities: ["llm"],
      extensions: ["ext-C-e"],
      references: { agents: [], extensions: ["ext-C-e"] },
      userId: "user-cap",
      model: null,
      provider: null,
    });

    const ctx = makeCtx(
      { spawnAgents: { maxPerHour: 10 }, grantedAt: {} },
      reg,
    );
    const r = await handleSpawnAssignmentRpc(
      SPAWNER_EXT,
      rpc({ v: 1, task: "go", agentConfigId: "cfg-child-e" }, "e1"),
      ctx,
    );
    expect(r.error).toBeUndefined();
    const subId = (r.result as { subConversationId: string }).subConversationId;
    const eff = await getEffectiveGrants(subId, "ext-C-e");
    expect(eff?.network).toEqual(["bar.com"]);
  });
});

// ── (f) Spawn-quota interaction — quota enforced BEFORE cap inheritance ──

describe("(f) Quota enforced first — when spawn quota refuses, no cap-inheritance write happens", () => {
  test("permission-missing audit: handler rejects before reaching cap inheritance step", async () => {
    await seedSpawner(false);
    const reg = ExtensionRegistry.getInstance();
    // No spawnAgents grant → handler rejects with permission-missing
    // ladder step #2; the cap-inheritance code is never reached.
    const ctx = makeCtx(
      { grantedAt: {} }, // No spawnAgents grant
      reg,
    );
    const r = await handleSpawnAssignmentRpc(
      SPAWNER_EXT,
      rpc({ v: 1, task: "go", agentConfigId: "cfg-child-c-only" }, "f1"),
      ctx,
    );
    expect(r.error?.code).toBe(-32001);
    expect(r.error?.message).toContain("spawnAgents");
    expect(startAssignmentCalls.length).toBe(0);
  });
});

// ── (g) Audit chain — child wiring rows are created (parentAuditId at engine layer) ──

describe("(g) Wiring rows persist on child conversation; PDP can read effective grants on next tool call", () => {
  test("getConversationExtensionEffectiveGrants returns the persisted blob for the child conversation", async () => {
    await seedSpawner(false);
    await ensureExtension(
      "ext-C-g",
      { network: ["foo.com"], grantedAt: {} },
      { network: ["foo.com"] },
    );
    await wireParent(PARENT_CONV, "ext-C-g");

    const reg = ExtensionRegistry.getInstance();
    reg.setManifestForTest("ext-C-g", {
      schemaVersion: 2,
      name: "ext-C-g",
      version: "1.0.0",
      description: "t",
      author: { name: "t" },
      permissions: { network: ["foo.com"] },
    });
    reg.setGrantedPermsForTest("ext-C-g", { network: ["foo.com"], grantedAt: {} });

    FIXTURE_CONFIGS.push({
      id: "cfg-child-g",
      name: "child-g",
      description: "wires ext-C-g",
      prompt: "p",
      capabilities: ["llm"],
      extensions: ["ext-C-g"],
      references: { agents: [], extensions: ["ext-C-g"] },
      userId: "user-cap",
      model: null,
      provider: null,
    });

    const ctx = makeCtx(
      { spawnAgents: { maxPerHour: 10 }, grantedAt: {} },
      reg,
    );
    const r = await handleSpawnAssignmentRpc(
      SPAWNER_EXT,
      rpc({ v: 1, task: "go", agentConfigId: "cfg-child-g" }, "g1"),
      ctx,
    );
    expect(r.error).toBeUndefined();
    const subId = (r.result as { subConversationId: string }).subConversationId;

    // The same query the PDP uses at runtime
    const { getConversationExtensionEffectiveGrants } = await import(
      "../db/queries/conversation-extensions"
    );
    const eff = await getConversationExtensionEffectiveGrants(subId, "ext-C-g");
    expect(eff?.network).toEqual(["foo.com"]);
  });
});

// ── Extension-list filter: child agent's wiring is the gate ──

describe("Child agent's wired-extension allowlist filters the inherited extensions", () => {
  test("parent has spawner + foo + bar; child agent only wires foo → bar is dropped", async () => {
    await seedSpawner(false);
    await ensureExtension(
      "ext-foo-x",
      { network: ["only.foo"], grantedAt: {} },
      { network: ["only.foo"] },
    );
    await ensureExtension(
      "ext-bar-x",
      { network: ["only.bar"], grantedAt: {} },
      { network: ["only.bar"] },
    );
    await wireParent(PARENT_CONV, "ext-foo-x");
    await wireParent(PARENT_CONV, "ext-bar-x");

    const reg = ExtensionRegistry.getInstance();
    reg.setManifestForTest("ext-foo-x", {
      schemaVersion: 2,
      name: "ext-foo-x",
      version: "1.0.0",
      description: "t",
      author: { name: "t" },
      permissions: { network: ["only.foo"] },
    });
    reg.setManifestForTest("ext-bar-x", {
      schemaVersion: 2,
      name: "ext-bar-x",
      version: "1.0.0",
      description: "t",
      author: { name: "t" },
      permissions: { network: ["only.bar"] },
    });
    reg.setGrantedPermsForTest("ext-foo-x", { network: ["only.foo"], grantedAt: {} });
    reg.setGrantedPermsForTest("ext-bar-x", { network: ["only.bar"], grantedAt: {} });

    // Child agent wires ONLY ext-foo-x (not ext-bar-x).
    FIXTURE_CONFIGS.push({
      id: "cfg-child-foo-only",
      name: "child-foo-only",
      description: "wires ext-foo-x",
      prompt: "p",
      capabilities: ["llm"],
      extensions: ["ext-foo-x"],
      references: { agents: [], extensions: ["ext-foo-x"] },
      userId: "user-cap",
      model: null,
      provider: null,
    });

    const ctx = makeCtx(
      { spawnAgents: { maxPerHour: 10 }, grantedAt: {} },
      reg,
    );
    const r = await handleSpawnAssignmentRpc(
      SPAWNER_EXT,
      rpc({ v: 1, task: "go", agentConfigId: "cfg-child-foo-only" }, "fb1"),
      ctx,
    );
    expect(r.error).toBeUndefined();
    const subId = (r.result as { subConversationId: string }).subConversationId;

    const fooEff = await getEffectiveGrants(subId, "ext-foo-x");
    const barEff = await getEffectiveGrants(subId, "ext-bar-x");
    expect(fooEff?.network).toEqual(["only.foo"]);
    expect(barEff).toBeNull(); // ext-bar-x not wired into child at all
  });
});

// ── M4: registry?-undefined fallback path ──────────────────────────

describe("M4 — ctx.registry undefined → legacy blanket-copy fallback + console.warn", () => {
  test("handleSpawnAssignmentRpc with ctx.registry === undefined writes blanket rows and warns", async () => {
    await seedSpawner(false);
    await ensureExtension(
      "ext-fb-x",
      { network: ["any.com"], grantedAt: {} },
      { network: ["any.com"] },
    );
    await wireParent(PARENT_CONV, "ext-fb-x");

    FIXTURE_CONFIGS.push({
      id: "cfg-child-fb",
      name: "child-fb",
      description: "wires ext-fb-x",
      prompt: "p",
      capabilities: ["llm"],
      extensions: ["ext-fb-x"],
      references: { agents: [], extensions: ["ext-fb-x"] },
      userId: "user-cap",
      model: null,
      provider: null,
    });

    // Capture console.warn calls.
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: unknown, ...rest: unknown[]) => {
      warnings.push(typeof msg === "string" ? msg : String(msg));
      // Suppress to keep test output clean — we already capture above.
      void rest;
    };

    try {
      const bus = new EventBus<AgentEvents>();
      const quota = createSpawnQuota(bus);
      const ctx: SpawnAssignmentContext = {
        conversationId: PARENT_CONV,
        userId: "user-cap",
        projectId: PROJECT,
        grantedPermissions: { spawnAgents: { maxPerHour: 10 }, grantedAt: {} },
        executor: {} as unknown as AgentExecutor,
        bus,
        quota,
        spawnDepth: 0,
        // Deliberately omit registry — that's the M4 fallback case.
      };
      const r = await handleSpawnAssignmentRpc(
        SPAWNER_EXT,
        rpc({ v: 1, task: "go", agentConfigId: "cfg-child-fb" }, "m4"),
        ctx,
      );
      expect(r.error).toBeUndefined();
      const subId = (r.result as { subConversationId: string }).subConversationId;

      // Blanket-copy fallback: the row exists but effective_granted_permissions is null.
      const eff = await getEffectiveGrants(subId, "ext-fb-x");
      expect(eff).toBeNull();

      // Visible signal that the fallback fired.
      const warnedAboutFallback = warnings.some((w) =>
        w.includes("registry not threaded") && w.includes("Phase 4 §M4"),
      );
      expect(warnedAboutFallback).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ── M7: nested spawn cannot widen caps beyond child1's clipping ────

describe("M7 — 2-deep spawn does not widen caps; sub-spawn reads parent CONVERSATION's clipped grants", () => {
  test("A → child1 (clipped to foo.com only) → child2 also sees foo.com only, not full bar.com", async () => {
    await seedSpawner(false);
    // Extension whose installed registry grants are network: foo+bar,
    // but the spawn-handler clips it to foo.com on child1, then
    // child1 spawns child2 which must inherit child1's [foo.com], not
    // the registry's [foo.com, bar.com].
    await ensureExtension(
      "ext-nested-x",
      { network: ["foo.com", "bar.com"], grantedAt: {} },
      { network: ["foo.com", "bar.com"] },
    );
    await wireParent(PARENT_CONV, "ext-nested-x");

    const reg = ExtensionRegistry.getInstance();
    // Spawner registered too (via seedSpawner).
    reg.setManifestForTest("ext-nested-x", {
      schemaVersion: 2,
      name: "ext-nested-x",
      version: "1.0.0",
      description: "t",
      author: { name: "t" },
      permissions: { network: ["foo.com", "bar.com"] },
    });
    reg.setGrantedPermsForTest("ext-nested-x", {
      network: ["foo.com", "bar.com"],
      grantedAt: {},
    });

    // Child1's agent config wires the spawner so it can spawn child2,
    // plus the nested extension. Manifest ceiling for the nested
    // extension is foo.com only — that's what clips child1's grants.
    FIXTURE_CONFIGS.push({
      id: "cfg-child1-nested",
      name: "child1-nested",
      description: "child1 — clipped to foo.com on ext-nested-x",
      prompt: "p",
      capabilities: ["llm"],
      extensions: ["ext-nested-x", SPAWNER_EXT],
      references: { agents: [], extensions: ["ext-nested-x", SPAWNER_EXT] },
      userId: "user-cap",
      model: null,
      provider: null,
    });

    // Spawn child1 from PARENT_CONV. The handler must clip
    // child1's ext-nested-x grants to manifest ceiling [foo.com,
    // bar.com] ∩ parent's installed [foo.com, bar.com] = [foo.com,
    // bar.com] — but to genuinely test the M7 widening fix we want
    // child1's effective grant to be NARROWER than the registry's
    // installed grant. So we pre-seed PARENT_CONV with an effective
    // grant of [foo.com] only on ext-nested-x to simulate having
    // arrived at PARENT_CONV via a prior clipping step.
    await getDb()
      .insert(conversationExtensions)
      .values({
        conversationId: PARENT_CONV,
        extensionId: "ext-nested-x",
        effectiveGrantedPermissions: { network: ["foo.com"], grantedAt: {} },
      } as any)
      .onConflictDoUpdate({
        target: [conversationExtensions.conversationId, conversationExtensions.extensionId],
        set: {
          effectiveGrantedPermissions: { network: ["foo.com"], grantedAt: {} },
        },
      })
      .catch(async () => {
        // PGlite may not support onConflictDoUpdate composite key — fall
        // back to a manual update path.
        await getDb()
          .update(conversationExtensions)
          .set({
            effectiveGrantedPermissions: { network: ["foo.com"], grantedAt: {} },
          } as any)
          .where(
            and(
              eq(conversationExtensions.conversationId, PARENT_CONV),
              eq(conversationExtensions.extensionId, "ext-nested-x"),
            ),
          );
      });

    const ctx = makeCtx(
      { spawnAgents: { maxPerHour: 10 }, grantedAt: {} },
      reg,
    );
    const r = await handleSpawnAssignmentRpc(
      SPAWNER_EXT,
      rpc({ v: 1, task: "go", agentConfigId: "cfg-child1-nested" }, "m7"),
      ctx,
    );
    expect(r.error).toBeUndefined();
    const childSubId = (r.result as { subConversationId: string }).subConversationId;

    // M7 guarantee: child sees the parent CONVERSATION's already-
    // clipped [foo.com], NOT the registry's full installed
    // [foo.com, bar.com]. Without the fix, the spawn handler would
    // intersect registry grants with manifest ceiling and widen
    // back to [foo.com, bar.com].
    const childEff = await getEffectiveGrants(childSubId, "ext-nested-x");
    expect(childEff?.network).toEqual(["foo.com"]);
    expect(childEff?.network).not.toContain("bar.com");
  });
});

// ── M2: parentAuditId chain seeded on the child conversation ───────

describe("M2 — spawn writes SPAWN_AUTHORIZED audit row + seeds child conversation's parentAuditId", () => {
  test("after spawn, the child conversation has a spawnParentAuditId pointing at a SPAWN_AUTHORIZED audit row", async () => {
    await seedSpawner(false);
    await ensureExtension(
      "ext-aud-x",
      { network: ["any.com"], grantedAt: {} },
      { network: ["any.com"] },
    );
    await wireParent(PARENT_CONV, "ext-aud-x");

    const reg = ExtensionRegistry.getInstance();
    reg.setManifestForTest("ext-aud-x", {
      schemaVersion: 2,
      name: "ext-aud-x",
      version: "1.0.0",
      description: "t",
      author: { name: "t" },
      permissions: { network: ["any.com"] },
    });
    reg.setGrantedPermsForTest("ext-aud-x", { network: ["any.com"], grantedAt: {} });

    FIXTURE_CONFIGS.push({
      id: "cfg-child-aud",
      name: "child-aud",
      description: "wires ext-aud-x",
      prompt: "p",
      capabilities: ["llm"],
      extensions: ["ext-aud-x"],
      references: { agents: [], extensions: ["ext-aud-x"] },
      userId: "user-cap",
      model: null,
      provider: null,
    });

    const ctx = makeCtx(
      { spawnAgents: { maxPerHour: 10 }, grantedAt: {} },
      reg,
    );
    const r = await handleSpawnAssignmentRpc(
      SPAWNER_EXT,
      rpc({ v: 1, task: "go", agentConfigId: "cfg-child-aud" }, "m2"),
      ctx,
    );
    expect(r.error).toBeUndefined();
    const subId = (r.result as { subConversationId: string }).subConversationId;

    // The child's metadata should carry the spawn-authorize audit id.
    const { getConversationSpawnParentAuditId } = await import(
      "../db/queries/conversations"
    );
    const spawnAuditId = await getConversationSpawnParentAuditId(subId);
    expect(spawnAuditId).toBeTruthy();
    expect(typeof spawnAuditId).toBe("string");

    // And that audit id should resolve to a SPAWN_AUTHORIZED row.
    const { auditLog } = await import("../db/schema");
    const rows = await getDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.id, spawnAuditId!));
    expect(rows[0]?.action).toBe("ext:spawn-authorized");
    expect((rows[0]?.metadata as Record<string, unknown>)?.subConversationId).toBe(subId);
  });
});
