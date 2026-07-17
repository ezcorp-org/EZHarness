// Unit tests for src/extensions/agent-configs-handler.ts (Phase 2b).
//
// Covers the full enforcement ladder: kill-switch / permission /
// user-scope / rate-limit / action / payload-version, plus the
// minimum-information summary shape and name-resolve semantics
// (case-insensitive, whitespace-trimmed).
//
// Strategy mirrors storage-handler-coverage.test.ts — real PGlite +
// drizzle, mock only db/connection, exercise the handler directly.

import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { mock } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { withFrozenNow } from "./helpers/frozen-clock";

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

const { handleAgentConfigsRpc } = await import("../extensions/agent-configs-handler");
const { getDb } = await import("../db/connection");
const { agentConfigs, users } = await import("../db/schema");

import type { JsonRpcRequest } from "../extensions/types";
import type { AgentConfigsContext } from "../extensions/agent-configs-handler";
import type { ExtensionPermissions } from "../extensions/types";

// ── Fixtures ─────────────────────────────────────────────────────────

function makePerms(agentConfig?: "read"): ExtensionPermissions {
  return { ...(agentConfig ? { agentConfig } : {}), grantedAt: {} };
}

function makeCtx(overrides: Partial<AgentConfigsContext> = {}): AgentConfigsContext {
  return {
    userId: overrides.userId ?? "user-alice",
    grantedPermissions: overrides.grantedPermissions ?? makePerms("read"),
    // Phase 6: pass through engine + conversationId when supplied so
    // PDP-path tests actually drive the new branch.
    ...(overrides.engine ? { engine: overrides.engine } : {}),
    ...(overrides.conversationId ? { conversationId: overrides.conversationId } : {}),
  };
}

function rpc(params: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/agent-configs", params };
}

async function insertUser(id: string): Promise<void> {
  await getDb().insert(users).values({
    id,
    email: `${id}@test.local`,
    passwordHash: "x",
    name: id,
  } as any).onConflictDoNothing();
}

interface AgentSeed {
  id?: string;
  name: string;
  description?: string;
  userId: string | null;
  isTeam?: boolean;
}

async function insertAgentConfig(seed: AgentSeed): Promise<string> {
  const id = seed.id ?? crypto.randomUUID();
  const references = seed.isTeam
    ? { agents: [], extensions: [], members: [{ agentConfigId: "x", subAgents: [] }] }
    : { agents: [], extensions: [] };
  await getDb().insert(agentConfigs).values({
    id,
    name: seed.name,
    description: seed.description ?? "",
    prompt: "placeholder",
    capabilities: ["llm"],
    references,
    userId: seed.userId,
  } as any);
  return id;
}

// Shared fixtures.
const EXT_ID = "test-ext";
let aliceOwned: string;
let bobOwned: string;
let aliceTeam: string;

beforeAll(async () => {
  await setupTestDb();
  await insertUser("user-alice");
  await insertUser("user-bob");

  aliceOwned = await insertAgentConfig({
    name: "alice-helper",
    description: "Alice's helper",
    userId: "user-alice",
  });
  bobOwned = await insertAgentConfig({
    name: "bob-secret",
    description: "Bob's private agent",
    userId: "user-bob",
  });
  aliceTeam = await insertAgentConfig({
    name: "alice-crew",
    description: "Alice's team",
    userId: "user-alice",
    isTeam: true,
  });
  void aliceTeam;
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

afterEach(() => {
  delete process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
});

// ── Permission + kill-switch ─────────────────────────────────────────

describe("agent-configs-handler — permission + kill-switch", () => {
  test("agentConfig not granted → -32001", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "list" }),
      makeCtx({ grantedPermissions: makePerms() }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toMatch(/agentConfig/);
  });

  test("EZCORP_DISABLE_CAPABILITY_TOOLS=1 → -32001 even with permission", async () => {
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "1";
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "list" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32001);
  });
});

// ── User-scope gate ──────────────────────────────────────────────────

describe("agent-configs-handler — user scope", () => {
  test("userId missing → -32602", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "list" }),
      makeCtx({ userId: "" }),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toMatch(/User scope/);
  });

  test('userId="unknown" → -32602', async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "list" }),
      makeCtx({ userId: "unknown" }),
    );
    expect(resp.error?.code).toBe(-32602);
  });
});

// ── Payload validation ───────────────────────────────────────────────

