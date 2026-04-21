import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgents } from "../runtime/loader";
import { startTestServer as startServer } from "./helpers/test-server";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings, restoreFetch } from "./helpers/test-pglite";
import type { AgentEvents } from "../types";

mockDbConnection();

mockRealSettings();
let server: Awaited<ReturnType<typeof startServer>>;
let baseUrl: string;
let testDir: string;

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

  // Create a temp directory structure for filesystem tests
  testDir = mkdtempSync(join(tmpdir(), "filepicker-"));
  mkdirSync(join(testDir, "subdir-a"));
  mkdirSync(join(testDir, "subdir-b"));
  writeFileSync(join(testDir, "file1.txt"), "hello");
  writeFileSync(join(testDir, "file2.ts"), "export {}");
  writeFileSync(join(testDir, ".hidden"), "secret");
  mkdirSync(join(testDir, "subdir-a", "nested"));
  writeFileSync(join(testDir, "subdir-a", "inner.txt"), "inner");
});

afterAll(async () => {
  server?.stop(true);
  rmSync(testDir, { recursive: true, force: true });
  await closeTestDb();
});

beforeEach(() => {
  restoreFetch();
  mockDbConnection();
  mockRealSettings();
});

// ── Unit: /api/fs/list endpoint ─────────────────────────────────────

describe("GET /api/fs/list", () => {
  test("lists directory contents", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}`);
    expect(res.status).toBe(200);
    const entries = (await res.json()) as { name: string; isDir: boolean }[];
    const names = entries.map((e) => e.name);
    expect(names).toContain("subdir-a");
    expect(names).toContain("subdir-b");
    expect(names).toContain("file1.txt");
    expect(names).toContain("file2.ts");
  });

  test("hides dotfiles by default", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}`);
    const entries = (await res.json()) as { name: string; isDir: boolean }[];
    const names = entries.map((e) => e.name);
    expect(names).not.toContain(".hidden");
  });

  test("shows dotfiles when hidden=1", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}&hidden=1`);
    const entries = (await res.json()) as { name: string; isDir: boolean }[];
    const names = entries.map((e) => e.name);
    expect(names).toContain(".hidden");
  });

  test("directories sorted before files", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}`);
    const entries = (await res.json()) as { name: string; isDir: boolean }[];
    const dirIdx = entries.findIndex((e) => e.name === "subdir-a");
    const fileIdx = entries.findIndex((e) => e.name === "file1.txt");
    expect(dirIdx).toBeLessThan(fileIdx);
  });

  test("marks directories with isDir=true", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}`);
    const entries = (await res.json()) as { name: string; isDir: boolean }[];
    const subdir = entries.find((e) => e.name === "subdir-a");
    const file = entries.find((e) => e.name === "file1.txt");
    expect(subdir?.isDir).toBe(true);
    expect(file?.isDir).toBe(false);
  });

  test("lists subdirectory contents", async () => {
    const sub = join(testDir, "subdir-a");
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(sub)}`);
    const entries = (await res.json()) as { name: string; isDir: boolean }[];
    const names = entries.map((e) => e.name);
    expect(names).toContain("nested");
    expect(names).toContain("inner.txt");
  });

  test("returns empty array for nonexistent directory", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent("/nonexistent-dir-xyz")}`);
    expect(res.status).toBe(200);
    const entries = (await res.json()) as unknown[];
    expect(entries).toEqual([]);
  });

  test("handles tilde expansion", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=~`);
    expect(res.status).toBe(200);
    const entries = (await res.json()) as { name: string; isDir: boolean }[];
    expect(entries.length).toBeGreaterThan(0);
  });

  test("defaults to home directory when no dir param", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list`);
    expect(res.status).toBe(200);
    const entries = (await res.json()) as { name: string; isDir: boolean }[];
    expect(entries.length).toBeGreaterThan(0);
  });
});

// ── Integration: project creation with file-picker path ─────────────

describe("project creation with file-picker browsed path", () => {
  test("browse directory then create project with that path", async () => {
    const listRes = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}`);
    expect(listRes.status).toBe(200);
    const entries = (await listRes.json()) as { name: string; isDir: boolean }[];
    const subdir = entries.find((e) => e.name === "subdir-a" && e.isDir);
    expect(subdir).toBeDefined();

    const selectedPath = join(testDir, subdir!.name);
    const subRes = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(selectedPath)}`);
    expect(subRes.status).toBe(200);
    const subEntries = (await subRes.json()) as { name: string; isDir: boolean }[];
    expect(subEntries.map((e) => e.name)).toContain("nested");

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "browsed-project", path: selectedPath }),
    });
    expect(createRes.status).toBe(201);
    const project = (await createRes.json()) as { id: string; name: string; path: string };
    expect(project.name).toBe("browsed-project");
    expect(project.path).toBe(selectedPath);

    await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE" });
  });

  test("create project with manually typed path", async () => {
    const manualPath = join(testDir, "subdir-b");
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "typed-project", path: manualPath }),
    });
    expect(createRes.status).toBe(201);
    const project = (await createRes.json()) as { id: string; path: string };
    expect(project.path).toBe(manualPath);

    await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE" });
  });

  test("update project path via PUT", async () => {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "update-path", path: testDir }),
    });
    const created = (await createRes.json()) as { id: string; path: string };
    expect(created.path).toBe(testDir);

    const newPath = join(testDir, "subdir-a");
    const updateRes = await fetch(`${baseUrl}/api/projects/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: newPath }),
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { path: string };
    expect(updated.path).toBe(newPath);

    await fetch(`${baseUrl}/api/projects/${created.id}`, { method: "DELETE" });
  });
});

