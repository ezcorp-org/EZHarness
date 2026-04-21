import { test, expect, describe, beforeAll, afterAll, mock, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  createAgentConfig,
  updateAgentConfig,
  AgentValidationError,
} from "../db/queries/agent-configs";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe("AgentValidationError", () => {
  test("has status 400", () => {
    const err = new AgentValidationError("test");
    expect(err.status).toBe(400);
  });

  test("has name AgentValidationError", () => {
    const err = new AgentValidationError("cycle found");
    expect(err.name).toBe("AgentValidationError");
  });

  test("message is set correctly", () => {
    const err = new AgentValidationError("Circular reference: A -> B -> A");
    expect(err.message).toBe("Circular reference: A -> B -> A");
  });
});

describe("agent-configs validation", () => {
  test("creating agent with no references succeeds", async () => {
    const config = await createAgentConfig({
      name: "val-no-refs",
      description: "No references",
      prompt: "You are an agent.",
    });
    expect(config.id).toBeDefined();
    expect(config.references).toEqual({ agents: [], extensions: [] });
  });

  test("creating agent with valid references succeeds", async () => {
    const target = await createAgentConfig({
      name: "val-target",
      description: "Target agent",
      prompt: "Prompt",
    });

    const config = await createAgentConfig({
      name: "val-with-refs",
      description: "Has references",
      prompt: "Prompt",
      references: { agents: [target.id], extensions: [] },
    });

    expect(config.id).toBeDefined();
    const refs = config.references as { agents: string[]; extensions: string[] };
    expect(refs.agents).toContain(target.id);
  });

  test("creating agent that would create cycle throws AgentValidationError", async () => {
    // A -> B
    const agentA = await createAgentConfig({
      name: "val-cycle-a",
      description: "A",
      prompt: "Prompt",
    });
    const agentB = await createAgentConfig({
      name: "val-cycle-b",
      description: "B",
      prompt: "Prompt",
      references: { agents: [agentA.id], extensions: [] },
    });

    // Now try to make A -> B where B already -> A => cycle
    // Update A to reference B
    try {
      await updateAgentConfig(agentA.id, {
        references: { agents: [agentB.id], extensions: [] },
      });
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(AgentValidationError);
      expect((err as AgentValidationError).status).toBe(400);
      expect((err as Error).message).toContain("Circular reference");
    }
  });

  test("updating agent references persists to DB", async () => {
    const target = await createAgentConfig({
      name: "val-update-target",
      description: "Target",
      prompt: "Prompt",
    });
    const agent = await createAgentConfig({
      name: "val-update-src",
      description: "Source",
      prompt: "Prompt",
    });

    const updated = await updateAgentConfig(agent.id, {
      references: { agents: [target.id], extensions: ["ext-1"] },
    });

    expect(updated).toBeDefined();
    const refs = updated!.references as { agents: string[]; extensions: string[] };
    expect(refs.agents).toContain(target.id);
    expect(refs.extensions).toContain("ext-1");
  });

  test("updating agent with circular references throws AgentValidationError", async () => {
    const a = await createAgentConfig({
      name: "val-circ-update-a",
      description: "A",
      prompt: "Prompt",
    });
    const b = await createAgentConfig({
      name: "val-circ-update-b",
      description: "B",
      prompt: "Prompt",
      references: { agents: [a.id], extensions: [] },
    });

    await expect(
      updateAgentConfig(a.id, { references: { agents: [b.id], extensions: [] } }),
    ).rejects.toThrow(AgentValidationError);
  });

  test("references default to { agents: [], extensions: [] } when not provided", async () => {
    const config = await createAgentConfig({
      name: "val-default-refs",
      description: "No refs provided",
      prompt: "Prompt",
    });

    expect(config.references).toEqual({ agents: [], extensions: [] });
  });

  test("references with only extensions skips DAG validation", async () => {
    // This should not throw — no agent refs means no cycle check
    const config = await createAgentConfig({
      name: "val-ext-only",
      description: "Extensions only",
      prompt: "Prompt",
      references: { agents: [], extensions: ["ext-a", "ext-b"] },
    });

    expect(config.id).toBeDefined();
    const refs = config.references as { agents: string[]; extensions: string[] };
    expect(refs.extensions).toEqual(["ext-a", "ext-b"]);
    expect(refs.agents).toEqual([]);
  });
});
