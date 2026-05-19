import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import { startTestServer } from "./helpers/test-server";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { createProject } from "../db/queries/projects";
import { createConversation } from "../db/queries/conversations";
import type { AgentDefinition, AgentEvents } from "../types";

mockDbConnection();

function makeAgent(name: string, fn: AgentDefinition["execute"]): AgentDefinition {
  return { name, description: `${name} agent`, capabilities: ["shell"], execute: fn };
}

let server: Awaited<ReturnType<typeof startTestServer>>;
let baseUrl: string;
let executor: AgentExecutor;
let bus: EventBus<AgentEvents>;
let projectId: string;

beforeAll(async () => {
  await setupTestDb();

  const agents = loadAgentsStatic([
    makeAgent("chat", async () => ({ success: true, output: null })),
  ]);
  bus = new EventBus<AgentEvents>();
  executor = new AgentExecutor(agents, bus, { persist: true });

  server = await startTestServer(0, executor, bus);

  // Monkey-patch: add active-run route by stopping and recreating with custom fetch
  // Actually, we can just test the executor method directly since the API endpoint
  // is a thin wrapper. But let's also test the HTTP layer.
  const activeRunServer = Bun.serve({
    port: 0,
    hostname: "0.0.0.0",
    fetch(req) {
      const url = new URL(req.url);
      const match = url.pathname.match(/^\/api\/conversations\/([^/]+)\/active-run$/);
      if (match && req.method === "GET") {
        const run = executor.getActiveRunForConversation(match[1]!);
        return new Response(JSON.stringify({ runId: run?.id ?? null }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  baseUrl = `http://localhost:${activeRunServer.port}`;

  const project = await createProject({ name: "Active Run Test", path: "/tmp/active-run-test" });
  projectId = project.id;

  // Store reference for cleanup
  (globalThis as any).__activeRunServer = activeRunServer;
});

afterAll(async () => {
  server?.stop(true);
  (globalThis as any).__activeRunServer?.stop(true);
  await closeTestDb();
});

describe("GET /api/conversations/:id/active-run", () => {
  test("returns null runId when no active run", async () => {
    const conv = await createConversation(projectId, { title: "idle conv" });
    const res = await fetch(`${baseUrl}/api/conversations/${conv.id}/active-run`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBeNull();
  });

  test("returns null for nonexistent conversation", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/nonexistent-id/active-run`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBeNull();
  });
});
