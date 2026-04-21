import { test, expect, describe, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgents } from "../runtime/loader";
import { startTestServer as startServer } from "./helpers/test-server";
import { setupTestDb, getTestDb, getTestPglite, closeTestDb, mockDbConnection, mockRealSettings, restoreFetch } from "./helpers/test-pglite";
import type { AgentEvents } from "../types";

mockDbConnection();
mockRealSettings();

// ── Unit: schema & migration ────────────────────────────────────────

describe("project icon column", () => {
  beforeEach(async () => {
    restoreFetch();
    mockDbConnection();
    mockRealSettings();
    await setupTestDb();
  });
  afterEach(async () => await closeTestDb());

  test("projects table has icon column", async () => {
    const result = await getTestPglite().query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'projects'",
    );
    const colNames = (result.rows as { column_name: string }[]).map((r) => r.column_name);
    expect(colNames).toContain("icon");
  });

  test("icon column is nullable (defaults to null)", async () => {
    const db = getTestDb();
    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(schema.projects)
      .values({ id, name: "no-icon", path: "/tmp", variables: {}, createdAt: now, updatedAt: now });

    const rows = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
    expect(rows[0]).toBeDefined();
    expect(rows[0]!.icon).toBeNull();
  });

  test("insert project with icon", async () => {
    const db = getTestDb();
    const id = crypto.randomUUID();
    const now = new Date();
    const icon = "data:image/png;base64,iVBORw0KGgo=";
    await db.insert(schema.projects)
      .values({ id, name: "with-icon", path: "/tmp", icon, variables: {}, createdAt: now, updatedAt: now });

    const rows = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
    expect(rows[0]!.icon).toBe(icon);
  });

  test("update project icon", async () => {
    const db = getTestDb();
    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(schema.projects)
      .values({ id, name: "p", path: "/p", variables: {}, createdAt: now, updatedAt: now });

    const newIcon = "data:image/png;base64,AAAA";
    await db.update(schema.projects).set({ icon: newIcon }).where(eq(schema.projects.id, id));

    const rows = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
    expect(rows[0]!.icon).toBe(newIcon);
  });

  test("clear project icon (set to null)", async () => {
    const db = getTestDb();
    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(schema.projects)
      .values({ id, name: "p", path: "/p", icon: "data:image/png;base64,AAAA", variables: {}, createdAt: now, updatedAt: now });

    await db.update(schema.projects).set({ icon: null }).where(eq(schema.projects.id, id));

    const rows = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
    expect(rows[0]!.icon).toBeNull();
  });

  test("icon migration is idempotent", async () => {
    const db = getTestDb();
    await migrate(db);
    const result = await getTestPglite().query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'projects'",
    );
    const colNames = (result.rows as { column_name: string }[]).map((r) => r.column_name);
    expect(colNames).toContain("icon");
  });

  test("icon can store large base64 data", async () => {
    const db = getTestDb();
    const id = crypto.randomUUID();
    const now = new Date();
    const largeIcon = "data:image/png;base64," + "A".repeat(10000);
    await db.insert(schema.projects)
      .values({ id, name: "large-icon", path: "/tmp", icon: largeIcon, variables: {}, createdAt: now, updatedAt: now });

    const rows = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
    expect(rows[0]!.icon).toBe(largeIcon);
    expect(rows[0]!.icon!.length).toBe("data:image/png;base64,".length + 10000);
  });

  test("delete project with icon and ON DELETE SET NULL on runs", async () => {
    const db = getTestDb();
    const projectId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const now = new Date();

    await db.insert(schema.projects)
      .values({ id: projectId, name: "del", path: "/del", icon: "data:image/png;base64,X", variables: {}, createdAt: now, updatedAt: now });

    await db.insert(schema.runs)
      .values({ id: runId, agentName: "test", projectId, status: "success", startedAt: now, createdAt: now });

    await db.delete(schema.projects).where(eq(schema.projects.id, projectId));

    const rows = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(rows[0]).toBeDefined();
    expect(rows[0]!.projectId).toBeNull();
  });
});

// ── Integration: Projects API with icon ─────────────────────────────

