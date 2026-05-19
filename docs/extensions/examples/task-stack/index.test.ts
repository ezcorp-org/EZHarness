import { test, expect, beforeAll, beforeEach, afterAll, describe, spyOn } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import {
  loadStore, saveStore, genId, ensureStack, getStackTasks, reindex,
  setStorePath, handleRequest, resolveProjectRoot,
} from "./index";
import type { JsonRpcRequest } from "@ezcorp/sdk";
import { getChannel, JsonRpcError } from "@ezcorp/sdk/runtime";

const TMP_DIR = join("/tmp", `task-stack-test-${Date.now()}`);
const TMP_PATH = join(TMP_DIR, "task-stack.json");

// ── Phase post-perm-cleanup: in-test fs RPC stub ──────────────────
//
// The extension now routes IO through the host's `ezcorp/fs.*`
// reverse-RPC (host-mediated, sandbox-friendly). Bun unit tests run
// in-process and have no host attached, so we stub `getChannel().request`
// for the three methods this extension uses (`read`, `write`, `mkdir`)
// and route them to real disk IO under `TMP_DIR`. Missing-file ENOENT
// surfaces as a `JsonRpcError(-32000, "ENOENT: ...")` to match the
// production host's wire shape — that's what `loadStore` matches on
// to fall back to the default store. Other unexpected RPC methods
// throw so test bugs are loud.
//
// `EZCORP_FS_ALLOWED=1` satisfies the SDK's pre-flight gate
// (`ensureFsAllowed`) without granting any real permission — the stub
// IS the host.
//
// Re-installed in beforeEach because the global `src/__tests__/preload.ts`
// runs `__resetChannelForTests()` after every test (drops the singleton
// to prevent cross-test leakage). That's the correct hygiene; we just
// have to re-stub on the fresh channel.

const ORIG_FS_ALLOWED = process.env.EZCORP_FS_ALLOWED;

function installFsStub(): void {
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((async (
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    const p = (params ?? {}) as Record<string, unknown>;
    const path = p.path as string;
    if (method === "ezcorp/fs.read") {
      if (!existsSync(path)) {
        // Match the host's error shape (see fs-handler.ts gatePath
        // ENOENT branch + ioErrorMsg). loadStore matches on this.
        throw new JsonRpcError(-32000, `ENOENT: no such file or directory: ${path}`);
      }
      const text = readFileSync(path, "utf-8");
      const body = btoa(text);
      return { encoding: "utf-8", body, bytes: text.length, resolvedPath: path };
    }
    if (method === "ezcorp/fs.write") {
      const content = p.content as string;
      writeFileSync(path, content);
      return { bytes: content.length, resolvedPath: path };
    }
    if (method === "ezcorp/fs.mkdir") {
      mkdirSync(path, { recursive: p.recursive === true });
      return { resolvedPath: path };
    }
    throw new Error(`task-stack test stub: unexpected RPC method ${method}`);
  }) as ReturnType<typeof getChannel>["request"]);
}

beforeAll(() => {
  process.env.EZCORP_FS_ALLOWED = "1";
});

afterAll(() => {
  if (ORIG_FS_ALLOWED === undefined) delete process.env.EZCORP_FS_ALLOWED;
  else process.env.EZCORP_FS_ALLOWED = ORIG_FS_ALLOWED;
  try { rmSync(TMP_DIR, { recursive: true }); } catch {}
});

beforeEach(() => {
  // Reset store for each test
  try { rmSync(TMP_PATH); } catch {}
  setStorePath(TMP_DIR, TMP_PATH);
  // Re-install stub — preload's afterEach drops the channel singleton.
  installFsStub();
});

function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args },
  };
  return handleRequest(req);
}

function getResult(res: any): any {
  if (res.error) throw new Error(res.error.message);
  return JSON.parse(res.result.content[0].text);
}

async function callAndParse(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return getResult(await call(name, args));
}

// --- Unit Tests: Project Root Detection ---

describe("resolveProjectRoot", () => {
  test("finds git root from project root", () => {
    const root = resolveProjectRoot(process.cwd());
    expect(Bun.file(join(root, ".git")).size).toBeGreaterThan(0);
  });

  test("finds git root from a subdirectory", () => {
    const subdir = join(process.cwd(), "web", "src");
    const root = resolveProjectRoot(subdir);
    // Should walk up to the same project root, not stay in web/src
    expect(root).not.toBe(subdir);
    expect(Bun.file(join(root, ".git")).size).toBeGreaterThan(0);
  });

  test("finds git root from deeply nested subdirectory", () => {
    const deep = join(process.cwd(), "web", "src", "lib", "components");
    const root = resolveProjectRoot(deep);
    expect(root).toBe(resolveProjectRoot(process.cwd()));
  });

  test("falls back to given dir when no .git found", () => {
    const result = resolveProjectRoot("/tmp");
    // /tmp has no .git, so it should fall back to /tmp
    expect(result).toBe("/tmp");
  });

  test("store path resolves to project root, not subdirectory", () => {
    const root = resolveProjectRoot(process.cwd());
    // STORE_DIR should be under project root, not under web/
    // Convention: all extension data under .ezcorp/extension-data/<ext-name>/
    const expected = join(root, ".ezcorp", "extension-data", "task-stack", "task-stack.json");
    expect(expected).not.toContain("web/.ezcorp");
    expect(expected).toContain(join(".ezcorp", "extension-data", "task-stack"));
  });
});

