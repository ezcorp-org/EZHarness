import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgents } from "../runtime/loader";
import { startTestServer as startServer } from "./helpers/test-server";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings, restoreFetch } from "./helpers/test-pglite";
import type { AgentEvents } from "../types";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

mockDbConnection();

mockRealSettings();
// ── Unit tests: endpoint logic ──────────────────────────────────────

describe("GET /api/fs/list", () => {
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
  });

  afterAll(async () => {
    server?.stop(true);
    await closeTestDb();
  });

  // Re-assert mocks before each test to survive cross-file contamination
  // + create a known temp directory structure for deterministic tests
  beforeEach(() => {
    restoreFetch();
    mockDbConnection();
    mockRealSettings();
    testDir = join(tmpdir(), `pi-fs-test-${Date.now()}`);
    mkdirSync(join(testDir, "alpha-dir"), { recursive: true });
    mkdirSync(join(testDir, "beta-dir"), { recursive: true });
    mkdirSync(join(testDir, ".hidden-dir"), { recursive: true });
    writeFileSync(join(testDir, "file-a.txt"), "a");
    writeFileSync(join(testDir, "file-b.ts"), "b");
    writeFileSync(join(testDir, ".dotfile"), "secret");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("returns entries for a valid directory", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}`);
    expect(res.status).toBe(200);
    const entries = await res.json() as any[];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThanOrEqual(4);
  });

  test("entries have correct shape", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}`);
    const entries = await res.json() as any[];
    for (const entry of entries) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.isDir).toBe("boolean");
    }
  });

  test("sorts directories before files", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}`);
    const entries = await res.json() as any[];

    const firstFileIdx = entries.findIndex((e: any) => !e.isDir);
    const lastDirIdx = entries.findLastIndex((e: any) => e.isDir);

    if (firstFileIdx !== -1 && lastDirIdx !== -1) {
      expect(lastDirIdx).toBeLessThan(firstFileIdx);
    }
  });

  test("sorts alphabetically within dirs and files", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}`);
    const entries = await res.json() as any[];

    const dirs = entries.filter((e: any) => e.isDir).map((e: any) => e.name);
    const files = entries.filter((e: any) => !e.isDir).map((e: any) => e.name);

    expect(dirs).toEqual([...dirs].sort());
    expect(files).toEqual([...files].sort());
  });

  test("filters dotfiles by default", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}`);
    const entries = await res.json() as any[];
    const names = entries.map((e: any) => e.name);

    expect(names).toContain("alpha-dir");
    expect(names).toContain("file-a.txt");
    expect(names).not.toContain(".hidden-dir");
    expect(names).not.toContain(".dotfile");
  });

  test("shows dotfiles with hidden=1", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}&hidden=1`);
    const entries = await res.json() as any[];
    const names = entries.map((e: any) => e.name);

    expect(names).toContain(".hidden-dir");
    expect(names).toContain(".dotfile");
    expect(names).toContain("alpha-dir");
  });

  test("returns empty array for nonexistent directory", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=/nonexistent/path/that/does/not/exist`);
    expect(res.status).toBe(200);
    const entries = await res.json() as any;
    expect(entries).toEqual([]);
  });

  test("expands tilde to HOME", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=~`);
    expect(res.status).toBe(200);
    const entries = await res.json() as any[];
    expect(entries.length).toBeGreaterThan(0);

    // Compare with explicit $HOME listing
    const homeRes = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(process.env.HOME!)}`);
    const homeEntries = await homeRes.json() as any[];
    expect(entries).toEqual(homeEntries);
  });

  test("defaults to HOME when no dir param", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list`);
    expect(res.status).toBe(200);
    const entries = await res.json() as any[];

    const homeRes = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(process.env.HOME!)}`);
    const homeEntries = await homeRes.json() as any[];
    expect(entries).toEqual(homeEntries);
  });

  test("correctly identifies directories vs files", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}`);
    const entries = await res.json() as any[];

    const alphaDir = entries.find((e: any) => e.name === "alpha-dir");
    const fileA = entries.find((e: any) => e.name === "file-a.txt");

    expect(alphaDir).toBeDefined();
    expect(alphaDir.isDir).toBe(true);
    expect(fileA).toBeDefined();
    expect(fileA.isDir).toBe(false);
  });

  test("handles root directory", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=/`);
    expect(res.status).toBe(200);
    const entries = await res.json() as any[];
    expect(entries.length).toBeGreaterThan(0);
    // Root should contain common dirs
    const names = entries.map((e: any) => e.name);
    expect(names).toContain("tmp");
  });

  test("handles directory with special characters in name", async () => {
    const specialDir = join(testDir, "dir with spaces");
    mkdirSync(specialDir);
    writeFileSync(join(specialDir, "inner.txt"), "ok");

    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(specialDir)}`);
    expect(res.status).toBe(200);
    const entries = await res.json() as any[];
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("inner.txt");
  });

  test("returns empty array for a file path (not directory)", async () => {
    const filePath = join(testDir, "file-a.txt");
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(filePath)}`);
    expect(res.status).toBe(200);
    const entries = await res.json() as any;
    expect(entries).toEqual([]);
  });
});

// ── Integration: FilePicker browsing flow ───────────────────────────

describe("FilePicker browsing flow (integration)", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let baseUrl: string;
  let testDir: string;

  beforeAll(async () => {
    restoreFetch();
    mockDbConnection();
    mockRealSettings();
    const agents = await loadAgents(import.meta.dir + "/../agents");
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(agents, bus);
    server = await startServer(0, executor, bus);
    baseUrl = `http://localhost:${server.port}`;

    // Build a nested directory tree for browsing simulation
    testDir = join(tmpdir(), `pi-browse-test-${Date.now()}`);
    mkdirSync(join(testDir, "project", "src"), { recursive: true });
    mkdirSync(join(testDir, "project", "tests"), { recursive: true });
    writeFileSync(join(testDir, "project", "src", "index.ts"), "console.log('hi')");
    writeFileSync(join(testDir, "project", "src", "utils.ts"), "export {}");
    writeFileSync(join(testDir, "project", "README.md"), "# readme");
    writeFileSync(join(testDir, "project", "package.json"), "{}");
  });

  afterAll(() => {
    server?.stop(true);
    rmSync(testDir, { recursive: true, force: true });
  });

  test("step 1: list root test dir -> see project folder", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}`);
    const entries = await res.json() as any[];
    expect(entries).toEqual([{ name: "project", isDir: true }]);
  });

  test("step 2: navigate into project -> see dirs then files", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(join(testDir, "project"))}`);
    const entries = await res.json() as any[];
    const names = entries.map((e: any) => e.name);

    // dirs first
    expect(entries[0].isDir).toBe(true);
    expect(entries[1].isDir).toBe(true);
    expect(names).toContain("src");
    expect(names).toContain("tests");
    expect(names).toContain("README.md");
    expect(names).toContain("package.json");
  });

  test("step 3: navigate into src -> see .ts files", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(join(testDir, "project", "src"))}`);
    const entries = await res.json() as any[];
    expect(entries.length).toBe(2);
    expect(entries.every((e: any) => !e.isDir)).toBe(true);
    const names = entries.map((e: any) => e.name);
    expect(names).toContain("index.ts");
    expect(names).toContain("utils.ts");
  });

  test("step 4: empty directory returns empty array", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(join(testDir, "project", "tests"))}`);
    const entries = await res.json() as any;
    expect(entries).toEqual([]);
  });

  test("simulates autocomplete: partial path prefix filtering", async () => {
    // The client splits "/path/to/project/sr" into dir="/path/to/project" partial="sr"
    // Fetch the parent dir
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(join(testDir, "project"))}`);
    const entries = await res.json() as any[];

    // Client-side filtering by partial "sr"
    const partial = "sr";
    const filtered = entries.filter((e: any) => e.name.toLowerCase().startsWith(partial));
    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe("src");
    expect(filtered[0].isDir).toBe(true);
  });

  test("simulates autocomplete: partial file prefix filtering", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(join(testDir, "project", "src"))}`);
    const entries = await res.json() as any[];

    // Client-side filtering by partial "ind"
    const filtered = entries.filter((e: any) => e.name.toLowerCase().startsWith("ind"));
    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe("index.ts");
    expect(filtered[0].isDir).toBe(false);
  });

  test("simulates full browse-to-select flow", async () => {
    // User clicks browse -> list testDir
    const step1 = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(testDir)}`);
    const entries1 = await step1.json() as any[];
    expect(entries1[0].name).toBe("project");
    expect(entries1[0].isDir).toBe(true);

    // User clicks "project" -> navigate
    const projectPath = join(testDir, "project");
    const step2 = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(projectPath)}`);
    const entries2 = await step2.json() as any[];
    const srcEntry = entries2.find((e: any) => e.name === "src");
    expect(srcEntry).toBeDefined();

    // User clicks "src"
    const srcPath = join(projectPath, "src");
    const step3 = await fetch(`${baseUrl}/api/fs/list?dir=${encodeURIComponent(srcPath)}`);
    const entries3 = await step3.json() as any[];
    const indexEntry = entries3.find((e: any) => e.name === "index.ts");
    expect(indexEntry).toBeDefined();
    expect(indexEntry.isDir).toBe(false);

    // User clicks "index.ts" -> final path
    const finalPath = join(srcPath, "index.ts");
    expect(finalPath).toBe(join(testDir, "project", "src", "index.ts"));
  });
});