describe("projects API with icon", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let baseUrl: string;

  beforeAll(async () => {
    restoreFetch();
    mockDbConnection();
    mockRealSettings();
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

  test("POST /api/projects creates project without icon (null)", async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-icon-proj", path: "/tmp/no-icon" }),
    });
    expect(res.status).toBe(201);
    const project = await res.json() as any;
    expect(project.name).toBe("no-icon-proj");
    expect(project.icon).toBeNull();
  });

  test("POST /api/projects creates project with icon", async () => {
    const icon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "icon-proj", path: "/tmp/icon", icon }),
    });
    expect(res.status).toBe(201);
    const project = await res.json() as any;
    expect(project.name).toBe("icon-proj");
    expect(project.icon).toBe(icon);
  });

  test("PUT /api/projects/:id updates icon", async () => {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "update-icon", path: "/tmp/update" }),
    });
    const created = await createRes.json() as any;
    expect(created.icon).toBeNull();

    const icon = "data:image/png;base64,UPDATED";
    const updateRes = await fetch(`${baseUrl}/api/projects/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icon }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json() as any;
    expect(updated.icon).toBe(icon);
  });

  test("PUT /api/projects/:id can clear icon", async () => {
    const icon = "data:image/png;base64,INITIAL";
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "clear-icon", path: "/tmp/clear", icon }),
    });
    const created = await createRes.json() as any;
    expect(created.icon).toBe(icon);

    const updateRes = await fetch(`${baseUrl}/api/projects/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icon: null }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json() as any;
    expect(updated.icon).toBeNull();
  });

  test("GET /api/projects/:id returns icon", async () => {
    const icon = "data:image/png;base64,GETTEST";
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "get-icon", path: "/tmp/get-icon", icon }),
    });
    const created = await createRes.json() as any;

    const getRes = await fetch(`${baseUrl}/api/projects/${created.id}`);
    expect(getRes.status).toBe(200);
    const project = await getRes.json() as any;
    expect(project.icon).toBe(icon);
  });

  test("GET /api/projects lists projects with icon field present", async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    expect(res.status).toBe(200);
    const projects = await res.json() as any[];
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) {
      expect("icon" in p).toBe(true);
    }
  });

  test("PUT updates icon without affecting other fields", async () => {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "partial-update", path: "/tmp/partial", variables: { key: "value" } }),
    });
    const created = await createRes.json() as any;

    const icon = "data:image/png;base64,PARTIAL";
    const updateRes = await fetch(`${baseUrl}/api/projects/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icon }),
    });
    const updated = await updateRes.json() as any;
    expect(updated.icon).toBe(icon);
    expect(updated.name).toBe("partial-update");
    expect(updated.path).toBe("/tmp/partial");
    expect(updated.variables).toEqual({ key: "value" });
  });

  test("DELETE project with icon returns 200", async () => {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "delete-icon", path: "/tmp/del", icon: "data:image/png;base64,DEL" }),
    });
    const created = await createRes.json() as any;

    const delRes = await fetch(`${baseUrl}/api/projects/${created.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/api/projects/${created.id}`);
    expect(getRes.status).toBe(404);
  });
});

// ── Favicon API ─────────────────────────────────────────────────────

describe("GET /api/favicon", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let baseUrl: string;

  beforeAll(async () => {
    restoreFetch();
    mockDbConnection();
    mockRealSettings();
    await setupTestDb();
    const agents = await loadAgents(import.meta.dir + "/../agents");
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(agents, bus);
    server = await startServer(0, executor, bus);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server?.stop(true);
  });

  test("returns 400 when url param is missing", async () => {
    const res = await fetch(`${baseUrl}/api/favicon`);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toBe("url parameter required");
  });

  test("returns base64 icon for valid domain", async () => {
    const res = await fetch(`${baseUrl}/api/favicon?url=https://google.com`);
    if (res.status === 200) {
      const data = await res.json() as any;
      expect(data.icon).toMatch(/^data:image\/png;base64,/);
      const base64Part = data.icon.replace("data:image/png;base64,", "");
      expect(base64Part.length).toBeGreaterThan(10);
    } else {
      expect(res.status).toBe(502);
    }
  });

  test("handles URL without protocol prefix", async () => {
    const res = await fetch(`${baseUrl}/api/favicon?url=github.com`);
    expect([200, 502]).toContain(res.status);
    if (res.status === 200) {
      const data = await res.json() as any;
      expect(data.icon).toMatch(/^data:image\/png;base64,/);
    }
  });

  test("handles URL with path", async () => {
    const res = await fetch(`${baseUrl}/api/favicon?url=https://github.com/anthropics/claude`);
    expect([200, 502]).toContain(res.status);
    if (res.status === 200) {
      const data = await res.json() as any;
      expect(data.icon).toMatch(/^data:image\/png;base64,/);
    }
  });

  test("CORS headers present on favicon response", async () => {
    const res = await fetch(`${baseUrl}/api/favicon?url=https://example.com`);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("returns 400 for completely invalid URL", async () => {
    const res = await fetch(`${baseUrl}/api/favicon?url=not a url at all ::::`);
    expect([400, 502]).toContain(res.status);
  });
});

