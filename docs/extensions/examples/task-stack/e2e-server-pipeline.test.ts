/**
 * E2E test: exercises the REAL server pipeline for task-stack.
 *
 * Mirrors the canonical `docs/extensions/examples/auto-note/e2e-server-pipeline.test.ts`
 * pattern. Spawns task-stack through `ExtensionProcess` (from
 * `src/extensions/subprocess.ts`) — the same class the server uses in
 * `ExtensionRegistry.getProcess` — so bugs that only surface in the full
 * server-pipeline path (sandbox preload, JSON-RPC framing with notifications,
 * mutex behaviour under concurrent calls, env allowlist) are reproducible here.
 *
 * Isolated into its own file because `mock.module("../../../../src/db/queries/extensions")`
 * would otherwise contaminate the shared module cache for the rest of the
 * task-stack tests (which import nothing from src/db).
 */
import { test, expect, describe, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";

// ── DB stubs ────────────────────────────────────────────────────
// Must be declared BEFORE importing ExtensionProcess so the subprocess module
// picks up the mocked queries (`incrementFailures` / `resetFailures` /
// `disableExtension`) rather than hitting a real DB that isn't configured in
// this test harness.

let incrementCalls = 0;
let resetCalls = 0;
let disableCalls = 0;
let simulatedConsecutiveFailures = 0;

mock.module("../../../../src/db/queries/extensions", () => ({
  incrementFailures: async () => {
    incrementCalls++;
    simulatedConsecutiveFailures++;
    return simulatedConsecutiveFailures;
  },
  resetFailures: async () => {
    resetCalls++;
    simulatedConsecutiveFailures = 0;
  },
  disableExtension: async () => {
    disableCalls++;
  },
}));

// Import AFTER mock.module so the subprocess module resolves to our stub.
import { ExtensionProcess } from "../../../../src/extensions/subprocess";

// ── buildAllowedEnv() parity ────────────────────────────────────
// Mirrors registry.ts buildAllowedEnv() for task-stack's permissions-minimal
// manifest: filesystem: ["$CWD"], shell: false, no network/env permissions —
// so the allowlist is just PATH/HOME/NODE_ENV/TMPDIR.
function buildAllowedEnvLike(extensionId: string): Record<string, string> {
  const extTmpDir = join(tmpdir(), "ezcorp-ext", extensionId);
  mkdirSync(extTmpDir, { recursive: true });
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "test",
    TMPDIR: extTmpDir,
  };
}

const TASK_STACK_ENTRYPOINT = join(import.meta.dir, "index.ts");
const TEST_TMP_ROOT = join(tmpdir(), `task-stack-e2e-pipeline-${Date.now()}`);

// ── Helpers ─────────────────────────────────────────────────────
function makeProc(): ExtensionProcess {
  const extId = "task-stack-test-" + Math.random().toString(36).slice(2, 8);
  const env = buildAllowedEnvLike(extId);
  return new ExtensionProcess(extId, TASK_STACK_ENTRYPOINT, env, {
    persistent: true,
    callTimeoutMs: 15_000,
  });
}