// ── E2E: full file-picker → project lifecycle ───────────────────────

describe("E2E: file-picker project lifecycle", () => {
  test("browse → select → create → verify → update path → delete", async () => {
    const listRes = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}`);
    const entries = (await listRes.json()) as { name: string; isDir: boolean }[];
    expect(entries.length).toBeGreaterThan(0);

    const dirs = entries.filter((e) => e.isDir);
    expect(dirs.length).toBeGreaterThan(0);
    const chosenDir = dirs[0]!;
    const chosenPath = join(testDir, chosenDir.name);

    const drillRes = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(chosenPath)}`);
    expect(drillRes.status).toBe(200);

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e-filepicker", path: chosenPath }),
    });
    expect(createRes.status).toBe(201);
    const project = (await createRes.json()) as { id: string; name: string; path: string };
    expect(project.path).toBe(chosenPath);

    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { path: string };
    expect(fetched.path).toBe(chosenPath);

    const otherDir = dirs.length > 1 ? dirs[1]! : dirs[0]!;
    const otherPath = join(testDir, otherDir.name);
    const updateRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: otherPath }),
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { path: string };
    expect(updated.path).toBe(otherPath);

    const verifyRes = await fetch(`${baseUrl}/api/projects/${project.id}`);
    const verified = (await verifyRes.json()) as { path: string };
    expect(verified.path).toBe(otherPath);

    const delRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const goneRes = await fetch(`${baseUrl}/api/projects/${project.id}`);
    expect(goneRes.status).toBe(404);
  });

  test("file picker autocomplete simulation: type partial path and filter", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}`);
    const entries = (await res.json()) as { name: string; isDir: boolean }[];

    const partial = "sub";
    const filtered = entries.filter((e) => e.name.toLowerCase().startsWith(partial.toLowerCase()));
    expect(filtered.length).toBe(2);
    expect(filtered.every((e) => e.isDir)).toBe(true);

    const moreSpecific = entries.filter((e) => e.name.toLowerCase().startsWith("subdir-a"));
    expect(moreSpecific.length).toBe(1);
    expect(moreSpecific[0]!.name).toBe("subdir-a");

    const selectedPath = join(testDir, moreSpecific[0]!.name);
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "autocomplete-proj", path: selectedPath }),
    });
    expect(createRes.status).toBe(201);
    const project = (await createRes.json()) as { id: string; path: string };
    expect(project.path).toBe(selectedPath);

    await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE" });
  });

  test("file picker with nested navigation", async () => {
    const subdirPath = join(testDir, "subdir-a");
    const subRes = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(subdirPath)}`);
    const subEntries = (await subRes.json()) as { name: string; isDir: boolean }[];
    expect(subEntries.map((e) => e.name)).toContain("nested");
    expect(subEntries.map((e) => e.name)).toContain("inner.txt");

    const nestedPath = join(subdirPath, "nested");
    const nestedRes = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(nestedPath)}`);
    expect(nestedRes.status).toBe(200);
    const nestedEntries = (await nestedRes.json()) as { name: string; isDir: boolean }[];
    expect(nestedEntries).toEqual([]);

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nested-proj", path: nestedPath }),
    });
    expect(createRes.status).toBe(201);
    const project = (await createRes.json()) as { id: string; path: string };
    expect(project.path).toBe(nestedPath);

    await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE" });
  });
});