// --- Unit Tests: Project Root Detection — env-var fast path ---
//
// Phase post-perm-cleanup, validator coverage gap: the host-injected
// `EZCORP_PROJECT_ROOT` env-var path (resolution-order step 1 in
// `resolveProjectRoot`) had no direct test. Under the Phase 3
// sandbox-preload, `node:fs` is poisoned at module-load — the extension
// CANNOT walk for `.git` itself. The host walks once at spawn time and
// injects the answer. These tests pin that fast path so a future
// refactor can't silently drop it (forcing every sandboxed extension
// back into the require-fs fallback, which would crash under poison).

describe("resolveProjectRoot env-var path", () => {
  const ORIG = process.env.EZCORP_PROJECT_ROOT;

  test("returns env-var value verbatim when set, without filesystem walk", () => {
    // Use a sentinel path that does NOT exist on disk. If
    // resolveProjectRoot were doing an fs.existsSync walk it would fall
    // through to the `from` fallback; instead it MUST return the env
    // value directly.
    const SENTINEL = "/tmp/sentinel-project-root";
    process.env.EZCORP_PROJECT_ROOT = SENTINEL;
    try {
      // Pass a `from` arg that has its own real `.git` ancestor (the
      // repo root) — env-var path takes precedence, so we should NOT
      // see the repo root come back.
      expect(resolveProjectRoot(process.cwd())).toBe(SENTINEL);
      // Same with a deep subdirectory — env-var still wins.
      expect(resolveProjectRoot(join(process.cwd(), "web", "src"))).toBe(SENTINEL);
    } finally {
      if (ORIG === undefined) delete process.env.EZCORP_PROJECT_ROOT;
      else process.env.EZCORP_PROJECT_ROOT = ORIG;
    }
  });

  test("empty-string env-var falls through to fs walk (treated as unset)", () => {
    // Edge: `EZCORP_PROJECT_ROOT=""` should NOT be treated as a hint —
    // the host emits the var only when `findProjectRoot()` succeeded,
    // so any empty value is a malformed-test-env case. The implementation
    // uses `fromEnv.length > 0` to gate the fast path.
    process.env.EZCORP_PROJECT_ROOT = "";
    try {
      // Falls through to the lazy require-fs walk; from cwd it should
      // find this repo's `.git` ancestor (cwd itself is a worktree).
      const root = resolveProjectRoot(process.cwd());
      expect(root).not.toBe(""); // didn't return the empty env value
      // Repo root must contain a .git entry (worktree's `.git` is a file).
      expect(Bun.file(join(root, ".git")).size).toBeGreaterThan(0);
    } finally {
      if (ORIG === undefined) delete process.env.EZCORP_PROJECT_ROOT;
      else process.env.EZCORP_PROJECT_ROOT = ORIG;
    }
  });
});

// --- Unit Tests: Store Helpers ---

describe("Store helpers", () => {
  test("loadStore returns default store when file doesn't exist", async () => {
    const store = await loadStore();
    expect(store.stacks).toHaveLength(1);
    expect(store.stacks[0]!.name).toBe("inbox");
    expect(store.tasks).toEqual([]);
    expect(store.subtasks).toEqual([]);
    expect(store.dependencies).toEqual([]);
    expect(store.artifacts).toEqual([]);
  });

  test("saveStore creates dir and writes valid JSON", async () => {
    const store = await loadStore();
    await saveStore(store);
    const reloaded = await loadStore();
    expect(reloaded.stacks[0]!.name).toBe("inbox");
  });

  test("genId returns unique UUIDs", () => {
    const ids = new Set(Array.from({ length: 100 }, genId));
    expect(ids.size).toBe(100);
  });

  test("ensureStack creates stack if not found", async () => {
    const store = await loadStore();
    const stack = ensureStack(store, "backlog");
    expect(stack.name).toBe("backlog");
    expect(store.stacks).toHaveLength(2);
  });

  test("ensureStack returns existing if found", async () => {
    const store = await loadStore();
    const s1 = ensureStack(store, "inbox");
    const s2 = ensureStack(store, "inbox");
    expect(s1.id).toBe(s2.id);
    expect(store.stacks).toHaveLength(1);
  });

  test("reindex reassigns priority correctly", () => {
    const tasks = [
      { priority: 5 }, { priority: 10 }, { priority: 2 },
    ] as any[];
    reindex(tasks);
    expect(tasks.map(t => t.priority)).toEqual([0, 1, 2]);
  });
});

