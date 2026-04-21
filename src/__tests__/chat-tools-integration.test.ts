import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupPiAiMocks } from "./helpers/mock-pi-ai";

// Set up pi-ai mocks BEFORE any imports that trigger executor module loading
setupPiAiMocks({ textChunks: ["Hello", " world"] });

import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgents } from "../runtime/loader";
import { startTestServer as startServer } from "./helpers/test-server";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import { createProject } from "../db/queries/projects";
import type { AgentEvents } from "../types";

mockDbConnection();

mockRealSettings();
let server: Awaited<ReturnType<typeof startServer>>;
let baseUrl: string;
let bus: EventBus<AgentEvents>;
let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  const agents = await loadAgents(import.meta.dir + "/../agents");
  bus = new EventBus<AgentEvents>();
  const executor = new AgentExecutor(agents, bus);
  server = await startServer(0, executor, bus);
  baseUrl = `http://localhost:${server.port}`;
  const project = await createProject({ name: "Tools Integration", path: "/tmp/tools-int" });
  projectId = project.id;
});

afterAll(async () => {
  server?.stop(true);
  await closeTestDb();
});

async function createConvAndSend(title: string, content: string) {
  const createRes = await fetch(`${baseUrl}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, title }),
  });
  const conv = (await createRes.json()) as any;
  const msgRes = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  expect(msgRes.status).toBe(200);
  return conv;
}

describe("Chat observability integration", () => {
  test("obs:turn event is emitted during chat", async () => {
    let turnEvent: any = null;
    const off = bus.on("obs:turn", (data) => { turnEvent = data; });
    const conv = await createConvAndSend("Obs Turn Test", "hello obs");
    await new Promise((r) => setTimeout(r, 300));
    expect(turnEvent).not.toBeNull();
    expect(turnEvent.conversationId).toBe(conv.id);
    expect(turnEvent.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(turnEvent.tokenUsage).toEqual({ input: 10, output: 5 });
    off();
  });

  test("run:usage event fires with correct token counts", async () => {
    let usage: any = null;
    const off = bus.on("run:usage", (data) => { usage = data.usage; });
    await createConvAndSend("Usage Event Test", "check usage");
    await new Promise((r) => setTimeout(r, 200));
    // Usage from pi-ai format
    expect(usage).toBeDefined();
    expect(usage.input).toBe(10);
    expect(usage.output).toBe(5);
    off();
  });

  test("observability events are persisted and queryable via API", async () => {
    const conv = await createConvAndSend("Obs Persist Test", "persist check");
    await new Promise((r) => setTimeout(r, 400));
    const res = await fetch(`${baseUrl}/api/observability/conversations/${conv.id}`);
    expect(res.status).toBe(200);
    const events = (await res.json()) as any[];
    expect(events.length).toBeGreaterThanOrEqual(1);
    const turnSummary = events.find((e: any) => e.eventType === "turn_summary");
    expect(turnSummary).toBeDefined();
    expect(turnSummary.data.tokenUsage.input).toBe(10);
    expect(turnSummary.data.tokenUsage.output).toBe(5);
  });
});
