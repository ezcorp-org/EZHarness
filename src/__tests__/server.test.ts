import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgents } from "../runtime/loader";
import { startTestServer as startServer } from "./helpers/test-server";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import type { AgentEvents } from "../types";

mockDbConnection();

mockRealSettings();
let server: Awaited<ReturnType<typeof startServer>>;
let baseUrl: string;

beforeAll(async () => {
  await setupTestDb();
  const agents = await loadAgents(import.meta.dir + "/../agents");
  const bus = new EventBus<AgentEvents>();
  const executor = new AgentExecutor(agents, bus);
  server = await startServer(0, executor, bus);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  server?.stop(true);
  await closeTestDb();
});

describe("GET /api/agents", () => {
  test("returns JSON array of agents", async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(2);

    const names = data.map((a: any) => a.name);
    expect(names).toContain("summarizer");
    expect(names).toContain("shell-runner");

    // Check shape
    const shellRunner = data.find((a: any) => a.name === "shell-runner");
    expect(shellRunner.description).toBe("Run shell commands");
    expect(shellRunner.capabilities).toContain("shell");
  });
});

describe("POST /api/agents/:name/run", () => {
  let _runId: string;

  test("triggers execution and returns run", async () => {
    const res = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo hello" }),
    });
    expect(res.status).toBe(200);
    const run = await res.json() as any;
    expect(run.agentName).toBe("shell-runner");
    expect(run.status).toBe("success");
    expect(run.result.success).toBe(true);
    expect(run.result.output.stdout.trim()).toBe("hello");
    _runId = run.id;
  });

  test("GET /api/runs returns array with the run", async () => {
    const res = await fetch(`${baseUrl}/api/runs`);
    expect(res.status).toBe(200);
    const runs = await res.json() as any;
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });

  test("GET /api/runs/:id returns the specific run", async () => {
    // We need a valid run id, re-run to get one
    const postRes = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo test" }),
    });
    const postRun = await postRes.json() as any;

    const res = await fetch(`${baseUrl}/api/runs/${postRun.id}`);
    expect(res.status).toBe(200);
    const run = await res.json() as any;
    expect(run.id).toBe(postRun.id);
    expect(run.agentName).toBe("shell-runner");
  });

  test("GET /api/runs/:id returns 404 for unknown id", async () => {
    const res = await fetch(`${baseUrl}/api/runs/nonexistent`);
    expect(res.status).toBe(404);
  });

  test("POST to unknown agent returns 400", async () => {
    const res = await fetch(`${baseUrl}/api/agents/nope/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