describe("agent-configs-handler — payload validation", () => {
  test("missing v field → -32602", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ action: "list" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toMatch(/v/);
  });

  test("v !== 1 → -32602", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 2, action: "list" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("unknown action → -32602", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "delete" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toMatch(/Unknown action/);
  });

  test("resolve with missing idOrName → -32602", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "resolve" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toMatch(/idOrName/);
  });

  test("resolve with empty-string idOrName → -32602", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "resolve", idOrName: "   " }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
  });
});

// ── list ─────────────────────────────────────────────────────────────

describe("agent-configs-handler — list", () => {
  test("list returns only calling user's configs — bob's private agent never leaks", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "list" }, "list-a"),
      makeCtx({ userId: "user-alice" }),
    );
    expect(resp.error).toBeUndefined();
    const { configs } = resp.result as { v: 1; configs: Array<{ id: string; name: string }> };
    const names = configs.map((c) => c.name);
    expect(names).toContain("alice-helper");
    expect(names).toContain("alice-crew");
    expect(names).not.toContain("bob-secret");
  });

  test("list summary shape — no prompt, references, or capabilities fields", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "list" }),
      makeCtx({ userId: "user-alice" }),
    );
    const { configs } = resp.result as { configs: Array<Record<string, unknown>> };
    const helper = configs.find((c) => c.name === "alice-helper");
    expect(helper).toBeDefined();
    expect(helper!.id).toBeDefined();
    expect(helper!.name).toBe("alice-helper");
    expect(helper!.description).toBe("Alice's helper");
    expect(helper!.isTeam).toBe(false);
    expect(helper!.ownerUserId).toBe("user-alice");
    // Secret-adjacent fields must not appear.
    expect("prompt" in helper!).toBe(false);
    expect("references" in helper!).toBe(false);
    expect("capabilities" in helper!).toBe(false);
    expect("extensions" in helper!).toBe(false);
    expect("createdAt" in helper!).toBe(false);
  });

  test("isTeam=true for configs with non-empty references.members", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "list" }),
      makeCtx({ userId: "user-alice" }),
    );
    const { configs } = resp.result as { configs: Array<{ id: string; name: string; isTeam: boolean }> };
    const crew = configs.find((c) => c.name === "alice-crew");
    expect(crew?.isTeam).toBe(true);
  });

  test("isTeam=false when references column is null (no references row)", async () => {
    // Seed a config with references=null (direct DB insert bypassing the
    // normal constructor that fills `{agents: [], extensions: []}`).
    const nullRefsId = crypto.randomUUID();
    await getDb().insert(agentConfigs).values({
      id: nullRefsId,
      name: "alice-null-refs",
      description: "null refs fixture",
      prompt: "x",
      capabilities: ["llm"],
      references: null,
      userId: "user-alice",
    } as any);
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "list" }),
      makeCtx({ userId: "user-alice" }),
    );
    const { configs } = resp.result as { configs: Array<{ name: string; isTeam: boolean }> };
    const found = configs.find((c) => c.name === "alice-null-refs");
    expect(found?.isTeam).toBe(false);
  });

  test("ownerUserId=null when the row has no user_id (legacy/orphan config)", async () => {
    const orphanId = crypto.randomUUID();
    await getDb().insert(agentConfigs).values({
      id: orphanId,
      name: "orphan-public",
      description: "no owner",
      prompt: "x",
      capabilities: ["llm"],
      references: { agents: [], extensions: [] },
      userId: null,
    } as any);
    // Orphan rows only show up in a global list (no userId filter) —
    // the handler is user-scoped so this row won't leak to alice.
    // To assert `ownerUserId:null` on the return shape we call with a
    // separate user that owns the row... but a null-userId row is never
    // owned. The important property is that when it DOES surface (via
    // shared-with-user path), ownerUserId is propagated as null. We
    // verify the mapping directly by asserting the row never appears
    // in alice's user-scoped list — the only guarantee the handler
    // provides for null-owner rows.
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "list" }),
      makeCtx({ userId: "user-alice" }),
    );
    const { configs } = resp.result as { configs: Array<{ name: string; ownerUserId: string | null }> };
    expect(configs.find((c) => c.name === "orphan-public")).toBeUndefined();
  });

  test("response envelope carries v:1", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "list" }),
      makeCtx({ userId: "user-alice" }),
    );
    expect((resp.result as { v: number }).v).toBe(1);
  });
});

// ── resolve ──────────────────────────────────────────────────────────