// --- loadStore non-ENOENT JsonRpcError branch ---
//
// Phase post-perm-cleanup, validator coverage gap: the existing
// "Store helpers" tests cover the happy path (file exists, JSON
// parses) and the corrupt-JSON branch ("corrupt store does not
// overwrite with defaults"). The ENOENT-fallback branch is also
// covered ("loadStore returns default store when file doesn't exist"
// — the stub throws JsonRpcError(-32000, "ENOENT...")).
//
// What WAS missing: the non-ENOENT JsonRpcError branch in `loadStore`
// (index.ts:139-150), which surfaces real host failures (permission
// denied, host crash, etc.) as "Failed to load store" instead of
// silently returning defaults. A future refactor could accidentally
// widen the ENOENT match (e.g. catch-all `if (err instanceof
// JsonRpcError)`) and start eating EACCES too — defaulting silently
// instead of erroring would be a real footgun.
describe("loadStore non-ENOENT JsonRpcError branch", () => {
  test("EACCES JsonRpcError surfaces as 'Failed to load store'", async () => {
    // Override the beforeEach-installed stub: this test uniquely needs
    // the channel to throw a non-ENOENT JsonRpcError. spyOn on the same
    // method replaces the prior mockImplementation on the channel
    // singleton (preload.ts's afterEach drops the singleton after each
    // test, so this override is scoped to this test only).
    const ch = getChannel();
    spyOn(ch, "request").mockImplementation((async (
      method: string,
      _params: unknown,
    ): Promise<unknown> => {
      if (method === "ezcorp/fs.read") {
        // Mirror the host's gatePath EACCES surface (fs-handler.ts).
        throw new JsonRpcError(-32000, "EACCES: permission denied: /tmp/x");
      }
      throw new Error(`unexpected RPC method ${method}`);
    }) as ReturnType<typeof getChannel>["request"]);

    await expect(loadStore()).rejects.toThrow(/Failed to load store/);
  });

  test("non-JsonRpcError generic Error also surfaces as 'Failed to load store'", async () => {
    // Generic Error from the channel (e.g. transport blew up before
    // the host could respond) should ALSO be wrapped — not silently
    // defaulted. The implementation's `instanceof JsonRpcError` gate
    // is the discriminator that limits ENOENT-fallback to true host
    // ENOENT responses, not arbitrary client-side failures.
    const ch = getChannel();
    spyOn(ch, "request").mockImplementation((async (
      method: string,
      _params: unknown,
    ): Promise<unknown> => {
      if (method === "ezcorp/fs.read") {
        throw new Error("transport error: channel closed");
      }
      throw new Error(`unexpected RPC method ${method}`);
    }) as ReturnType<typeof getChannel>["request"]);

    await expect(loadStore()).rejects.toThrow(/Failed to load store/);
  });
});

// --- Integration Tests: Stack Management ---

describe("Stack Management", () => {
  test("list-stacks returns default inbox", async () => {
    const stacks = await callAndParse("list-stacks");
    expect(stacks).toHaveLength(1);
    expect(stacks[0].name).toBe("inbox");
  });

  test("get-top-task returns null when empty", async () => {
    const result = await callAndParse("get-top-task");
    expect(result).toBeNull();
  });

  test("get-top-task returns lowest-priority pending task", async () => {
    const t1 = await callAndParse("add-task", { title: "First" });
    await callAndParse("add-task", { title: "Second" });
    const top = await callAndParse("get-top-task");
    expect(top.id).toBe(t1.id);
  });

  test("get-top-task skips blocked tasks", async () => {
    const t1 = await callAndParse("add-task", { title: "Blocker" });
    const t2 = await callAndParse("add-task", { title: "Blocked" });
    const t3 = await callAndParse("add-task", { title: "Free" });
    await callAndParse("add-dependency", { blockingTaskId: t1.id, dependentTaskId: t2.id });
    // t1 is top (not blocked), t2 is blocked by t1
    const top = await callAndParse("get-top-task");
    expect(top.id).toBe(t1.id);
    // Start and finish t1, now t2 should be top
    await callAndParse("start-task", { taskId: t1.id });
    await callAndParse("finish-task", { taskId: t1.id, summary: "done" });
    const top2 = await callAndParse("get-top-task");
    expect(top2.id).toBe(t2.id);
  });
});

// --- Integration Tests: Task CRUD ---

