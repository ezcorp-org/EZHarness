import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgents } from "../runtime/loader";
import { startTestServer } from "./helpers/test-server";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import type { AgentEvents } from "../types";

mockDbConnection();

mockRealSettings();
/**
 * Integration tests for the project-centric routing restructure.
 * Tests the API flows that back the new routes:
 *   /project/[id]          - project dashboard (agents + filtered runs)
 *   /project/[id]/settings - project CRUD (update, delete)
 *   /new-project           - project creation
 */

let server: Awaited<ReturnType<typeof startTestServer>>;
let baseUrl: string;
let executor: AgentExecutor;

beforeAll(async () => {
  await setupTestDb();
  const agents = await loadAgents(import.meta.dir + "/../agents");
  const bus = new EventBus<AgentEvents>();
  executor = new AgentExecutor(agents, bus);
  server = await startTestServer(0, executor, bus);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  server?.stop(true);
  await closeTestDb();
});

async function createProject(data: { name: string; path: string; variables?: Record<string, unknown> }) {
  const res = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<any>;
}

async function deleteProject(id: string) {
  await fetch(`${baseUrl}/api/projects/${id}`, { method: "DELETE" });
}

describe("/new-project flow", () => {
  test("create project returns id for navigation to /project/[id]", async () => {
    const project = await createProject({ name: "new-proj", path: "/tmp/new" });
    expect(project.id).toBeDefined();
    expect(typeof project.id).toBe("string");
    expect(project.name).toBe("new-proj");
    expect(project.path).toBe("/tmp/new");
    await deleteProject(project.id);
  });

  test("created project appears in project list (rail data)", async () => {
    const project = await createProject({ name: "rail-proj", path: "/tmp/rail" });

    const listRes = await fetch(`${baseUrl}/api/projects`);
    const projects = await listRes.json() as any;
    const found = projects.find((p: any) => p.id === project.id);
    expect(found).toBeDefined();
    expect(found.name).toBe("rail-proj");

    await deleteProject(project.id);
  });

  test("rejects project without name or path", async () => {
    const res1 = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res1.status).toBe(400);

    const res2 = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/x" }),
    });
    expect(res2.status).toBe(400);
  });
});

describe("/project/[id] dashboard flow", () => {
  test("GET project by id for dashboard header", async () => {
    const project = await createProject({ name: "dash-proj", path: "/tmp/dash" });

    const res = await fetch(`${baseUrl}/api/projects/${project.id}`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.id).toBe(project.id);
    expect(data.name).toBe("dash-proj");

    await deleteProject(project.id);
  });

  test("run agent with projectId stores projectId on run", async () => {
    const project = await createProject({ name: "runs-proj", path: "/tmp/runs" });

    const runRes = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo proj-run", projectId: project.id }),
    });
    const run = await runRes.json() as any;
    expect(run.projectId).toBe(project.id);
    expect(run.status).toBe("success");

    // Verify via GET /api/runs/:id
    const getRes = await fetch(`${baseUrl}/api/runs/${run.id}`);
    const fetched = await getRes.json() as any;
    expect(fetched.projectId).toBe(project.id);

    await deleteProject(project.id);
  });

  test("GET all runs includes project-scoped runs", async () => {
    const project = await createProject({ name: "allruns-proj", path: "/tmp/allruns" });

    const runRes = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo allruns", projectId: project.id }),
    });
    const run = await runRes.json() as any;

    const allRes = await fetch(`${baseUrl}/api/runs`);
    const allRuns = await allRes.json() as any;
    expect(allRuns.some((r: any) => r.id === run.id)).toBe(true);

    await deleteProject(project.id);
  });

  test("GET agents list for dashboard agent cards", async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    const agents = await res.json() as any;
    expect(agents.length).toBeGreaterThanOrEqual(1);
    for (const agent of agents) {
      expect(agent.name).toBeDefined();
      expect(typeof agent.name).toBe("string");
    }
  });

  test("returns 404 for non-existent project id", async () => {
    const res = await fetch(`${baseUrl}/api/projects/nonexistent-id`);
    expect(res.status).toBe(404);
  });
});

