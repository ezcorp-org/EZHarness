import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  createProject,
  getProject,
  getProjectByName,
  listProjects,
  updateProject,
  deleteProject,
} = await import("../db/queries/projects");

describe("projects queries", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("createProject inserts and returns row with defaults", async () => {
    const p = await createProject({ name: "alpha", path: "/tmp/alpha" });

    expect(p.id).toBeDefined();
    expect(p.name).toBe("alpha");
    expect(p.path).toBe("/tmp/alpha");
    expect(p.icon).toBeNull();
    expect(p.variables).toEqual({});
    expect(p.createdAt).toBeInstanceOf(Date);
    expect(p.updatedAt).toBeInstanceOf(Date);
  });

  test("createProject accepts icon and variables", async () => {
    const p = await createProject({
      name: "beta",
      path: "/tmp/beta",
      icon: "rocket",
      variables: { env: "dev", debug: true },
    });
    expect(p.icon).toBe("rocket");
    expect(p.variables).toEqual({ env: "dev", debug: true });
  });

  test("getProject returns the row by id", async () => {
    const p = await createProject({ name: "byid", path: "/tmp/byid" });
    const fetched = await getProject(p.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(p.id);
    expect(fetched!.name).toBe("byid");
  });

  test("getProject returns undefined for missing id", async () => {
    const result = await getProject(crypto.randomUUID());
    expect(result).toBeUndefined();
  });

  test("getProjectByName returns row, undefined when missing", async () => {
    await createProject({ name: "named", path: "/tmp/named" });
    expect((await getProjectByName("named"))!.path).toBe("/tmp/named");
    expect(await getProjectByName("ghost")).toBeUndefined();
  });

  test("listProjects returns all rows including seeded global", async () => {
    await createProject({ name: "a", path: "/a" });
    await createProject({ name: "b", path: "/b" });
    const all = await listProjects();
    // Migration seeds a "Global" project, so we expect at least our two plus that.
    const userNames = all.map((r) => r.name).filter((n) => n !== "Global").sort();
    expect(userNames).toEqual(["a", "b"]);
  });

  test("listProjects returns only seeded global when no user projects exist", async () => {
    const all = await listProjects();
    expect(all.length).toBe(1);
    expect(all[0]!.name).toBe("Global");
  });

  test("updateProject patches partial fields and bumps updatedAt", async () => {
    const p = await createProject({ name: "u1", path: "/old" });
    const original = p.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 5));

    const updated = await updateProject(p.id, { path: "/new", icon: "star" });
    expect(updated).toBeDefined();
    expect(updated!.path).toBe("/new");
    expect(updated!.icon).toBe("star");
    expect(updated!.name).toBe("u1");
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(original);
  });

  test("updateProject can replace variables", async () => {
    const p = await createProject({
      name: "vars",
      path: "/v",
      variables: { a: 1 },
    });
    const updated = await updateProject(p.id, { variables: { b: 2 } });
    expect(updated!.variables).toEqual({ b: 2 });
  });

  test("updateProject returns undefined for missing id", async () => {
    const result = await updateProject(crypto.randomUUID(), { name: "x" });
    expect(result).toBeUndefined();
  });

  test("deleteProject removes row, second call returns false", async () => {
    const p = await createProject({ name: "del", path: "/d" });
    expect(await deleteProject(p.id)).toBe(true);
    expect(await getProject(p.id)).toBeUndefined();
    expect(await deleteProject(p.id)).toBe(false);
  });

  test("deleteProject returns false for missing id", async () => {
    expect(await deleteProject(crypto.randomUUID())).toBe(false);
  });
});