// ── E2E: project icon lifecycle ─────────────────────────────────────

describe("E2E: project icon lifecycle", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let baseUrl: string;

  beforeAll(async () => {
    restoreFetch();
    mockDbConnection();
    mockRealSettings();
    await setupTestDb();
    const agents = await loadAgents(import.meta.dir + "/../agents");
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(agents, bus);
    server = await startServer(0, executor, bus);
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(async () => {
    server?.stop(true);
  });

  test("full lifecycle: create without icon, add icon, update icon, remove icon", async () => {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "lifecycle", path: "/tmp/lifecycle" }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as any;
    expect(created.icon).toBeNull();
    const id = created.id;

    const icon1 = "data:image/png;base64,ICON1";
    const addRes = await fetch(`${baseUrl}/api/projects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icon: icon1 }),
    });
    expect(addRes.status).toBe(200);
    expect((await addRes.json() as any).icon).toBe(icon1);

    const icon2 = "data:image/png;base64,ICON2";
    const updateRes = await fetch(`${baseUrl}/api/projects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icon: icon2 }),
    });
    expect(updateRes.status).toBe(200);
    expect((await updateRes.json() as any).icon).toBe(icon2);

    const getRes = await fetch(`${baseUrl}/api/projects/${id}`);
    expect((await getRes.json() as any).icon).toBe(icon2);

    const removeRes = await fetch(`${baseUrl}/api/projects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icon: null }),
    });
    expect(removeRes.status).toBe(200);
    expect((await removeRes.json() as any).icon).toBeNull();

    const finalRes = await fetch(`${baseUrl}/api/projects/${id}`);
    const final = await finalRes.json() as any;
    expect(final.icon).toBeNull();
    expect(final.name).toBe("lifecycle");
    expect(final.path).toBe("/tmp/lifecycle");
  });

  test("create project with icon and trigger run", async () => {
    const icon = "data:image/png;base64,RUNTEST";
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "run-with-icon", path: "/tmp/run-icon", icon }),
    });
    const project = await createRes.json() as any;
    expect(project.icon).toBe(icon);

    const runRes = await fetch(`${baseUrl}/api/agents/shell-runner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo icon-run", projectId: project.id }),
    });
    expect(runRes.status).toBe(200);
    const run = await runRes.json() as any;
    expect(run.projectId).toBe(project.id);
    expect(run.result.success).toBe(true);

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`);
    expect((await getRes.json() as any).icon).toBe(icon);
  });

  test("multiple projects with different icons", async () => {
    const icons = ["data:image/png;base64,AAA", "data:image/png;base64,BBB", null];
    const ids: string[] = [];

    for (let i = 0; i < icons.length; i++) {
      const res = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `multi-${i}`, path: `/tmp/multi-${i}`, icon: icons[i] }),
      });
      const project = await res.json() as any;
      ids.push(project.id);
    }

    for (let i = 0; i < ids.length; i++) {
      const res = await fetch(`${baseUrl}/api/projects/${ids[i]}`);
      const project = await res.json() as any;
      expect(project.icon).toBe(icons[i]);
    }
  });

  test("icon update does not change timestamps beyond updatedAt", async () => {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "timestamps", path: "/tmp/ts" }),
    });
    const created = await createRes.json() as any;
    const createdAt = created.createdAt;

    await new Promise((r) => setTimeout(r, 10));

    const updateRes = await fetch(`${baseUrl}/api/projects/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icon: "data:image/png;base64,TS" }),
    });
    const updated = await updateRes.json() as any;
    expect(updated.createdAt).toBe(createdAt);
    expect(updated.updatedAt).not.toBe(createdAt);
  });

  test("favicon endpoint coexists with project API", async () => {
    const [faviconRes, projectsRes] = await Promise.all([
      fetch(`${baseUrl}/api/favicon?url=example.com`),
      fetch(`${baseUrl}/api/projects`),
    ]);

    expect([200, 502]).toContain(faviconRes.status);
    expect(projectsRes.status).toBe(200);
  });
});