describe("/project/[id]/settings flow", () => {
  test("update project name and path", async () => {
    const project = await createProject({ name: "old-name", path: "/old" });

    const res = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new-name", path: "/new" }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json() as any;
    expect(updated.name).toBe("new-name");
    expect(updated.path).toBe("/new");

    await deleteProject(project.id);
  });

  test("update project variables", async () => {
    const project = await createProject({
      name: "var-proj",
      path: "/tmp/vars",
      variables: { key1: "val1" },
    });

    const res = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variables: { key1: "updated", key2: "new" } }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json() as any;
    expect(updated.variables).toEqual({ key1: "updated", key2: "new" });

    await deleteProject(project.id);
  });

  test("update project icon", async () => {
    const project = await createProject({ name: "icon-proj", path: "/tmp/icon" });

    const icon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    const res = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icon }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json() as any;
    expect(updated.icon).toBe(icon);

    // Clear icon
    const clearRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icon: null }),
    });
    const cleared = await clearRes.json() as any;
    expect(cleared.icon).toBeNull();

    await deleteProject(project.id);
  });

  test("partial update preserves other fields", async () => {
    const project = await createProject({
      name: "partial-proj",
      path: "/tmp/partial",
      variables: { keep: "this" },
    });

    await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`);
    const data = await getRes.json() as any;
    expect(data.name).toBe("renamed");
    expect(data.path).toBe("/tmp/partial");
    expect(data.variables).toEqual({ keep: "this" });

    await deleteProject(project.id);
  });

  test("delete project returns ok and removes it", async () => {
    const project = await createProject({ name: "del-proj", path: "/tmp/del" });

    const res = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);

    // Verify gone
    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`);
    expect(getRes.status).toBe(404);
  });

  test("delete project preserves associated runs (nullifies projectId)", async () => {
    const project = await createProject({ name: "cascade-proj", path: "/tmp/cascade" });

    // Create a run associated with this project
    const runRes = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo cascade", projectId: project.id }),
    });
    const run = await runRes.json() as any;

    // Delete the project
    await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE" });

    // The run should still exist (executor keeps it in memory)
    const getRunRes = await fetch(`${baseUrl}/api/runs/${run.id}`);
    expect(getRunRes.status).toBe(200);
  });

  test("update non-existent project returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/projects/nonexistent`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  test("delete non-existent project returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/projects/nonexistent`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});

describe("project-scoped agent runs", () => {
  test("run agent with projectId and verify via individual fetch", async () => {
    const project = await createProject({ name: "scoped-proj", path: "/tmp/scoped" });

    const runRes = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo scoped", projectId: project.id }),
    });
    expect(runRes.status).toBe(200);
    const run = await runRes.json() as any;
    expect(run.projectId).toBe(project.id);
    expect(run.agentName).toBe("shell-runner");
    expect(run.status).toBe("success");

    // Verify via individual run fetch
    const getRes = await fetch(`${baseUrl}/api/runs/${run.id}`);
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json() as any;
    expect(fetched.projectId).toBe(project.id);

    // All runs should include it
    const allRes = await fetch(`${baseUrl}/api/runs`);
    const allRuns = await allRes.json() as any;
    expect(allRuns.some((r: any) => r.id === run.id)).toBe(true);

    await deleteProject(project.id);
  });

  test("run agent without projectId has undefined projectId", async () => {
    const runRes = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo no-project" }),
    });
    const run = await runRes.json() as any;
    expect(run.projectId).toBeUndefined();
  });
});

describe("full e2e: create -> use -> edit -> delete lifecycle", () => {
  test("complete project lifecycle", async () => {
    // 1. Create project (simulates /new-project)
    const project = await createProject({
      name: "lifecycle",
      path: "/tmp/lifecycle",
      variables: { env: "test" },
    });
    expect(project.id).toBeDefined();

    // 2. Verify project is accessible (simulates /project/[id] load)
    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`);
    expect(getRes.status).toBe(200);
    const loaded = await getRes.json() as any;
    expect(loaded.name).toBe("lifecycle");
    expect(loaded.variables.env).toBe("test");

    // 3. Run agent in project context (simulates dashboard action)
    const runRes = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo lifecycle-run", projectId: project.id }),
    });
    const run = await runRes.json() as any;
    expect(run.status).toBe("success");
    expect(run.projectId).toBe(project.id);

    // 4. Verify run is retrievable individually
    const getRunRes = await fetch(`${baseUrl}/api/runs/${run.id}`);
    expect(getRunRes.status).toBe(200);
    const fetchedRun = await getRunRes.json() as any;
    expect(fetchedRun.projectId).toBe(project.id);

    // 5. Update project settings (simulates /project/[id]/settings save)
    const updateRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "lifecycle-v2", variables: { env: "prod" } }),
    });
    const updated = await updateRes.json() as any;
    expect(updated.name).toBe("lifecycle-v2");
    expect(updated.variables.env).toBe("prod");

    // 6. Verify project in list (rail data refresh)
    const listRes = await fetch(`${baseUrl}/api/projects`);
    const projects = await listRes.json() as any;
    const inList = projects.find((p: any) => p.id === project.id);
    expect(inList).toBeDefined();
    expect(inList.name).toBe("lifecycle-v2");

    // 7. Delete project (simulates /project/[id]/settings delete)
    const delRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    // 8. Verify project is gone
    const goneRes = await fetch(`${baseUrl}/api/projects/${project.id}`);
    expect(goneRes.status).toBe(404);

    // 9. Verify project no longer in list
    const finalListRes = await fetch(`${baseUrl}/api/projects`);
    const finalProjects = await finalListRes.json() as any;
    expect(finalProjects.find((p: any) => p.id === project.id)).toBeUndefined();
  });
});
