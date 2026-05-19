import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  createAgentConfig,
  getAgentConfig,
  getAgentConfigByName,
  listAgentConfigs,
  updateAgentConfig,
  deleteAgentConfig,
  listDbAgentEntries,
  flattenMemberIds,
  AgentValidationError,
} = await import("../db/queries/agent-configs");
const { createUser } = await import("../db/queries/users");

describe("agent-configs queries", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("createAgentConfig creates with defaults", async () => {
    const cfg = await createAgentConfig({
      name: "helper",
      description: "a helper",
      prompt: "you help",
    });

    expect(cfg.id).toBeDefined();
    expect(cfg.name).toBe("helper");
    expect(cfg.description).toBe("a helper");
    expect(cfg.capabilities).toEqual(["llm"]);
    expect(cfg.outputFormat).toBe("text");
    expect(cfg.category).toBeNull();
    expect(cfg.extensions).toEqual([]);
    expect(cfg.references).toEqual({ agents: [], extensions: [] });
    expect(cfg.userId).toBeNull();
    expect(cfg.createdAt).toBeInstanceOf(Date);
    expect(cfg.updatedAt).toBeInstanceOf(Date);
  });

  test("createAgentConfig accepts overrides", async () => {
    const owner = await createUser({ email: "own1@test.com", passwordHash: "h", name: "Own1" });
    const cfg = await createAgentConfig({
      name: "analyst",
      description: "analyst",
      prompt: "you analyze",
      capabilities: ["llm", "tool-use"],
      outputFormat: "json",
      temperature: 0.2,
      maxTokens: 4096,
      category: "Development",
      userId: owner.id,
    } as any);

    expect(cfg.capabilities).toEqual(["llm", "tool-use"]);
    expect(cfg.outputFormat).toBe("json");
    expect(cfg.temperature).toBe(0.2);
    expect(cfg.maxTokens).toBe(4096);
    expect(cfg.category).toBe("Development");
    expect(cfg.userId).toBe(owner.id);
  });

  test("getAgentConfig returns by id", async () => {
    const created = await createAgentConfig({ name: "find-me", description: "d", prompt: "p" });
    const found = await getAgentConfig(created.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
    expect(found!.name).toBe("find-me");
  });

  test("getAgentConfig returns undefined for missing id", async () => {
    const result = await getAgentConfig(crypto.randomUUID());
    expect(result).toBeUndefined();
  });

  test("getAgentConfigByName returns by name", async () => {
    await createAgentConfig({ name: "unique-named", description: "d", prompt: "p" });
    const found = await getAgentConfigByName("unique-named");
    expect(found).toBeDefined();
    expect(found!.name).toBe("unique-named");
  });

  test("getAgentConfigByName returns undefined for missing name", async () => {
    const result = await getAgentConfigByName("no-such-agent");
    expect(result).toBeUndefined();
  });

  test("listAgentConfigs returns all configs (no user)", async () => {
    await createAgentConfig({ name: "a", description: "d", prompt: "p" });
    await createAgentConfig({ name: "b", description: "d", prompt: "p" });
    const rows = await listAgentConfigs();
    expect(rows.length).toBe(2);
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["a", "b"]);
  });

  test("listAgentConfigs filtered by userId returns owned with shared=false", async () => {
    const u1 = await createUser({ email: "u1@test.com", passwordHash: "h", name: "U1" });
    const u2 = await createUser({ email: "u2@test.com", passwordHash: "h", name: "U2" });
    await createAgentConfig({ name: "owned-1", description: "d", prompt: "p", userId: u1.id } as any);
    await createAgentConfig({ name: "other-owned", description: "d", prompt: "p", userId: u2.id } as any);
    const rows = await listAgentConfigs(u1.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.name).toBe("owned-1");
    expect(rows[0]!.shared).toBe(false);
  });

  test("updateAgentConfig updates fields", async () => {
    const created = await createAgentConfig({ name: "orig", description: "old", prompt: "p" });
    const updated = await updateAgentConfig(created.id, {
      name: "renamed",
      description: "new",
      temperature: 0.7,
    });

    expect(updated).toBeDefined();
    expect(updated!.name).toBe("renamed");
    expect(updated!.description).toBe("new");
    expect(updated!.temperature).toBe(0.7);
    // prompt not touched
    expect(updated!.prompt).toBe("p");
    // updatedAt changed (note: PGlite can round to same ms; assert >= rather than >)
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  test("updateAgentConfig returns undefined for missing id", async () => {
    const result = await updateAgentConfig(crypto.randomUUID(), { name: "nope" });
    expect(result).toBeUndefined();
  });

  test("deleteAgentConfig removes row and returns true", async () => {
    const created = await createAgentConfig({ name: "del-me", description: "d", prompt: "p" });
    const deleted = await deleteAgentConfig(created.id);
    expect(deleted).toBe(true);
    const found = await getAgentConfig(created.id);
    expect(found).toBeUndefined();
  });

  test("deleteAgentConfig returns false for missing id", async () => {
    const result = await deleteAgentConfig(crypto.randomUUID());
    expect(result).toBe(false);
  });

  test("listDbAgentEntries maps rows to entries with source='config'", async () => {
    await createAgentConfig({
      name: "entry-agent",
      description: "an entry",
      prompt: "p",
      capabilities: ["llm"],
      category: "Productivity",
    } as any);

    const entries = await listDbAgentEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]!.name).toBe("entry-agent");
    expect(entries[0]!.source).toBe("config");
    expect(entries[0]!.category).toBe("Productivity");
    expect(entries[0]!.id).toBeDefined();
  });

  test("flattenMemberIds flattens nested members and dedupes", () => {
    const result = flattenMemberIds([
      {
        agentConfigId: "a1",
        subAgents: [
          { agentConfigId: "a2", subAgents: [] },
          { agentConfigId: "a3", subAgents: [{ agentConfigId: "a1", subAgents: [] }] },
        ],
      },
      { agentConfigId: "a4", subAgents: [] },
    ] as any);
    expect(result.sort()).toEqual(["a1", "a2", "a3", "a4"]);
  });

  test("createAgentConfig detects circular agent references", async () => {
    const a = await createAgentConfig({ name: "ref-a", description: "d", prompt: "p" });
    const b = await createAgentConfig({
      name: "ref-b",
      description: "d",
      prompt: "p",
      references: { agents: [a.id] },
    } as any);

    // Now update A to reference B → cycle A -> B -> A
    await expect(
      updateAgentConfig(a.id, { references: { agents: [b.id] } } as any),
    ).rejects.toBeInstanceOf(AgentValidationError);
  });
});