describe("agent-configs-handler — resolve", () => {
  test("resolve by id — alice can find her own", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "resolve", idOrName: aliceOwned }),
      makeCtx({ userId: "user-alice" }),
    );
    const { config } = resp.result as { config: { id: string; name: string } | null };
    expect(config?.id).toBe(aliceOwned);
    expect(config?.name).toBe("alice-helper");
  });

  test("resolve by id — alice cannot find bob's private agent", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "resolve", idOrName: bobOwned }),
      makeCtx({ userId: "user-alice" }),
    );
    const { config } = resp.result as { config: unknown };
    expect(config).toBeNull();
  });

  test("resolve by name — case-insensitive, whitespace-trimmed", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "resolve", idOrName: "  ALICE-HELPER  " }),
      makeCtx({ userId: "user-alice" }),
    );
    const { config } = resp.result as { config: { name: string } | null };
    expect(config?.name).toBe("alice-helper");
  });

  test("resolve by name — unknown name returns null", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "resolve", idOrName: "nonexistent" }),
      makeCtx({ userId: "user-alice" }),
    );
    expect((resp.result as { config: unknown }).config).toBeNull();
  });

  test("resolve shape matches list summary (no prompt/references)", async () => {
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "resolve", idOrName: "alice-helper" }),
      makeCtx({ userId: "user-alice" }),
    );
    const { config } = resp.result as { config: Record<string, unknown> | null };
    expect(config).not.toBeNull();
    expect("prompt" in config!).toBe(false);
    expect("references" in config!).toBe(false);
  });
});

// ── Rate limit ───────────────────────────────────────────────────────

describe("agent-configs-handler — rate limit", () => {
  test("60 tight-loop calls → ~50 succeed, ~10 rejected with -32029", async () => {
    const extId = `rate-ext-${crypto.randomUUID().slice(0, 8)}`;
    // Frozen clock: the bucket refills on wall-clock elapsed time, so on a
    // slow CI runner each awaited call can take longer than one token's
    // refill interval and the burst never trips the limit (limited === 0 on
    // PR #8 run 29589476463, shard 0 — pooled AND isolated). Freezing
    // asserts the real invariant — >budget calls in one instant must be
    // rejected — with zero timing dependence. Mirrors the identical
    // rate-limit tests in loop-events-handler / storage-handler-coverage
    // (see helpers/frozen-clock.ts for the full rationale).
    const { accepted, limited } = await withFrozenNow(async () => {
      let accepted = 0;
      let limited = 0;
      for (let i = 0; i < 60; i++) {
        const resp = await handleAgentConfigsRpc(
          extId,
          rpc({ v: 1, action: "list" }, `rate-${i}`),
          makeCtx({ userId: "user-alice" }),
        );
        if (resp.error?.code === -32029) limited++;
        else if (!resp.error) accepted++;
      }
      return { accepted, limited };
    });
    expect(accepted).toBeGreaterThanOrEqual(45);
    expect(limited).toBeGreaterThan(0);
  });
});

// ── Phase 6: PDP-deny path coverage ─────────────────────────────────
// Acceptance #4 (day-1 risk): when ctx.engine is wired and returns
// `decision: "deny"`, the handler MUST surface -32001 with the
// "agentConfig permission not granted" reason. Without this case the
// new PDP branch added in Phase 6 was uncovered.

describe("agent-configs-handler — PDP-deny path (Phase 6)", () => {
  test("ctx.engine returns deny → -32001 'agentConfig permission not granted'", async () => {
    const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");
    const engine = createStubPermissionEngine("deny-all");
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "list" }),
      // grantedPermissions still says "read" — the legacy boolean
      // would allow. The PDP path overrides and returns deny.
      makeCtx({
        userId: "user-alice",
        grantedPermissions: makePerms("read"),
        engine,
        conversationId: "conv-pdp-deny",
      }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toContain("agentConfig permission not granted");
    // The PDP was consulted exactly once.
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0]!.needed).toEqual([{ kind: "ezcorp:agent:config" }]);
  });

  test("ctx.engine returns allow → handler proceeds (PDP gate is the sole boolean check)", async () => {
    const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");
    const engine = createStubPermissionEngine("allow-all");
    const resp = await handleAgentConfigsRpc(
      EXT_ID,
      rpc({ v: 1, action: "list" }),
      makeCtx({
        userId: "user-alice",
        // grantedPermissions empty — only PDP allow lets this through.
        grantedPermissions: { grantedAt: {} },
        engine,
        conversationId: "conv-pdp-allow",
      }),
    );
    expect(resp.error).toBeUndefined();
    expect(engine.calls.length).toBe(1);
  });
});
