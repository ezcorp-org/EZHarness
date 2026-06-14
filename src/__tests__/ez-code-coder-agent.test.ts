/**
 * Unit tests for the bundled ez-code coder agent + the spawn-path
 * fallback that makes it resolvable for EVERY user.
 *
 * The crux this locks in: `dispatch_run` → SDK `spawnAssignment` →
 * host `resolveAgentConfigForUser(userId, idOrName)`, which only resolves
 * `agent_configs` DB rows scoped to the user (own + shared). The bundled
 * coder is a SYSTEM row (`userId: null`) that no user "owns", so it would
 * be invisible without the name-fallback added in
 * `agent-configs-handler.ts`. These tests prove:
 *   - `ensureEzCodeCoderAgent()` creates the row once, idempotently.
 *   - `resolveAgentConfigForUser` resolves the coder by its canonical
 *     name AND the `"coder"` alias, for a user who does NOT own it.
 *   - A non-alias miss still returns null (no cross-user leak).
 *   - An explicit user-scoped row still wins.
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
  // user-scoped view: own rows + (no shares in these tests).
  listAgentConfigs: async (userId?: string) =>
    userId ? rows.filter((r) => r.userId === userId) : rows,
  getAgentConfigByName: async (name: string) =>
    rows.find((r) => r.name === name),
  createAgentConfig: async (data: {
    name: string;
    description?: string;
    prompt?: string | null;
    capabilities?: string[];
    provider?: string;
    model?: string;
    userId?: string;
  }) => {
    const row = makeRow({
      name: data.name,
      description: data.description ?? "",
      prompt: data.prompt ?? "",
      capabilities: data.capabilities ?? ["llm"],
      provider: data.provider ?? null,
      model: data.model ?? null,
      // mirror createAgentConfig's `data.userId ?? null`.
      userId: (data.userId ?? null) as DbAgentConfig["userId"],
    });
    rows.push(row);
    return row;
  },
}));

afterAll(() => restoreModuleMocks());

const { ensureEzCodeCoderAgent, EZ_CODE_CODER_AGENT_NAME, isEzCodeCoderAlias } =
  await import("../extensions/ez-code-coder-agent");
const { resolveAgentConfigForUser } = await import(
  "../extensions/agent-configs-handler"
);

beforeEach(() => {
  rows = [];
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
  test("creates a SYSTEM (userId:null) coder row once", async () => {
    const created = await ensureEzCodeCoderAgent();
    expect(created.name).toBe(EZ_CODE_CODER_AGENT_NAME);
    expect(created.userId).toBeNull();
    expect(created.capabilities).toContain("llm");
    expect(typeof created.prompt).toBe("string");
    expect((created.prompt ?? "").length).toBeGreaterThan(0);
    expect(rows).toHaveLength(1);
  });

  test("is idempotent — second call no-ops on the name match", async () => {
    const first = await ensureEzCodeCoderAgent();
    const second = await ensureEzCodeCoderAgent();
    expect(second.id).toBe(first.id);
    expect(rows).toHaveLength(1);
  });
});

describe("resolveAgentConfigForUser — bundled coder fallback", () => {
  test("resolves the SYSTEM coder by canonical name for a non-owner user", async () => {
    await ensureEzCodeCoderAgent();
    const c = await resolveAgentConfigForUser("some-user", EZ_CODE_CODER_AGENT_NAME);
    expect(c).not.toBeNull();
    expect(c!.name).toBe(EZ_CODE_CODER_AGENT_NAME);
    expect(c!.userId).toBeNull();
  });

  test("resolves the SYSTEM coder by the 'coder' alias for a non-owner user", async () => {
    await ensureEzCodeCoderAgent();
    const c = await resolveAgentConfigForUser("some-user", "coder");
    expect(c).not.toBeNull();
    expect(c!.name).toBe(EZ_CODE_CODER_AGENT_NAME);
  });

  test("alias fallback miss returns null when the coder row is absent", async () => {
    // Coder not ensured → even an alias must not resolve.
    const c = await resolveAgentConfigForUser("some-user", "coder");
    expect(c).toBeNull();
  });

  test("a non-alias unknown name returns null (no cross-user leak)", async () => {
    await ensureEzCodeCoderAgent();
    const c = await resolveAgentConfigForUser("some-user", "nonesuch");
    expect(c).toBeNull();
  });

  test("an explicit user-owned row wins over the system fallback", async () => {
    await ensureEzCodeCoderAgent();
    // A user owns a DIFFERENT agent literally named "coder" — their own
    // row resolves (user scope wins before the alias fallback).
    rows.push(
      makeRow({ id: "owned-coder", name: "coder", userId: "u-owns" }),
    );
    const c = await resolveAgentConfigForUser("u-owns", "coder");
    expect(c).not.toBeNull();
    expect(c!.id).toBe("owned-coder");
  });
});
