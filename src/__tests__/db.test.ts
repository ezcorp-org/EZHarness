import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { setupTestDb, getTestDb, getTestPglite, closeTestDb } from "./helpers/test-pglite";

describe("migration", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("creates all tables", async () => {
    const result = await getTestPglite().query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    const names = result.rows.map((r: any) => r.table_name);
    expect(names).toContain("projects");
    expect(names).toContain("settings");
    expect(names).toContain("runs");
    expect(names).toContain("run_logs");
    expect(names).toContain("agent_configs");
    expect(names).toContain("pipeline_definitions");
  });

  test("migration is idempotent", async () => {
    const { migrate } = await import("../db/migrate");
    await migrate(getTestDb());
    const result = await getTestPglite().query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(6);
  });
});

describe("projects CRUD", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("insert and select project", async () => {
    const db = getTestDb();
    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(schema.projects)
      .values({ id, name: "test", path: "/tmp/test", variables: { foo: "bar" }, createdAt: now, updatedAt: now });

    const result = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
    expect(result[0]).toBeDefined();
    expect(result[0]!.name).toBe("test");
    expect(result[0]!.path).toBe("/tmp/test");
    expect(result[0]!.variables).toEqual({ foo: "bar" });
  });

  test("update project", async () => {
    const db = getTestDb();
    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(schema.projects)
      .values({ id, name: "old", path: "/old", variables: {}, createdAt: now, updatedAt: now });

    await db.update(schema.projects).set({ name: "new", updatedAt: new Date() }).where(eq(schema.projects.id, id));

    const result = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
    expect(result[0]!.name).toBe("new");
  });

  test("delete project sets run projectId to null", async () => {
    const db = getTestDb();
    const projectId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const now = new Date();

    await db.insert(schema.projects)
      .values({ id: projectId, name: "p", path: "/p", variables: {}, createdAt: now, updatedAt: now });

    await db.insert(schema.runs)
      .values({ id: runId, agentName: "test", projectId, status: "success", startedAt: now, createdAt: now });

    await db.delete(schema.projects).where(eq(schema.projects.id, projectId));

    const result = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(result[0]).toBeDefined();
    expect(result[0]!.projectId).toBeNull();
  });
});

describe("settings CRUD", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("insert and select setting", async () => {
    const db = getTestDb();
    await db.insert(schema.settings).values({ key: "provider", value: "anthropic", updatedAt: new Date() });

    const result = await db.select().from(schema.settings).where(eq(schema.settings.key, "provider"));
    expect(result[0]!.value).toBe("anthropic");
  });

  test("upsert setting", async () => {
    const db = getTestDb();
    await db.insert(schema.settings).values({ key: "model", value: "opus", updatedAt: new Date() });
    await db.update(schema.settings).set({ value: "sonnet", updatedAt: new Date() }).where(eq(schema.settings.key, "model"));

    const result = await db.select().from(schema.settings).where(eq(schema.settings.key, "model"));
    expect(result[0]!.value).toBe("sonnet");
  });
});

describe("runs and logs", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("insert run with logs", async () => {
    const db = getTestDb();
    const runId = crypto.randomUUID();
    const now = new Date();

    await db.insert(schema.runs)
      .values({ id: runId, agentName: "shell-runner", status: "running", startedAt: now, createdAt: now });

    await db.insert(schema.runLogs).values([
      { runId, timestamp: Date.now(), level: "info", message: "Starting..." },
      { runId, timestamp: Date.now(), level: "info", message: "Done." },
    ]);

    const logs = await db.select().from(schema.runLogs).where(eq(schema.runLogs.runId, runId));
    expect(logs).toHaveLength(2);
    expect(logs[0]!.message).toBe("Starting...");
  });

  test("cascade delete logs when run deleted", async () => {
    const db = getTestDb();
    const runId = crypto.randomUUID();
    const now = new Date();

    await db.insert(schema.runs)
      .values({ id: runId, agentName: "test", status: "success", startedAt: now, createdAt: now });

    await db.insert(schema.runLogs).values({ runId, timestamp: Date.now(), level: "info", message: "hi" });

    await db.delete(schema.runs).where(eq(schema.runs.id, runId));

    const logs = await db.select().from(schema.runLogs).where(eq(schema.runLogs.runId, runId));
    expect(logs).toHaveLength(0);
  });
});

describe("input merging", () => {
  test("resolves input with priority: user > project > account", () => {
    const accountDefaults = { provider: "anthropic", model: "opus", temperature: 0.7 };
    const projectVars = { model: "sonnet", cwd: "/project" };
    const userInput = { model: "haiku", prompt: "hello" };

    const resolved = { ...accountDefaults, ...projectVars, ...userInput };

    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("haiku");
    expect(resolved.cwd).toBe("/project");
    expect(resolved.prompt).toBe("hello");
    expect(resolved.temperature).toBe(0.7);
  });
});