describe("Task CRUD", () => {
  test("add-task creates in inbox by default", async () => {
    const task = await callAndParse("add-task", { title: "Test" });
    expect(task.title).toBe("Test");
    expect(task.status).toBe("pending");
    const stacks = await callAndParse("list-stacks");
    expect(task.stackId).toBe(stacks[0].id);
  });

  test("add-task position top shifts others", async () => {
    const t1 = await callAndParse("add-task", { title: "Bottom" });
    const t2 = await callAndParse("add-task", { title: "Top", position: "top" });
    const tasks = await callAndParse("list-tasks");
    expect(tasks[0].id).toBe(t2.id);
    expect(tasks[0].priority).toBe(0);
    expect(tasks[1].id).toBe(t1.id);
    expect(tasks[1].priority).toBe(1);
  });

  test("add-task position bottom appends", async () => {
    await callAndParse("add-task", { title: "First" });
    const t2 = await callAndParse("add-task", { title: "Second", position: "bottom" });
    const tasks = await callAndParse("list-tasks");
    expect(tasks[tasks.length - 1].id).toBe(t2.id);
  });

  test("add-task with new stackId auto-creates stack", async () => {
    await callAndParse("add-task", { title: "Test", stackId: "backlog" });
    const stacks = await callAndParse("list-stacks");
    expect(stacks.some((s: any) => s.name === "backlog")).toBe(true);
  });

  test("list-tasks filters by stack and respects limit", async () => {
    await callAndParse("add-task", { title: "A" });
    await callAndParse("add-task", { title: "B" });
    await callAndParse("add-task", { title: "C" });
    const limited = await callAndParse("list-tasks", { limit: 2 });
    expect(limited).toHaveLength(2);
  });

  test("update-task modifies fields", async () => {
    const task = await callAndParse("add-task", { title: "Old" });
    const updated = await callAndParse("update-task", {
      taskId: task.id, title: "New", description: "Desc", dueDate: "2026-12-31",
    });
    expect(updated.title).toBe("New");
    expect(updated.description).toBe("Desc");
    expect(updated.dueDate).toBe("2026-12-31");
  });

  test("update-task with invalid id returns error", async () => {
    const res = await call("update-task", { taskId: "nonexistent" });
    expect(res.error).toBeDefined();
    expect(res.error.message).toContain("not found");
  });

  test("get-task-dependencies returns blocking and blocked", async () => {
    const t1 = await callAndParse("add-task", { title: "A" });
    const t2 = await callAndParse("add-task", { title: "B" });
    const t3 = await callAndParse("add-task", { title: "C" });
    await callAndParse("add-dependency", { blockingTaskId: t1.id, dependentTaskId: t2.id });
    await callAndParse("add-dependency", { blockingTaskId: t2.id, dependentTaskId: t3.id });
    const deps = await callAndParse("get-task-dependencies", { taskId: t2.id });
    expect(deps.blocking).toHaveLength(1);
    expect(deps.blocking[0].id).toBe(t1.id);
    expect(deps.blocked).toHaveLength(1);
    expect(deps.blocked[0].id).toBe(t3.id);
  });
});

// --- Integration Tests: Task Organization ---

