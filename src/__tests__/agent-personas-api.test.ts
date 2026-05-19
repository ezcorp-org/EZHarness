import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupPiAiMocks } from "./helpers/mock-pi-ai";

// Set up pi-ai mocks BEFORE any imports that trigger executor module loading
setupPiAiMocks({ textChunks: ["hi"] });

import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgents } from "../runtime/loader";
import { startTestServer as startServer } from "./helpers/test-server";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import { createProject } from "../db/queries/projects";
import { createAgentConfig } from "../db/queries/agent-configs";
import type { AgentEvents } from "../types";

mockDbConnection();

mockRealSettings();
let server: Awaited<ReturnType<typeof startServer>>;
let baseUrl: string;
let projectId: string;
let agentConfigId: string;
let agentName: string;
let agentPrompt: string;

beforeAll(async () => {
  await setupTestDb();
  const agents = await loadAgents(import.meta.dir + "/../agents");
  const bus = new EventBus<AgentEvents>();
  const executor = new AgentExecutor(agents, bus);
  server = await startServer(0, executor, bus);
  baseUrl = `http://localhost:${server.port}`;

  const project = await createProject({ name: "API Test Project", path: "/tmp/api-test" });
  projectId = project.id;

  const config = await createAgentConfig({
    name: "api-test-agent",
    description: "Agent for API tests",
    prompt: "You are the API test agent.",
    category: "api-testing",
  });
  agentConfigId = config.id;
  agentName = config.name;
  agentPrompt = config.prompt;
});

afterAll(async () => {
  server?.stop(true);
  await closeTestDb();
});

// ── GET /api/agents -- enriched response ──────────────────────────────

describe("GET /api/agents -- enriched agent list", () => {
  test("returns agents with source, id, prompt, category fields", async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    const agents = (await res.json()) as any[];
    expect(agents.length).toBeGreaterThan(0);

    for (const agent of agents) {
      expect(agent).toHaveProperty("name");
      expect(agent).toHaveProperty("description");
      expect(agent).toHaveProperty("capabilities");
      expect(agent).toHaveProperty("source");
      expect(agent).toHaveProperty("id");
      expect(agent).toHaveProperty("prompt");
      expect(agent).toHaveProperty("category");
    }
  });

  test("file agents without DB config have source:'file', null id/prompt/category", async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    const agents = (await res.json()) as any[];
    // Find an agent that is not "api-test-agent" -- it should be file-only
    const fileAgent = agents.find((a: any) => a.name !== agentName);
    if (fileAgent) {
      expect(fileAgent.source).toBe("file");
      expect(fileAgent.id).toBeNull();
      expect(fileAgent.prompt).toBeNull();
      expect(fileAgent.category).toBeNull();
    }
  });

  test("config agent matching a file agent has source:'config' with enriched fields", async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    const agents = (await res.json()) as any[];
    const _configAgent = agents.find((a: any) => a.name === agentName);
    // Only present if the file agent shares the same name; otherwise it won't appear
    // since the endpoint maps over file agents only.
    // Test the DB entries directly for full coverage:
    const { listDbAgentEntries } = await import("../db/queries/agent-configs");
    const entries = await listDbAgentEntries();
    const entry = entries.find((e) => e.name === agentName);
    expect(entry).toBeDefined();
    expect(entry!.source).toBe("config");
    expect(entry!.id).toBe(agentConfigId);
    expect(entry!.prompt).toBe(agentPrompt);
    expect(entry!.category).toBe("api-testing");
  });
});

// ── POST /api/conversations -- agentConfigId handling ─────────────────

describe("POST /api/conversations -- agentConfigId via HTTP", () => {
  test("POST with agentConfigId sets systemPrompt from agent config's prompt", async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, agentConfigId }),
    });
    expect(res.status).toBe(201);
    const conv = (await res.json()) as any;
    expect(conv.agentConfigId).toBe(agentConfigId);
    expect(conv.systemPrompt).toBe(agentPrompt);
  });

  test("POST with agentConfigId auto-sets title to 'Chat with {agentName}'", async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, agentConfigId }),
    });
    expect(res.status).toBe(201);
    const conv = (await res.json()) as any;
    expect(conv.title).toBe(`Chat with ${agentName}`);
  });

  test("POST with agentConfigId and custom title uses provided title", async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, agentConfigId, title: "Custom Title" }),
    });
    expect(res.status).toBe(201);
    const conv = (await res.json()) as any;
    expect(conv.title).toBe("Custom Title");
  });

  test("POST with nonexistent agentConfigId returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, agentConfigId: "nonexistent-id" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toBe("Agent config not found");
  });

  test("POST without agentConfigId works as before (no regression)", async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title: "Normal Chat", model: "gpt-4o" }),
    });
    expect(res.status).toBe(201);
    const conv = (await res.json()) as any;
    expect(conv.agentConfigId).toBeNull();
    expect(conv.systemPrompt).toBeNull();
    expect(conv.title).toBe("Normal Chat");
    expect(conv.model).toBe("gpt-4o");
  });

  test("returned conversation has agentConfigId persisted in DB", async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, agentConfigId }),
    });
    const conv = (await res.json()) as any;

    // Verify via GET
    const getRes = await fetch(`${baseUrl}/api/conversations/${conv.id}`);
    const fetched = (await getRes.json()) as any;
    expect(fetched.agentConfigId).toBe(agentConfigId);
    expect(fetched.systemPrompt).toBe(agentPrompt);
  });
});