// ── E2E: endpoint co-exists with other API routes ───────────────────

describe("fs/list endpoint coexistence", () => {
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

  test("fs/list works alongside agents API", async () => {
    const [agentsRes, fsRes] = await Promise.all([
      fetch(`${baseUrl}/api/agents`),
      fetch(`${baseUrl}/api/fs/list?dir=/tmp`),
    ]);

    expect(agentsRes.status).toBe(200);
    expect(fsRes.status).toBe(200);

    const agents = await agentsRes.json() as any;
    const entries = await fsRes.json() as any;

    expect(Array.isArray(agents)).toBe(true);
    expect(Array.isArray(entries)).toBe(true);
  });

  test("fs/list works alongside runs API", async () => {
    // Trigger a run and list fs concurrently
    const [runRes, fsRes] = await Promise.all([
      fetch(`${baseUrl}/api/agents/shell-runner/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo concurrent" }),
      }),
      fetch(`${baseUrl}/api/fs/list?dir=/tmp`),
    ]);

    expect(runRes.status).toBe(200);
    expect(fsRes.status).toBe(200);
  });

  test("CORS headers are present on fs/list response", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list?dir=/tmp`);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("OPTIONS preflight returns 204 (existing behavior covers fs/list)", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });

  test("POST to fs/list returns 404 (only GET supported)", async () => {
    const res = await fetch(`${baseUrl}/api/fs/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: "/tmp" }),
    });
    expect(res.status).toBe(404);
  });

  test("404 still works for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/api/fs/nonexistent`);
    expect(res.status).toBe(404);
  });
});
