import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { listProjects, getProject, createProject, updateProject, deleteProject, getProjectByName } = await import("../db/queries/projects");
const { getAllSettings, getSetting, upsertSetting, deleteSetting } = await import("../db/queries/settings");
const { insertRun, updateRun, insertLog, listRuns, getRunWithLogs, toAgentRun } = await import("../db/queries/runs");

describe("projects queries", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("listProjects returns empty array initially", async () => {
    // global project is seeded by Phase 6 migration; filter it out
    const userProjects = (await listProjects()).filter((p) => p.id !== "global");
    expect(userProjects).toEqual([]);
  });

  test("createProject creates and returns project", async () => {
    const p = await createProject({ name: "test", path: "/tmp/test" });
    expect(p.name).toBe("test");
    expect(p.path).toBe("/tmp/test");
    expect(p.id).toBeDefined();
    expect(p.icon).toBeNull();
    expect(p.variables).toEqual({});
  });

  test("createProject with optional fields", async () => {
    const p = await createProject({ name: "proj", path: "/p", icon: "icon.png", variables: { key: "val" } });
    expect(p.icon).toBe("icon.png");
    expect(p.variables).toEqual({ key: "val" });
  });

  test("getProject returns project by id", async () => {
    const p = await createProject({ name: "find-me", path: "/find" });
    const found = await getProject(p.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("find-me");
  });

  test("getProject returns undefined for missing id", async () => {
    expect(await getProject("nonexistent")).toBeUndefined();
  });

  test("listProjects returns all projects", async () => {
    await createProject({ name: "a", path: "/a" });
    await createProject({ name: "b", path: "/b" });
    // +1 for the seeded global project
    expect(await listProjects()).toHaveLength(3);
  });

  test("updateProject updates fields", async () => {
    const p = await createProject({ name: "old", path: "/old" });
    const updated = await updateProject(p.id, { name: "new", path: "/new", variables: { x: 1 } });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe("new");
    expect(updated!.path).toBe("/new");
    expect(updated!.variables).toEqual({ x: 1 });
  });

  test("updateProject returns undefined for missing id", async () => {
    expect(await updateProject("nope", { name: "x" })).toBeUndefined();
  });

  test("deleteProject removes project", async () => {
    const p = await createProject({ name: "del", path: "/del" });
    expect(await deleteProject(p.id)).toBe(true);
    expect(await getProject(p.id)).toBeUndefined();
    // global project remains after deleting user project
    expect((await listProjects()).filter((proj) => proj.id !== "global")).toHaveLength(0);
  });

  test("deleteProject returns false for missing id", async () => {
    expect(await deleteProject("nope")).toBe(false);
  });

  test("getProjectByName finds project", async () => {
    await createProject({ name: "unique-name", path: "/u" });
    const found = await getProjectByName("unique-name");
    expect(found).toBeDefined();
    expect(found!.name).toBe("unique-name");
  });
});

describe("settings queries", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("getAllSettings returns empty object initially", async () => {
    expect(await getAllSettings()).toEqual({});
  });

  test("upsertSetting inserts new setting", async () => {
    await upsertSetting("provider", "anthropic");
    expect(await getSetting("provider")).toBe("anthropic");
  });

  test("upsertSetting updates existing setting", async () => {
    await upsertSetting("model", "opus");
    await upsertSetting("model", "sonnet");
    expect(await getSetting("model")).toBe("sonnet");
  });

  test("getSetting returns undefined for missing key", async () => {
    expect(await getSetting("nope")).toBeUndefined();
  });

  test("getAllSettings returns all settings as key-value map", async () => {
    await upsertSetting("a", 1);
    await upsertSetting("b", "two");
    await upsertSetting("c", { nested: true });
    const all = await getAllSettings();
    expect(all).toEqual({ a: 1, b: "two", c: { nested: true } });
  });

  test("deleteSetting removes a setting", async () => {
    await upsertSetting("remove-me", "val");
    expect(await deleteSetting("remove-me")).toBe(true);
    expect(await getSetting("remove-me")).toBeUndefined();
  });

  test("deleteSetting returns false for missing key", async () => {
    expect(await deleteSetting("ghost")).toBe(false);
  });
});

describe("runs queries", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  function makeAgentRun(overrides: Partial<{ id: string; agentName: string; status: string; startedAt: number; finishedAt: number; logs: any[]; result: any }> = {}) {
    return {
      id: overrides.id ?? crypto.randomUUID(),
      agentName: overrides.agentName ?? "test-agent",
      status: (overrides.status ?? "running") as any,
      startedAt: overrides.startedAt ?? Date.now(),
      finishedAt: overrides.finishedAt,
      logs: overrides.logs ?? [],
      result: overrides.result,
    };
  }

  test("insertRun and listRuns", async () => {
    const run = makeAgentRun();
    await insertRun(run);
    const all = await listRuns();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(run.id);
    expect(all[0]!.agentName).toBe("test-agent");
    expect(all[0]!.status).toBe("running");
  });

  test("insertRun with projectId", async () => {
    const p = await createProject({ name: "proj", path: "/p" });
    const run = makeAgentRun();
    await insertRun(run, p.id, { prompt: "hello" });
    const all = await listRuns(p.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.projectId).toBe(p.id);
    expect(all[0]!.input).toEqual({ prompt: "hello" });
  });

  test("updateRun changes status and result", async () => {
    const run = makeAgentRun();
    await insertRun(run);

    const finishedAt = Date.now();
    const result = { success: true, output: "done" };
    await updateRun({ ...run, status: "success" as any, finishedAt, result });

    const updated = await listRuns();
    expect(updated[0]!.status).toBe("success");
    expect(updated[0]!.finishedAt).toBeDefined();
    expect(updated[0]!.result).toEqual(result);
  });

  test("insertLog and getRunWithLogs", async () => {
    const run = makeAgentRun();
    await insertRun(run);

    await insertLog(run.id, { timestamp: 1000, level: "info", message: "Starting" });
    await insertLog(run.id, { timestamp: 2000, level: "error", message: "Oops" });

    const withLogs = await getRunWithLogs(run.id);
    expect(withLogs).toBeDefined();
    expect(withLogs!.logs).toHaveLength(2);
    expect(withLogs!.logs[0]!.level).toBe("info");
    expect(withLogs!.logs[0]!.message).toBe("Starting");
  });

  test("getRunWithLogs returns undefined for missing id", async () => {
    expect(await getRunWithLogs("nonexistent")).toBeUndefined();
  });

  test("toAgentRun converts DbRun to AgentRun", () => {
    const now = new Date();
    const dbRun = {
      id: "abc",
      agentName: "test",
      projectId: "proj-1",
      status: "success",
      input: { foo: "bar" },
      startedAt: now,
      finishedAt: now,
      result: { success: true, output: "ok" },
      createdAt: now,
      logs: [{ timestamp: 1000, level: "info" as const, message: "hi" }],
    };
    const agentRun = toAgentRun(dbRun);
    expect(agentRun.id).toBe("abc");
    expect(agentRun.agentName).toBe("test");
    expect(agentRun.projectId).toBe("proj-1");
    expect(agentRun.status).toBe("success");
    expect(agentRun.startedAt).toBe(now.getTime());
    expect(agentRun.logs).toHaveLength(1);
  });
});
