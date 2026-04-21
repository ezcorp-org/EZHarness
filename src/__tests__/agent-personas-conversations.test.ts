import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  createConversation,
  getConversation,
  updateConversation,
  listConversations,
} from "../db/queries/conversations";
import { createAgentConfig } from "../db/queries/agent-configs";
import { createProject } from "../db/queries/projects";

let projectId: string;
let agentConfigId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Agent Conv Test", path: "/tmp/agent-conv" });
  projectId = project.id;

  const config = await createAgentConfig({
    name: "test-persona",
    description: "A test persona",
    prompt: "You are a helpful test persona.",
    category: "testing",
  });
  agentConfigId = config.id;
});

afterAll(async () => {
  await closeTestDb();
});

describe("conversations Phase 6 — agentConfigId & systemPrompt", () => {
  test("createConversation with agentConfigId stores the FK", async () => {
    const conv = await createConversation(projectId, { agentConfigId });
    expect(conv.agentConfigId).toBe(agentConfigId);
  });

  test("createConversation with systemPrompt stores it", async () => {
    const conv = await createConversation(projectId, {
      systemPrompt: "You are a pirate.",
    });
    expect(conv.systemPrompt).toBe("You are a pirate.");
  });

  test("createConversation with both agentConfigId and systemPrompt stores both", async () => {
    const conv = await createConversation(projectId, {
      agentConfigId,
      systemPrompt: "Custom system prompt",
    });
    expect(conv.agentConfigId).toBe(agentConfigId);
    expect(conv.systemPrompt).toBe("Custom system prompt");
  });

  test("createConversation without agentConfigId leaves it null", async () => {
    const conv = await createConversation(projectId, { title: "No Agent" });
    expect(conv.agentConfigId).toBeNull();
    expect(conv.systemPrompt).toBeNull();
  });

  test("updateConversation can set agentConfigId", async () => {
    const conv = await createConversation(projectId);
    expect(conv.agentConfigId).toBeNull();

    const updated = await updateConversation(conv.id, { agentConfigId });
    expect(updated).not.toBeNull();
    expect(updated!.agentConfigId).toBe(agentConfigId);
  });

  test("getConversation returns agentConfigId field", async () => {
    const conv = await createConversation(projectId, { agentConfigId });
    const fetched = await getConversation(conv.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.agentConfigId).toBe(agentConfigId);
  });

  test("listConversations returns conversations with agentConfigId field", async () => {
    const convs = await listConversations(projectId);
    expect(convs.length).toBeGreaterThan(0);
    // At least one should have agentConfigId set
    const withAgent = convs.find((c) => c.agentConfigId === agentConfigId);
    expect(withAgent).toBeDefined();
  });

  test("schema has agent_config_id column on conversations", async () => {
    const conv = await createConversation(projectId, { agentConfigId });
    const fetched = await getConversation(conv.id);
    expect(fetched).toHaveProperty("agentConfigId");
  });
});
