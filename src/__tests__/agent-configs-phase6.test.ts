import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  createAgentConfig,
  getAgentConfig,
  updateAgentConfig,
  deleteAgentConfig,
  listDbAgentEntries,
} from "../db/queries/agent-configs";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe("agent-configs Phase 6", () => {
  test("createAgentConfig with category persists correctly", async () => {
    const config = await createAgentConfig({
      name: "finance-agent",
      description: "Handles finances",
      prompt: "You are a finance expert.",
      category: "productivity",
    });
    expect(config.id).toBeDefined();
    expect(config.name).toBe("finance-agent");
    expect(config.category).toBe("productivity");
    expect(config.prompt).toBe("You are a finance expert.");
  });

  test("createAgentConfig without category defaults to null", async () => {
    const config = await createAgentConfig({
      name: "no-category-agent",
      description: "No category",
      prompt: "You are an agent.",
    });
    expect(config.category).toBeNull();
  });

  test("updateAgentConfig can update category", async () => {
    const config = await createAgentConfig({
      name: "updatable-agent",
      description: "Will be updated",
      prompt: "Original prompt",
      category: "old-category",
    });

    const updated = await updateAgentConfig(config.id, { category: "new-category" });
    expect(updated).toBeDefined();
    expect(updated!.category).toBe("new-category");
  });

  test("updateAgentConfig can set category to null", async () => {
    const config = await createAgentConfig({
      name: "nullable-cat-agent",
      description: "Category will be nulled",
      prompt: "Prompt",
      category: "some-category",
    });

    const updated = await updateAgentConfig(config.id, { category: null });
    expect(updated).toBeDefined();
    expect(updated!.category).toBeNull();
  });

  test("getAgentConfig returns row with category field", async () => {
    const config = await createAgentConfig({
      name: "get-test-agent",
      description: "For get test",
      prompt: "Prompt here",
      category: "testing",
    });

    const fetched = await getAgentConfig(config.id);
    expect(fetched).toBeDefined();
    expect(fetched!.category).toBe("testing");
    expect(fetched!.name).toBe("get-test-agent");
    expect(fetched!.prompt).toBe("Prompt here");
  });

  test("listDbAgentEntries returns AgentListEntry with source, id, prompt, category", async () => {
    const entries = await listDbAgentEntries();
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(entry.source).toBe("config");
      expect(entry.id).not.toBeNull();
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.description).toBe("string");
      expect(Array.isArray(entry.capabilities)).toBe(true);
      expect(entry).toHaveProperty("prompt");
      expect(entry).toHaveProperty("category");
    }

    // Verify one we know has a category
    const financeEntry = entries.find((e) => e.name === "finance-agent");
    expect(financeEntry).toBeDefined();
    expect(financeEntry!.category).toBe("productivity");
    expect(financeEntry!.prompt).toBe("You are a finance expert.");
  });

  test("listDbAgentEntries maps capabilities correctly", async () => {
    const _config = await createAgentConfig({
      name: "multi-cap-agent",
      description: "Agent with multiple caps",
      prompt: "Prompt",
      capabilities: ["llm", "tools", "code"],
    });

    const entries = await listDbAgentEntries();
    const entry = entries.find((e) => e.name === "multi-cap-agent");
    expect(entry).toBeDefined();
    expect(entry!.capabilities).toEqual(["llm", "tools", "code"]);
  });

  test("deleteAgentConfig removes config", async () => {
    const config = await createAgentConfig({
      name: "delete-me-agent",
      description: "Will be deleted",
      prompt: "Prompt",
    });

    const deleted = await deleteAgentConfig(config.id);
    expect(deleted).toBe(true);

    const fetched = await getAgentConfig(config.id);
    expect(fetched).toBeUndefined();
  });

  test("deleteAgentConfig returns false for nonexistent id", async () => {
    const deleted = await deleteAgentConfig("nonexistent-id");
    expect(deleted).toBe(false);
  });
});