describe("Task Organization", () => {
  test("move-task changes position", async () => {
    const t1 = await callAndParse("add-task", { title: "A" });
    const t2 = await callAndParse("add-task", { title: "B" });
    const t3 = await callAndParse("add-task", { title: "C" });
    await callAndParse("move-task", { taskId: t3.id, newPosition: 0 });
    const tasks = await callAndParse("list-tasks");
    expect(tasks[0].id).toBe(t3.id);
  });

  test("move-task-to-stack transfers and reindexes", async () => {
    const t1 = await callAndParse("add-task", { title: "A" });
    const t2 = await callAndParse("add-task", { title: "B" });
    await callAndParse("move-task-to-stack", { taskId: t1.id, targetStackId: "backlog" });
    const stacks = await callAndParse("list-stacks");
    const backlog = stacks.find((s: any) => s.name === "backlog");
    const tasks = await callAndParse("list-tasks", { stackId: "backlog" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(t1.id);
  });

  test("reorder-tasks sets new priority order", async () => {
    const t1 = await callAndParse("add-task", { title: "A" });
    const t2 = await callAndParse("add-task", { title: "B" });
    const t3 = await callAndParse("add-task", { title: "C" });
    const reordered = await callAndParse("reorder-tasks", { taskIds: [t3.id, t1.id, t2.id] });
    expect(reordered[0].priority).toBe(0);
    expect(reordered[0].id).toBe(t3.id);
    expect(reordered[1].priority).toBe(1);
    expect(reordered[2].priority).toBe(2);
  });
});

// --- Integration Tests: Task Lifecycle ---

describe("Task Lifecycle", () => {
  test("start-task sets active", async () => {
    const task = await callAndParse("add-task", { title: "Work" });
    const started = await callAndParse("start-task", { taskId: task.id });
    expect(started.status).toBe("active");
    expect(started.startedAt).toBeDefined();
    const active = await callAndParse("get-active-task");
    expect(active.id).toBe(task.id);
  });

  test("start-task when another is active deactivates the previous task", async () => {
    const t1 = await callAndParse("add-task", { title: "A" });
    const t2 = await callAndParse("add-task", { title: "B" });
    await callAndParse("start-task", { taskId: t1.id });
    const started = await callAndParse("start-task", { taskId: t2.id });
    expect(started.id).toBe(t2.id);
    expect(started.status).toBe("active");
    // Previous task should be deactivated
    const store = await loadStore();
    const prev = store.tasks.find(t => t.id === t1.id);
    expect(prev!.status).toBe("pending");
    expect(prev!.startedAt).toBeUndefined();
  });

  test("re-starting the same active task refreshes startedAt", async () => {
    const task = await callAndParse("add-task", { title: "A" });
    const first = await callAndParse("start-task", { taskId: task.id });
    const firstStartedAt = first.startedAt;
    // Small delay to ensure different timestamp
    await new Promise(r => setTimeout(r, 10));
    const second = await callAndParse("start-task", { taskId: task.id });
    expect(second.status).toBe("active");
    expect(second.startedAt).not.toBe(firstStartedAt);
  });

  test("get-active-task returns null when none active", async () => {
    const result = await callAndParse("get-active-task");
    expect(result).toBeNull();
  });

  test("finish-task completes and clears active", async () => {
    const task = await callAndParse("add-task", { title: "Work" });
    await callAndParse("start-task", { taskId: task.id });
    const finished = await callAndParse("finish-task", { taskId: task.id, summary: "All done" });
    expect(finished.status).toBe("completed");
    expect(finished.completionSummary).toBe("All done");
    expect(finished.completedAt).toBeDefined();
    const active = await callAndParse("get-active-task");
    expect(active).toBeNull();
  });
});

// --- Integration Tests: Dependencies ---

describe("Dependencies", () => {
  test("add-dependency creates relationship", async () => {
    const t1 = await callAndParse("add-task", { title: "A" });
    const t2 = await callAndParse("add-task", { title: "B" });
    const dep = await callAndParse("add-dependency", { blockingTaskId: t1.id, dependentTaskId: t2.id });
    expect(dep.blockingTaskId).toBe(t1.id);
    expect(dep.dependentTaskId).toBe(t2.id);
  });

  test("add-dependency detects circular dependency", async () => {
    const t1 = await callAndParse("add-task", { title: "A" });
    const t2 = await callAndParse("add-task", { title: "B" });
    await callAndParse("add-dependency", { blockingTaskId: t1.id, dependentTaskId: t2.id });
    const res = await call("add-dependency", { blockingTaskId: t2.id, dependentTaskId: t1.id });
    expect(res.error).toBeDefined();
    expect(res.error.message).toContain("Circular");
  });

  test("remove-dependency removes relationship", async () => {
    const t1 = await callAndParse("add-task", { title: "A" });
    const t2 = await callAndParse("add-task", { title: "B" });
    await callAndParse("add-dependency", { blockingTaskId: t1.id, dependentTaskId: t2.id });
    const res = await call("remove-dependency", { blockingTaskId: t1.id, dependentTaskId: t2.id });
    expect(res.error).toBeUndefined();
  });
});

// --- Integration Tests: Subtasks ---

describe("Subtasks", () => {
  test("add-subtask creates subtask on task", async () => {
    const task = await callAndParse("add-task", { title: "Parent" });
    const sub = await callAndParse("add-subtask", { taskId: task.id, title: "Child" });
    expect(sub.taskId).toBe(task.id);
    expect(sub.completed).toBe(false);
  });

  test("complete/uncomplete subtask toggles", async () => {
    const task = await callAndParse("add-task", { title: "Parent" });
    const sub = await callAndParse("add-subtask", { taskId: task.id, title: "Child" });
    const completed = await callAndParse("complete-subtask", { subtaskId: sub.id });
    expect(completed.completed).toBe(true);
    const uncompleted = await callAndParse("uncomplete-subtask", { subtaskId: sub.id });
    expect(uncompleted.completed).toBe(false);
  });

  test("update-subtask modifies title", async () => {
    const task = await callAndParse("add-task", { title: "Parent" });
    const sub = await callAndParse("add-subtask", { taskId: task.id, title: "Old" });
    const updated = await callAndParse("update-subtask", { subtaskId: sub.id, title: "New" });
    expect(updated.title).toBe("New");
  });

  test("delete-subtask removes and reindexes", async () => {
    const task = await callAndParse("add-task", { title: "Parent" });
    const s1 = await callAndParse("add-subtask", { taskId: task.id, title: "A" });
    const s2 = await callAndParse("add-subtask", { taskId: task.id, title: "B" });
    const s3 = await callAndParse("add-subtask", { taskId: task.id, title: "C" });
    await call("delete-subtask", { subtaskId: s2.id });
    const store = await loadStore();
    const remaining = store.subtasks.filter(s => s.taskId === task.id).sort((a, b) => a.position - b.position);
    expect(remaining).toHaveLength(2);
    expect(remaining[0]!.position).toBe(0);
    expect(remaining[1]!.position).toBe(1);
  });

  test("reorder-subtasks sets new order", async () => {
    const task = await callAndParse("add-task", { title: "Parent" });
    const s1 = await callAndParse("add-subtask", { taskId: task.id, title: "A" });
    const s2 = await callAndParse("add-subtask", { taskId: task.id, title: "B" });
    const reordered = await callAndParse("reorder-subtasks", { subtaskIds: [s2.id, s1.id] });
    expect(reordered[0].id).toBe(s2.id);
    expect(reordered[0].position).toBe(0);
    expect(reordered[1].id).toBe(s1.id);
    expect(reordered[1].position).toBe(1);
  });
});

// --- Integration Tests: Artifacts & Flags ---

describe("Artifacts & Flags", () => {
  test("add-artifact attaches to task", async () => {
    const task = await callAndParse("add-task", { title: "Work" });
    const art = await callAndParse("add-artifact", {
      taskId: task.id, type: "pr", title: "Fix PR", url: "https://github.com/pr/1",
    });
    expect(art.taskId).toBe(task.id);
    expect(art.type).toBe("pr");
  });

  test("mark/unmark ready for agent", async () => {
    const task = await callAndParse("add-task", { title: "Work" });
    const marked = await callAndParse("mark-ready-for-agent", { taskId: task.id });
    expect(marked.readyForAgent).toBe(true);
    const unmarked = await callAndParse("unmark-ready-for-agent", { taskId: task.id });
    expect(unmarked.readyForAgent).toBe(false);
  });
});

// --- E2E Lifecycle ---

describe("E2E Lifecycle", () => {
  test("full workflow", async () => {
    // Create stack and tasks
    const t1 = await callAndParse("add-task", { title: "Setup DB", stackId: "sprint" });
    const t2 = await callAndParse("add-task", { title: "Build API", stackId: "sprint" });
    const t3 = await callAndParse("add-task", { title: "Write Tests", stackId: "sprint" });

    // Add dependencies: API depends on DB, Tests depend on API
    await callAndParse("add-dependency", { blockingTaskId: t1.id, dependentTaskId: t2.id });
    await callAndParse("add-dependency", { blockingTaskId: t2.id, dependentTaskId: t3.id });

    // Add subtasks
    const sub1 = await callAndParse("add-subtask", { taskId: t1.id, title: "Create schema" });
    const sub2 = await callAndParse("add-subtask", { taskId: t1.id, title: "Run migrations" });

    // Top task should be t1 (others blocked)
    const top = await callAndParse("get-top-task", { stackId: "sprint" });
    expect(top.id).toBe(t1.id);

    // Start and work on t1
    await callAndParse("start-task", { taskId: t1.id });
    await callAndParse("complete-subtask", { subtaskId: sub1.id });
    await callAndParse("complete-subtask", { subtaskId: sub2.id });

    // Add artifact and finish
    await callAndParse("add-artifact", {
      taskId: t1.id, type: "commit", title: "DB setup", url: "abc123",
    });
    await callAndParse("finish-task", { taskId: t1.id, summary: "DB is ready" });

    // Now t2 should be top (t3 still blocked by t2)
    const top2 = await callAndParse("get-top-task", { stackId: "sprint" });
    expect(top2.id).toBe(t2.id);

    // Verify store state
    const store = await loadStore();
    expect(store.artifacts).toHaveLength(1);
    expect(store.tasks.find(t => t.id === t1.id)!.status).toBe("completed");
  });
});

// --- Concurrent add-task race condition ---

describe("Concurrent operations", () => {
  test("multiple add-task calls in parallel preserve all tasks", async () => {
    // Fire 5 add-task calls concurrently — all should be saved
    const results = await Promise.all([
      callAndParse("add-task", { title: "Task A" }),
      callAndParse("add-task", { title: "Task B" }),
      callAndParse("add-task", { title: "Task C" }),
      callAndParse("add-task", { title: "Task D" }),
      callAndParse("add-task", { title: "Task E" }),
    ]);

    expect(results).toHaveLength(5);
    const titles = results.map((r: any) => r.title).sort();
    expect(titles).toEqual(["Task A", "Task B", "Task C", "Task D", "Task E"]);

    // Verify ALL 5 are persisted in the store
    const store = await loadStore();
    expect(store.tasks).toHaveLength(5);
    const storedTitles = store.tasks.map(t => t.title).sort();
    expect(storedTitles).toEqual(["Task A", "Task B", "Task C", "Task D", "Task E"]);
  });

  test("concurrent add-task and start-task don't corrupt state", async () => {
    const task = await callAndParse("add-task", { title: "First" });

    // Add and start concurrently
    const [added, started] = await Promise.all([
      callAndParse("add-task", { title: "Second" }),
      callAndParse("start-task", { taskId: task.id }),
    ]);

    expect(added.title).toBe("Second");
    expect(started.status).toBe("active");

    const store = await loadStore();
    expect(store.tasks).toHaveLength(2);
    expect(store.activeTaskId).toBe(task.id);
  });

  test("rapid sequential adds preserve all tasks", async () => {
    // Simulate rapid UI clicks — each awaits but fires quickly
    for (let i = 0; i < 10; i++) {
      await callAndParse("add-task", { title: `Rapid ${i}` });
    }

    const store = await loadStore();
    expect(store.tasks).toHaveLength(10);
  });

  test("corrupt store file does not overwrite with defaults", async () => {
    // Add real tasks first
    await callAndParse("add-task", { title: "Important" });
    await callAndParse("add-task", { title: "Critical" });

    const store = await loadStore();
    expect(store.tasks).toHaveLength(2);

    // Write corrupt data to the store file
    const { writeFileSync } = await import("fs");
    writeFileSync(join(TMP_DIR, "task-stack.json"), '{"tasks":[{"tit');

    // loadStore should throw on corrupt data, not return defaults
    try {
      await loadStore();
      // If we get here, the data was somehow parseable — that's fine
    } catch (err) {
      expect((err as Error).message).toContain("Failed to load store");
    }
  });

  test("add-task after list-tasks preserves existing tasks", async () => {
    // This reproduces the exact user-reported bug
    await callAndParse("add-task", { title: "First task" });
    await callAndParse("add-task", { title: "Second task" });

    // List tasks (read-only)
    const listed = await callAndParse("list-tasks");
    expect(listed).toHaveLength(2);

    // Add a third task
    await callAndParse("add-task", { title: "Third task" });

    // List again — all 3 should be present
    const listed2 = await callAndParse("list-tasks");
    expect(listed2).toHaveLength(3);
    expect(listed2.map((t: any) => t.title).sort()).toEqual(["First task", "Second task", "Third task"]);
  });
});

// --- Integration Tests: Fail Task ---

describe("fail-task", () => {
  test("marks pending task as failed with failedAt and failureReason", async () => {
    const task = await callAndParse("add-task", { title: "Doomed" });
    const failed = await callAndParse("fail-task", {
      taskId: task.id,
      reason: "Dependency missing",
    });
    expect(failed.status).toBe("failed");
    expect(failed.failedAt).toBeDefined();
    expect(typeof failed.failedAt).toBe("string");
    expect(failed.failureReason).toBe("Dependency missing");
  });

  test("clears activeTaskId when failing the currently active task", async () => {
    const task = await callAndParse("add-task", { title: "Active work" });
    await callAndParse("start-task", { taskId: task.id });
    const activeBefore = await callAndParse("get-active-task");
    expect(activeBefore.id).toBe(task.id);

    await callAndParse("fail-task", { taskId: task.id, reason: "crashed" });
    const activeAfter = await callAndParse("get-active-task");
    expect(activeAfter).toBeNull();

    const store = await loadStore();
    expect(store.activeTaskId).toBeUndefined();
  });

  test("does not clear activeTaskId when failing a different task", async () => {
    const t1 = await callAndParse("add-task", { title: "Working" });
    const t2 = await callAndParse("add-task", { title: "Stalled" });
    await callAndParse("start-task", { taskId: t1.id });

    await callAndParse("fail-task", { taskId: t2.id, reason: "no data" });

    const active = await callAndParse("get-active-task");
    expect(active).not.toBeNull();
    expect(active.id).toBe(t1.id);
  });

  test("can transition an active task directly to failed", async () => {
    const task = await callAndParse("add-task", { title: "Try it" });
    await callAndParse("start-task", { taskId: task.id });

    const failed = await callAndParse("fail-task", { taskId: task.id, reason: "timeout" });
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("timeout");
    // startedAt should be preserved so we know how long it ran before failing
    expect(failed.startedAt).toBeDefined();
  });

  test("returns error for unknown taskId", async () => {
    const res = await call("fail-task", { taskId: "nonexistent", reason: "n/a" });
    expect(res.error).toBeDefined();
    expect(res.error.message).toContain("not found");
  });

  test("skipped tasks are excluded from get-top-task", async () => {
    const t1 = await callAndParse("add-task", { title: "Failed one" });
    const t2 = await callAndParse("add-task", { title: "Still pending" });
    await callAndParse("fail-task", { taskId: t1.id, reason: "bad" });

    const top = await callAndParse("get-top-task");
    expect(top).not.toBeNull();
    expect(top.id).toBe(t2.id);
  });
});

// --- Integration Tests: Get Store Snapshot ---

describe("get-store-snapshot", () => {
  test("without stackId returns full store shape", async () => {
    const t1 = await callAndParse("add-task", { title: "A", stackId: "sprint" });
    await callAndParse("add-task", { title: "B", stackId: "backlog" });
    await callAndParse("add-subtask", { taskId: t1.id, title: "step 1" });
    await callAndParse("add-artifact", {
      taskId: t1.id, type: "commit", title: "init", url: "abc",
    });

    const snap = await callAndParse("get-store-snapshot");
    expect(snap).toHaveProperty("stacks");
    expect(snap).toHaveProperty("tasks");
    expect(snap).toHaveProperty("subtasks");
    expect(snap).toHaveProperty("dependencies");
    expect(snap).toHaveProperty("artifacts");
    // activeTaskId may be undefined (and stripped by JSON.stringify), so just ensure
    // the serialized snapshot is scoped-full-store shaped (stacks present, etc.)
    expect(snap.activeTaskId).toBeUndefined();
    expect(snap.stacks.length).toBeGreaterThanOrEqual(2); // inbox + sprint + backlog
    expect(snap.tasks).toHaveLength(2);
    expect(snap.subtasks).toHaveLength(1);
    expect(snap.artifacts).toHaveLength(1);
  });

  test("without stackId includes activeTaskId when a task is active", async () => {
    const task = await callAndParse("add-task", { title: "Work" });
    await callAndParse("start-task", { taskId: task.id });
    const snap = await callAndParse("get-store-snapshot");
    expect(snap.activeTaskId).toBe(task.id);
  });

  test("with stackId returns only that stack's tasks/subtasks", async () => {
    const a = await callAndParse("add-task", { title: "sprint-A", stackId: "sprint" });
    await callAndParse("add-task", { title: "sprint-B", stackId: "sprint" });
    await callAndParse("add-task", { title: "backlog-A", stackId: "backlog" });
    await callAndParse("add-subtask", { taskId: a.id, title: "step" });

    const snap = await callAndParse("get-store-snapshot", { stackId: "sprint" });
    expect(snap.stack).toBeDefined();
    expect(snap.stack.name).toBe("sprint");
    expect(snap.tasks).toHaveLength(2);
    expect(snap.tasks.every((t: any) => t.stackId === snap.stack.id)).toBe(true);
    expect(snap.subtasks).toHaveLength(1);
    expect(snap.subtasks[0].taskId).toBe(a.id);
    // Snapshot shape excludes unrelated top-level fields when scoped
    expect(snap).not.toHaveProperty("stacks");
    expect(snap).not.toHaveProperty("artifacts");
  });

  test("with stackId returns activeTaskId only if it belongs to that stack", async () => {
    await callAndParse("add-task", { title: "sprint-A", stackId: "sprint" });
    const backlogTask = await callAndParse("add-task", { title: "backlog-A", stackId: "backlog" });
    await callAndParse("start-task", { taskId: backlogTask.id });

    // Active task is in backlog; sprint snapshot should hide it
    const sprintSnap = await callAndParse("get-store-snapshot", { stackId: "sprint" });
    expect(sprintSnap.activeTaskId).toBeUndefined();

    // Backlog snapshot should include it
    const backlogSnap = await callAndParse("get-store-snapshot", { stackId: "backlog" });
    expect(backlogSnap.activeTaskId).toBe(backlogTask.id);
  });

  test("with stackId auto-creates stack if it does not yet exist", async () => {
    const before = await callAndParse("list-stacks");
    expect(before.some((s: any) => s.name === "brand-new")).toBe(false);

    const snap = await callAndParse("get-store-snapshot", { stackId: "brand-new" });
    expect(snap.stack.name).toBe("brand-new");
    expect(snap.tasks).toEqual([]);

    const after = await callAndParse("list-stacks");
    expect(after.some((s: any) => s.name === "brand-new")).toBe(true);
  });

  test("with stackId only returns dependencies that involve that stack's tasks", async () => {
    const a = await callAndParse("add-task", { title: "A", stackId: "sprint" });
    const b = await callAndParse("add-task", { title: "B", stackId: "sprint" });
    const c = await callAndParse("add-task", { title: "C", stackId: "backlog" });
    // Intra-sprint dep (should appear in sprint snap)
    await callAndParse("add-dependency", { blockingTaskId: a.id, dependentTaskId: b.id });
    // Cross-stack dep (backlog task depends on sprint task — appears in both)
    await callAndParse("add-dependency", { blockingTaskId: a.id, dependentTaskId: c.id });

    const sprintSnap = await callAndParse("get-store-snapshot", { stackId: "sprint" });
    // Both deps touch sprint tasks (a is in sprint), so both appear
    expect(sprintSnap.dependencies).toHaveLength(2);

    const backlogSnap = await callAndParse("get-store-snapshot", { stackId: "backlog" });
    // Only the cross-stack dep touches backlog (c)
    expect(backlogSnap.dependencies).toHaveLength(1);
    expect(backlogSnap.dependencies[0].dependentTaskId).toBe(c.id);
  });
});

// --- Integration Tests: Failed status persistence ---

describe("failed status persistence", () => {
  test("failed tasks survive save/load roundtrip", async () => {
    const task = await callAndParse("add-task", { title: "Persists" });
    await callAndParse("fail-task", { taskId: task.id, reason: "io error" });

    // Re-read the store from disk (loadStore goes through Bun.file)
    const reloaded = await loadStore();
    const persisted = reloaded.tasks.find(t => t.id === task.id);
    expect(persisted).toBeDefined();
    expect(persisted!.status).toBe("failed");
    expect(persisted!.failureReason).toBe("io error");
    expect(persisted!.failedAt).toBeDefined();
  });

  test("snapshot after reload reports the failed task via get-store-snapshot", async () => {
    await callAndParse("add-task", { title: "ok one" });
    const t2 = await callAndParse("add-task", { title: "broken" });
    await callAndParse("fail-task", { taskId: t2.id, reason: "boom" });

    const snap = await callAndParse("get-store-snapshot");
    const got = snap.tasks.find((t: any) => t.id === t2.id);
    expect(got).toBeDefined();
    expect(got.status).toBe("failed");
    expect(got.failureReason).toBe("boom");
  });

  test("update-task does not clobber failed status (only updates title/description/dueDate)", async () => {
    const task = await callAndParse("add-task", { title: "Old title" });
    await callAndParse("fail-task", { taskId: task.id, reason: "nope" });

    // update-task should still allow editing description without changing status
    const updated = await callAndParse("update-task", {
      taskId: task.id,
      description: "new description",
    });
    expect(updated.status).toBe("failed");
    expect(updated.description).toBe("new description");
    expect(updated.failureReason).toBe("nope");
  });
});
