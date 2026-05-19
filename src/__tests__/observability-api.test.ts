import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupPiAiMocks } from "./helpers/mock-pi-ai";

// Set up pi-ai mocks BEFORE any imports that trigger executor module loading
setupPiAiMocks({ textChunks: ["Hello"] });

import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgents } from "../runtime/loader";
import { startTestServer as startServer } from "./helpers/test-server";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import { createProject } from "../db/queries/projects";
import { insertObservabilityEvent } from "../db/queries/observability";
import { createConversation, createMessage } from "../db/queries/conversations";
import type { AgentEvents } from "../types";

mockDbConnection();

mockRealSettings();
let server: Awaited<ReturnType<typeof startServer>>;
let baseUrl: string;
let bus: EventBus<AgentEvents>;
let convId: string;

beforeAll(async () => {
  await setupTestDb();
  const agents = await loadAgents(import.meta.dir + "/../agents");
  bus = new EventBus<AgentEvents>();
  const executor = new AgentExecutor(agents, bus);
  server = await startServer(0, executor, bus);
  baseUrl = `http://localhost:${server.port}`;

  const project = await createProject({ name: "Obs Test", path: "/tmp/obs-test" });
  const conv = await createConversation(project.id, { title: "Obs Conv" });
  convId = conv.id;

  await createMessage(convId, {
    role: "assistant",
    content: "hi",
    usage: { inputTokens: 100, outputTokens: 50 },
  });
  await insertObservabilityEvent({
    conversationId: convId,
    eventType: "turn_summary",
    data: { tokenUsage: { input: 100, output: 50 } },
    durationMs: 200,
  });
  await insertObservabilityEvent({
    conversationId: convId,
    eventType: "tool_call",
    data: { extensionId: "ext-fs", toolName: "readFile", success: true },
    durationMs: 15,
  });
});

afterAll(async () => {
  server?.stop(true);
  await closeTestDb();
});

describe("Observability API", () => {
  test("GET /api/observability/conversations/:convId returns events", async () => {
    const res = await fetch(`${baseUrl}/api/observability/conversations/${convId}`);
    expect(res.status).toBe(200);
    const events = (await res.json()) as any[];
    expect(events.length).toBe(2);
    expect(events.map((e: any) => e.eventType).sort()).toEqual(["tool_call", "turn_summary"]);
  });

  test("GET /api/observability/conversations/:convId/stats returns aggregated stats", async () => {
    const res = await fetch(`${baseUrl}/api/observability/conversations/${convId}/stats`);
    expect(res.status).toBe(200);
    const stats = (await res.json()) as any;
    expect(stats.totalInputTokens).toBe(100);
    expect(stats.totalOutputTokens).toBe(50);
    expect(stats.totalToolCalls).toBe(1);
    expect(stats.turnCount).toBe(1);
    expect(stats.avgDurationMs).toBe(200);
  });

  test("GET /api/observability/stats returns global stats", async () => {
    const res = await fetch(`${baseUrl}/api/observability/stats`);
    expect(res.status).toBe(200);
    const stats = (await res.json()) as any;
    expect(stats).toHaveProperty("totalInputTokens");
    expect(stats).toHaveProperty("totalOutputTokens");
    expect(stats).toHaveProperty("totalToolCalls");
    expect(stats).toHaveProperty("totalTurnCount");
    expect(stats).toHaveProperty("avgResponseMs");
    expect(stats).toHaveProperty("tokensByDay");
    expect(stats).toHaveProperty("topExtensions");
  });

  test("GET /api/observability/stats?days=7 supports days filter", async () => {
    const res = await fetch(`${baseUrl}/api/observability/stats?days=7`);
    expect(res.status).toBe(200);
    const stats = (await res.json()) as any;
    expect(stats.totalInputTokens).toBeGreaterThanOrEqual(100);
    expect(stats.totalToolCalls).toBeGreaterThanOrEqual(1);
  });

  test("GET /api/observability/stats returns non-empty tokensByDay when messages have usage", async () => {
    const res = await fetch(`${baseUrl}/api/observability/stats`);
    expect(res.status).toBe(200);
    const stats = (await res.json()) as any;
    expect(Array.isArray(stats.tokensByDay)).toBe(true);
    expect(stats.tokensByDay.length).toBeGreaterThan(0);

    const total = stats.tokensByDay.reduce(
      (acc: { input: number; output: number }, d: { input: number; output: number }) => ({
        input: acc.input + d.input,
        output: acc.output + d.output,
      }),
      { input: 0, output: 0 },
    );
    expect(total.input).toBe(100);
    expect(total.output).toBe(50);
  });
});
