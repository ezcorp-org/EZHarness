/**
 * Unit tests for the bundled ez-code coder agent + the FIXED-ID spawn
 * resolution that makes it resolvable for EVERY user — including after
 * the boot migration adopts ownerless rows into the first admin.
 *
 * Why id, not `userId: null`:  the first attempt seeded a `userId: null`
 * "system" row and resolved it only while ownerless. The boot migration
 * at `src/db/migrate.ts:~404`
 *   UPDATE agent_configs SET user_id = (admin) WHERE user_id IS NULL
 * adopts that row into the first admin, so a `userId === null` guard then
 * rejects it and dispatch fails. The fix keys on a FIXED, unforgeable id
 * (`getAgentConfig(id)` is `WHERE id = ?`, not user-scoped), which
 * survives the backfill (only `user_id` is rewritten) and resolves for
 * every user.
 *
 * THE REGRESSION GUARD: `resolveAgentConfigForUser` STILL resolves the
 * coder after its `user_id` is set to a real (non-null) user — the exact
 * scenario the prior mocked test missed.
 *
 * Module-mock isolation: this file replaces `../db/queries/agent-configs`
 * for the WHOLE process (bun mock.module is permanent), so it lives in
 * its own file and restores in afterAll.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { DbAgentConfig } from "../db/queries/agent-configs";

// In-memory agent_configs store the mocked queries operate over.
let rows: DbAgentConfig[];

function makeRow(partial: Partial<DbAgentConfig>): DbAgentConfig {
  return {
    id: partial.id ?? crypto.randomUUID(),
    name: partial.name ?? "anon",
    description: partial.description ?? "",
    prompt: partial.prompt ?? "",
    capabilities: partial.capabilities ?? ["llm"],
    references: partial.references ?? { agents: [], extensions: [] },
    userId: partial.userId ?? null,
    model: partial.model ?? null,
    provider: partial.provider ?? null,
  } as unknown as DbAgentConfig;
}

mock.module("../db/queries/agent-configs", () => ({
  // user-scoped view: own rows only (no shares in these tests). A
  // `userId: null` row is NOT returned for any user (mirrors the real
  // query's `WHERE user_id = ?`).
  listAgentConfigs: async (userId?: string) =>
    userId ? rows.filter((r) => r.userId === userId) : rows,
  // NOT user-scoped — `WHERE id = ?`.
  getAgentConfig: async (id: string) => rows.find((r) => r.id === id),
  createAgentConfig: async (data: {
    id?: string;
    name: string;
    description?: string;
    prompt?: string | null;
    capabilities?: string[];
    provider?: string;
    model?: string;
    userId?: string;
  }) => {
    const row = makeRow({
      id: data.id ?? crypto.randomUUID(),
      name: data.name,
      description: data.description ?? "",
      prompt: data.prompt ?? "",
      capabilities: data.capabilities ?? ["llm"],
      provider: data.provider ?? null,
      model: data.model ?? null,
      userId: (data.userId ?? null) as DbAgentConfig["userId"],
    });
    rows.push(row);
    return row;
  },
  deleteAgentConfigsByNameExceptId: async (name: string, keepId: string) => {
    const before = rows.length;
    rows = rows.filter((r) => !(r.name === name && r.id !== keepId));
    return before - rows.length;
  },
}));

afterAll(() => restoreModuleMocks());

const {
  ensureEzCodeCoderAgent,
  EZ_CODE_CODER_AGENT_ID,
  EZ_CODE_CODER_AGENT_NAME,
  isEzCodeCoderAlias,
} = await import("../extensions/ez-code-coder-agent");
const { resolveAgentConfigForUser } = await import(
  "../extensions/agent-configs-handler"
);

beforeEach(() => {
  rows = [];
});

describe("EZ_CODE_CODER_AGENT_ID", () => {
  test("is a fixed, well-formed lowercase UUID literal", () => {
    expect(EZ_CODE_CODER_AGENT_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("isEzCodeCoderAlias", () => {
  test("recognizes aliases case-insensitively + trimmed", () => {
    expect(isEzCodeCoderAlias("coder")).toBe(true);
    expect(isEzCodeCoderAlias("  CODER ")).toBe(true);
    expect(isEzCodeCoderAlias("ez-code")).toBe(true);
    expect(isEzCodeCoderAlias("ez-code coder")).toBe(true);
    expect(isEzCodeCoderAlias("Code Reviewer")).toBe(false);
  });
});

describe("ensureEzCodeCoderAgent", () => {
  test("creates the coder row AT THE FIXED ID", async () => {
    const created = await ensureEzCodeCoderAgent();
    expect(created.id).toBe(EZ_CODE_CODER_AGENT_ID);
    expect(created.name).toBe(EZ_CODE_CODER_AGENT_NAME);
    expect(created.capabilities).toContain("llm");
    expect((created.prompt ?? "").length).toBeGreaterThan(0);
    expect(rows).toHaveLength(1);
  });

  test("is idempotent — second call no-ops on the fixed-id row", async () => {
    const first = await ensureEzCodeCoderAgent();
    const second = await ensureEzCodeCoderAgent();
    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
  });

  test("dedupes a stale random-id row named 'ez-code coder'", async () => {
    // Simulate the leftover from the earlier (pre-fixed-id) version.
    rows.push(
      makeRow({
        id: "6e4caaab-stale-random-id",
        name: EZ_CODE_CODER_AGENT_NAME,
        userId: "admin-1",
      }),
    );
    const created = await ensureEzCodeCoderAgent();
    // The stale row is gone; exactly one canonical row at the fixed id.
    expect(created.id).toBe(EZ_CODE_CODER_AGENT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(EZ_CODE_CODER_AGENT_ID);
  });

  test("does NOT delete a user's unrelated agent with a different name", async () => {
    rows.push(makeRow({ id: "u-1", name: "My Helper", userId: "u-owns" }));
    await ensureEzCodeCoderAgent();
    expect(rows.find((r) => r.id === "u-1")).toBeDefined();
  });
});

describe("resolveAgentConfigForUser — bundled coder (fixed id)", () => {
  test("resolves the coder by the 'coder' alias for a non-owner user", async () => {
    await ensureEzCodeCoderAgent();
    const c = await resolveAgentConfigForUser("some-user", "coder");
    expect(c).not.toBeNull();
    expect(c!.id).toBe(EZ_CODE_CODER_AGENT_ID);
  });

  test("resolves the coder by its canonical name", async () => {
    await ensureEzCodeCoderAgent();
    const c = await resolveAgentConfigForUser("some-user", EZ_CODE_CODER_AGENT_NAME);
    expect(c!.id).toBe(EZ_CODE_CODER_AGENT_ID);
  });

  test("resolves the coder by passing the FIXED ID directly", async () => {
    await ensureEzCodeCoderAgent();
    const c = await resolveAgentConfigForUser("some-user", EZ_CODE_CODER_AGENT_ID);
    expect(c!.id).toBe(EZ_CODE_CODER_AGENT_ID);
  });

  // ── THE MANDATORY BACKFILL-SIMULATION REGRESSION TEST ──────────────
  test("STILL resolves the coder after migrate.ts adopts it into an admin (user_id set non-null)", async () => {
    await ensureEzCodeCoderAgent();
    // Simulate `migrate.ts:~404`: ownerless coder adopted by first admin.
    const coder = rows.find((r) => r.id === EZ_CODE_CODER_AGENT_ID)!;
    (coder as { userId: string | null }).userId = "admin-user-id";
    expect(coder.userId).not.toBeNull();

    // A DIFFERENT, non-admin user dispatches "coder" — it must STILL
    // resolve (by id). This is exactly what the userId===null guard broke.
    const c = await resolveAgentConfigForUser("a-totally-other-user", "coder");
    expect(c).not.toBeNull();
    expect(c!.id).toBe(EZ_CODE_CODER_AGENT_ID);
    // ...and by name + by id too.
    expect((await resolveAgentConfigForUser("x", EZ_CODE_CODER_AGENT_NAME))!.id).toBe(
      EZ_CODE_CODER_AGENT_ID,
    );
    expect((await resolveAgentConfigForUser("x", EZ_CODE_CODER_AGENT_ID))!.id).toBe(
      EZ_CODE_CODER_AGENT_ID,
    );
  });

  test("a user-planted impostor row named 'ez-code coder' is NOT served (id wins)", async () => {
    await ensureEzCodeCoderAgent();
    // An attacker creates their OWN row literally named "ez-code coder"
    // with a random id (the create API never lets them pick our id).
    rows.push(
      makeRow({
        id: "attacker-random-id",
        name: EZ_CODE_CODER_AGENT_NAME,
        userId: "attacker",
        prompt: "do something evil",
      }),
    );
    // Even the ATTACKER resolving "coder" gets the canonical fixed-id row,
    // because the alias fallback resolves strictly by the fixed id — never
    // by name match against arbitrary rows.
    const c = await resolveAgentConfigForUser("attacker", "coder");
    expect(c!.id).toBe(EZ_CODE_CODER_AGENT_ID);
    expect(c!.prompt).not.toContain("evil");
  });

  test("attacker's OWN distinctly-named row resolves for THEM, never hijacks 'coder'", async () => {
    await ensureEzCodeCoderAgent();
    // Attacker owns a row named "evilcoder" — their own scope resolves it
    // by that exact name; it never collides with the coder aliases.
    rows.push(makeRow({ id: "evil-1", name: "evilcoder", userId: "attacker" }));
    const own = await resolveAgentConfigForUser("attacker", "evilcoder");
    expect(own!.id).toBe("evil-1");
    // But "coder" still resolves the canonical bundled agent.
    const coder = await resolveAgentConfigForUser("attacker", "coder");
    expect(coder!.id).toBe(EZ_CODE_CODER_AGENT_ID);
  });

  test("alias fallback returns null when the coder row is absent", async () => {
    const c = await resolveAgentConfigForUser("some-user", "coder");
    expect(c).toBeNull();
  });

  test("a non-alias unknown name returns null (no cross-user leak)", async () => {
    await ensureEzCodeCoderAgent();
    const c = await resolveAgentConfigForUser("some-user", "nonesuch");
    expect(c).toBeNull();
  });

  test("a user's OWN row literally named 'coder' wins over the system fallback", async () => {
    await ensureEzCodeCoderAgent();
    rows.push(makeRow({ id: "owned-coder", name: "coder", userId: "u-owns" }));
    const c = await resolveAgentConfigForUser("u-owns", "coder");
    expect(c!.id).toBe("owned-coder");
  });
});