describe("E2E: task-stack real ExtensionProcess (server pipeline)", () => {
  let cwd: string;
  let originalCwd: string;
  const procs: ExtensionProcess[] = [];

  beforeEach(() => {
    // Each test gets its own store dir; task-stack's `resolveProjectRoot`
    // walks up for a `.git` ancestor. Using a fresh cwd with `.git` ensures
    // the extension writes into OUR tmp area, not the repo. The subprocess
    // inherits the parent's cwd (Bun.spawn does not override it).
    cwd = join(TEST_TMP_ROOT, `root-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(cwd, ".git"), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(cwd);

    incrementCalls = 0;
    resetCalls = 0;
    disableCalls = 0;
    simulatedConsecutiveFailures = 0;
  });

  afterEach(() => {
    for (const p of procs.splice(0)) {
      try { p.kill(); } catch { /* already dead */ }
    }
    try { process.chdir(originalCwd); } catch { /* best-effort */ }
  });

  afterAll(() => {
    try { rmSync(TEST_TMP_ROOT, { recursive: true }); } catch { /* best-effort */ }
  });

  test("add-task → list-tasks round-trip via real JSON-RPC transport", async () => {
    const proc = makeProc();
    procs.push(proc);

    const added = await proc.callTool("add-task", { title: "pipeline-note" });
    expect(added.isError).toBe(false);
    const addedFirst = added.content[0];
    if (!addedFirst || addedFirst.type !== "text") throw new Error("expected text content");
    expect(addedFirst.text).toContain("pipeline-note");

    const listed = await proc.callTool("list-tasks", {});
    expect(listed.isError).toBe(false);
    const listedFirst = listed.content[0];
    if (!listedFirst || listedFirst.type !== "text") throw new Error("expected text content");
    expect(listedFirst.text).toContain("pipeline-note");

    // Three successful RPC calls (add + list + internal probe) → resetFailures called,
    // increment never invoked because the subprocess stayed up.
    expect(resetCalls).toBeGreaterThanOrEqual(2);
    expect(incrementCalls).toBe(0);
  }, 30_000);

  test("persistent process handles 5 sequential add-task calls without disconnection", async () => {
    const proc = makeProc();
    procs.push(proc);

    for (let i = 0; i < 5; i++) {
      const r = await proc.callTool("add-task", { title: `sequential-${i}` });
      expect(r.isError).toBe(false);
    }

    const listed = await proc.callTool("list-tasks", {});
    expect(listed.isError).toBe(false);
    const listedFirst = listed.content[0];
    if (!listedFirst || listedFirst.type !== "text") throw new Error("expected text content");
    const parsed = JSON.parse(listedFirst.text) as Array<{ title: string }>;
    expect(parsed).toHaveLength(5);
    expect(proc.isRunning).toBe(true);
  }, 60_000);

  test("concurrent add-task (Promise.all of 3) — createMutex preserves all writes", async () => {
    const proc = makeProc();
    procs.push(proc);

    const results = await Promise.all([
      proc.callTool("add-task", { title: "concurrent-A" }),
      proc.callTool("add-task", { title: "concurrent-B" }),
      proc.callTool("add-task", { title: "concurrent-C" }),
    ]);

    for (const r of results) {
      expect(r.isError).toBe(false);
    }

    const listed = await proc.callTool("list-tasks", {});
    expect(listed.isError).toBe(false);
    const listedFirst = listed.content[0];
    if (!listedFirst || listedFirst.type !== "text") throw new Error("expected text content");
    const titles = (JSON.parse(listedFirst.text) as Array<{ title: string }>).map((t) => t.title);
    expect(titles).toContain("concurrent-A");
    expect(titles).toContain("concurrent-B");
    expect(titles).toContain("concurrent-C");
    expect(proc.isRunning).toBe(true);
  }, 30_000);

  test("malformed tool args return isError:true without killing the subprocess", async () => {
    const proc = makeProc();
    procs.push(proc);

    // Missing required `title` → tool-level error (toolError("title is required")).
    const bad = await proc.callTool("add-task", {} as Record<string, unknown>);
    expect(bad.isError).toBe(true);

    // Next valid call still works — dispatcher is resilient to tool-level errors.
    const ok = await proc.callTool("add-task", { title: "recovery" });
    expect(ok.isError).toBe(false);
    expect(proc.isRunning).toBe(true);
  }, 30_000);

  test("unknown tool returns JSON-RPC error → isError:true; process survives", async () => {
    const proc = makeProc();
    procs.push(proc);

    const bad = await proc.callTool("no-such-tool", {});
    expect(bad.isError).toBe(true);

    // Recovery call
    const ok = await proc.callTool("list-stacks", {});
    expect(ok.isError).toBe(false);
    const okFirst = ok.content[0];
    if (!okFirst || okFirst.type !== "text") throw new Error("expected text content");
    expect(okFirst.text).toContain("inbox");
    expect(proc.isRunning).toBe(true);
  }, 30_000);

  test("store persists across sequential RPC calls — atomicRead/saveJSON round-trip", async () => {
    const proc = makeProc();
    procs.push(proc);

    const added = await proc.callTool("add-task", { title: "persisted" });
    expect(added.isError).toBe(false);
    const addedFirst = added.content[0];
    if (!addedFirst || addedFirst.type !== "text") throw new Error("expected text content");
    const taskId = (JSON.parse(addedFirst.text) as { id: string }).id;

    // Separate RPC — the subprocess must reload the store via atomicRead
    // and surface our just-persisted task.
    const fetched = await proc.callTool("get-store-snapshot", {});
    expect(fetched.isError).toBe(false);
    const fetchedFirst = fetched.content[0];
    if (!fetchedFirst || fetchedFirst.type !== "text") throw new Error("expected text content");
    const snapshot = JSON.parse(fetchedFirst.text) as { tasks: Array<{ id: string; title: string }> };
    const found = snapshot.tasks.find((t) => t.id === taskId);
    expect(found).toBeDefined();
    expect(found?.title).toBe("persisted");
  }, 30_000);
});
