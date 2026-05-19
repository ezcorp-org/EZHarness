#!/usr/bin/env bun
// task-stack - Stack-based task management with subtasks, dependencies, and artifacts.
// Migrated onto @ezcorp/sdk/runtime (fs / lock / rpc wrappers) in Phase 2.3.
// Migrated to host-mediated fsRead/fsWrite/fsMkdir in Phase post-perm-cleanup
// — see tasks/post-perm-cleanup.md Phase A. Raw `node:fs` / `Bun.file` are
// poisoned by the sandbox-preload (Phase 3), so this extension now flows
// every IO through the `ezcorp/fs.*` reverse-RPC.

import type { JsonRpcRequest, JsonRpcResponse, ToolCallResult } from "@ezcorp/sdk";
import {
  fsRead,
  fsWrite,
  fsMkdir,
  createMutex,
  createToolDispatcher,
  getChannel,
  JsonRpcError,
  toolResult,
  toolError,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import { join, dirname } from "path";

// --- Types ---

interface Stack { id: string; name: string; createdAt: string; }
interface Task {
  id: string; stackId: string; title: string; description: string;
  dueDate?: string; priority: number;
  status: "pending" | "active" | "completed" | "failed";
  readyForAgent: boolean;
  startedAt?: string; completedAt?: string; completionSummary?: string;
  failedAt?: string; failureReason?: string;
  createdAt: string;
}
interface Subtask {
  id: string; taskId: string; title: string;
  completed: boolean; position: number; createdAt: string;
}
interface Dep { blockingTaskId: string; dependentTaskId: string; }
interface Artifact {
  id: string; taskId: string; type: string; title: string;
  url: string; metadata?: Record<string, unknown>; createdAt: string;
}
interface Store {
  stacks: Stack[]; tasks: Task[]; subtasks: Subtask[];
  dependencies: Dep[]; artifacts: Artifact[]; activeTaskId?: string;
}

// --- Project root detection ---
//
// Test-facing helper preserving the original silent-fallback semantics
// (the SDK's `findProjectRoot` throws when no `.git` ancestor is found;
// this wrapper swallows that and returns `from`, which several tests rely on).
//
// Resolution order:
//   1. `EZCORP_PROJECT_ROOT` env var, set by the host at spawn time
//      (`buildAllowedEnv` in `src/extensions/registry.ts`). This is the
//      production path — under the Phase 3 sandbox-preload, `node:fs` is
//      poisoned at module-load, so the extension can't walk for `.git`
//      itself. The host does the walk once and injects the answer.
//   2. Lazy `require("node:fs")` `.git` walk for unit tests + ad-hoc CLI
//      runs where no sandbox is active. Mirrors `loadFsSync()` in
//      `packages/@ezcorp/sdk/src/runtime/fs.ts` — keeping the require
//      lazy means the import doesn't trip the poison even when the SDK
//      module loads inside a sandboxed subprocess.

/** Walk up from `from` to locate a `.git` directory. Falls back to `from` when none is found. */
export function resolveProjectRoot(from: string = process.cwd()): string {
  // (1) Host-injected — production fast path.
  const fromEnv = process.env.EZCORP_PROJECT_ROOT;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  // (2) Lazy fs walk — only reached in test / CLI contexts where the
  // sandbox-preload poison isn't active. A static `import {existsSync}
  // from "fs"` would fire at module-load time, even for code paths that
  // never need the walk — so we require it on demand.
  let fs: typeof import("node:fs");
  try {
    fs = require("node:fs") as typeof import("node:fs");
  } catch {
    // fs unavailable (subprocess sandbox) and no env hint — return
    // `from` so callers don't crash; STORE_PATH-dependent code paths
    // will surface their own error when they actually need IO.
    return from;
  }
  let dir = from;
  while (true) {
    if (fs.existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from; // reached filesystem root
    dir = parent;
  }
}

// --- Store path ---
//
// CONVENTION: every extension stores its persistent data under
//   <projectRoot>/.ezcorp/extension-data/<extension-name>/
// This keeps the repo tidy (one `.gitignore` rule covers every extension's
// state) and avoids collisions between extensions.

const projectRoot = resolveProjectRoot();
export const STORE_DIR = join(projectRoot, ".ezcorp", "extension-data", "task-stack");
export let STORE_PATH = join(STORE_DIR, "task-stack.json");

/** Override store path (for tests). */
export function setStorePath(_dir: string, path: string) {
  STORE_PATH = path;
}

function defaultStore(): Store {
  return {
    stacks: [{ id: genId(), name: "inbox", createdAt: new Date().toISOString() }],
    tasks: [], subtasks: [], dependencies: [], artifacts: [],
  };
}

export async function loadStore(): Promise<Store> {
  // Phase post-perm-cleanup: routed through `fsRead` (host-mediated). The
  // host returns a JsonRpcError with code -32000 + an `ENOENT:` message
  // prefix when the file doesn't exist; we map that to defaults to
  // preserve the missing-store-defaults invariant. JSON.parse errors are
  // wrapped as "Failed to load store" so the corrupt-store-throws
  // invariant ("corrupt store does not overwrite with defaults" test)
  // still holds.
  let text: string;
  try {
    const result = await fsRead(STORE_PATH);
    // `fsRead` returns `string | Uint8Array`; encoding default is utf-8
    // so the host returns a string. Narrow defensively.
    text = typeof result === "string" ? result : new TextDecoder().decode(result);
  } catch (err) {
    // Host-side ENOENT surfaces as JsonRpcError. We treat ANY error
    // whose message starts with "ENOENT" as "missing → defaults".
    // JsonRpcError carries the host's message verbatim; plain Error
    // wrappers from atob/network etc. would have a different prefix.
    const msg = err instanceof Error ? err.message : String(err);
    if (
      err instanceof JsonRpcError &&
      err.code === -32000 &&
      msg.startsWith("ENOENT")
    ) {
      return defaultStore();
    }
    // Non-ENOENT errors (permission denied, host crash, etc.) are
    // genuine load failures — surface them rather than masking with
    // defaults.
    throw new Error(`Failed to load store: ${msg}`);
  }
  try {
    return JSON.parse(text) as Store;
  } catch (err) {
    throw new Error(`Failed to load store: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function saveStore(store: Store): Promise<void> {
  // Phase post-perm-cleanup: `fsWrite` does NOT auto-create parent
  // directories the way the SDK's host-side `saveJSON` did, so we
  // explicitly mkdir before writing. `recursive: true` is idempotent on
  // existing paths.
  await fsMkdir(dirname(STORE_PATH), { recursive: true });
  await fsWrite(STORE_PATH, JSON.stringify(store, null, 2));
}

export function genId(): string { return crypto.randomUUID(); }

function findTask(store: Store, id: string): Task | undefined {
  return store.tasks.find(t => t.id === id);
}
function findSubtask(store: Store, id: string): Subtask | undefined {
  return store.subtasks.find(s => s.id === id);
}

export function ensureStack(store: Store, name?: string): Stack {
  const n = (name ?? "inbox").toLowerCase();
  const existing = store.stacks.find(s => s.name === n || s.id === n);
  if (existing) return existing;
  const stack: Stack = { id: genId(), name: n, createdAt: new Date().toISOString() };
  store.stacks.push(stack);
  return stack;
}

export function getStackTasks(store: Store, stackId: string): Task[] {
  return store.tasks.filter(t => t.stackId === stackId).sort((a, b) => a.priority - b.priority);
}

export function reindex(tasks: Task[]): void {
  tasks.forEach((t, i) => { t.priority = i; });
}

function isBlocked(store: Store, taskId: string): boolean {
  return store.dependencies
    .filter(d => d.dependentTaskId === taskId)
    .some(d => {
      const blocker = findTask(store, d.blockingTaskId);
      return !blocker || blocker.status !== "completed";
    });
}

function hasCycle(store: Store, blockingId: string, dependentId: string): boolean {
  // Check if dependentId can reach blockingId through existing deps (would create cycle)
  const visited = new Set<string>();
  const queue = [blockingId];
  while (queue.length) {
    const current = queue.pop();
    if (current === undefined) break;
    if (current === dependentId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const d of store.dependencies) {
      if (d.dependentTaskId === current) queue.push(d.blockingTaskId);
    }
  }
  return false;
}

// --- Store mutex (prevents read-modify-write races) ---

const storeMutex = createMutex();

/** Serialize store access so concurrent requests don't clobber each other. */
export function withStoreLock<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  return storeMutex(async () => {
    const store = await loadStore();
    const result = await fn(store);
    await saveStore(store);
    return result;
  });
}

// --- Tool handlers ---

type Args = Record<string, unknown>;

/** Wrap a handler so it runs under the store mutex with a loaded+saved store. */
function storeTool<A extends Args = Args>(
  fn: (args: A, store: Store) => Promise<ToolCallResult> | ToolCallResult,
): ToolHandler<A> {
  return (args: A) => withStoreLock(async (store) => fn(args, store));
}

function json(data: unknown): ToolCallResult {
  return toolResult(JSON.stringify(data, null, 2));
}

const tools: Record<string, ToolHandler> = {
  // --- Stack Management ---
  "list-stacks": storeTool(async (_args, store) => json(store.stacks)),

  "get-top-task": storeTool(async (args, store) => {
    const stack = ensureStack(store, args.stackId as string | undefined);
    const tasks = getStackTasks(store, stack.id)
      .filter(t => t.status === "pending" && !isBlocked(store, t.id));
    return json(tasks[0] ?? null);
  }),

  // --- Task CRUD ---
  "add-task": storeTool(async (args, store) => {
    const title = args.title as string;
    if (!title) return toolError("title is required");
    const stack = ensureStack(store, args.stackId as string | undefined);
    const stackTasks = getStackTasks(store, stack.id);
    const position = (args.position as string) ?? "bottom";
    const task: Task = {
      id: genId(), stackId: stack.id, title, description: (args.description as string) ?? "",
      dueDate: args.dueDate as string | undefined,
      priority: position === "top" ? 0 : stackTasks.length,
      status: "pending", readyForAgent: false, createdAt: new Date().toISOString(),
    };
    if (position === "top") {
      for (const t of stackTasks) t.priority++;
    }
    store.tasks.push(task);
    return json(task);
  }),

  "list-tasks": storeTool(async (args, store) => {
    let tasks = store.tasks;
    if (args.stackId) {
      const stack = ensureStack(store, args.stackId as string);
      tasks = getStackTasks(store, stack.id);
    } else {
      tasks = [...tasks].sort((a, b) => a.priority - b.priority);
    }
    if (args.limit) tasks = tasks.slice(0, args.limit as number);
    return json(tasks);
  }),

  "update-task": storeTool(async (args, store) => {
    const task = findTask(store, args.taskId as string);
    if (!task) return toolError("Task not found");
    if (args.title) task.title = args.title as string;
    if (args.description !== undefined) task.description = args.description as string;
    if (args.dueDate !== undefined) task.dueDate = args.dueDate as string;
    return json(task);
  }),

  "get-task-dependencies": storeTool(async (args, store) => {
    const taskId = args.taskId as string;
    if (!findTask(store, taskId)) return toolError("Task not found");
    const blocking = store.dependencies
      .filter(d => d.dependentTaskId === taskId)
      .map(d => findTask(store, d.blockingTaskId)).filter(Boolean);
    const blocked = store.dependencies
      .filter(d => d.blockingTaskId === taskId)
      .map(d => findTask(store, d.dependentTaskId)).filter(Boolean);
    return json({ blocking, blocked });
  }),

  // --- Task Organization ---
  "move-task": storeTool(async (args, store) => {
    const task = findTask(store, args.taskId as string);
    if (!task) return toolError("Task not found");
    const stackTasks = getStackTasks(store, task.stackId).filter(t => t.id !== task.id);
    const pos = Math.max(0, Math.min(args.newPosition as number, stackTasks.length));
    stackTasks.splice(pos, 0, task);
    reindex(stackTasks);
    return json(task);
  }),

  "move-task-to-stack": storeTool(async (args, store) => {
    const task = findTask(store, args.taskId as string);
    if (!task) return toolError("Task not found");
    const oldStackTasks = getStackTasks(store, task.stackId).filter(t => t.id !== task.id);
    reindex(oldStackTasks);
    const targetStack = ensureStack(store, args.targetStackId as string);
    task.stackId = targetStack.id;
    const newStackTasks = getStackTasks(store, targetStack.id);
    const pos = args.position != null
      ? Math.max(0, Math.min(args.position as number, newStackTasks.length))
      : newStackTasks.length;
    const filtered = newStackTasks.filter(t => t.id !== task.id);
    filtered.splice(pos, 0, task);
    reindex(filtered);
    return json(task);
  }),

  "reorder-tasks": storeTool(async (args, store) => {
    const ids = args.taskIds as string[];
    if (!ids?.length) return toolError("taskIds is required");
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (id === undefined) continue;
      const task = findTask(store, id);
      if (task) task.priority = i;
    }
    return json(ids.map(id => findTask(store, id)).filter(Boolean));
  }),

  // --- Task Lifecycle ---
  "start-task": storeTool(async (args, store) => {
    const task = findTask(store, args.taskId as string);
    if (!task) return toolError("Task not found");
    // If another task is active, deactivate it first (unstick)
    if (store.activeTaskId && store.activeTaskId !== task.id) {
      const prev = findTask(store, store.activeTaskId);
      if (prev && prev.status === "active") {
        prev.status = "pending";
        prev.startedAt = undefined;
      }
    }
    task.status = "active";
    task.startedAt = new Date().toISOString();
    store.activeTaskId = task.id;
    return json(task);
  }),

  "get-active-task": storeTool(async (_args, store) => {
    if (!store.activeTaskId) return json(null);
    const task = findTask(store, store.activeTaskId);
    return json(task ?? null);
  }),

  "finish-task": storeTool(async (args, store) => {
    const task = findTask(store, args.taskId as string);
    if (!task) return toolError("Task not found");
    task.status = "completed";
    task.completedAt = new Date().toISOString();
    task.completionSummary = args.summary as string;
    if (store.activeTaskId === task.id) store.activeTaskId = undefined;
    const inlineArtifacts = args.artifacts as Array<{ type: string; title: string; url: string; metadata?: Record<string, unknown> }> | undefined;
    if (inlineArtifacts) {
      for (const a of inlineArtifacts) {
        store.artifacts.push({
          id: genId(), taskId: task.id, type: a.type, title: a.title,
          url: a.url, metadata: a.metadata, createdAt: new Date().toISOString(),
        });
      }
    }
    return json(task);
  }),

  "fail-task": storeTool(async (args, store) => {
    const task = findTask(store, args.taskId as string);
    if (!task) return toolError("Task not found");
    task.status = "failed";
    task.failedAt = new Date().toISOString();
    task.failureReason = args.reason as string;
    if (store.activeTaskId === task.id) store.activeTaskId = undefined;
    return json(task);
  }),

  "get-store-snapshot": storeTool(async (args, store) => {
    const stackIdentifier = args.stackId as string | undefined;
    if (stackIdentifier) {
      const stack = ensureStack(store, stackIdentifier);
      const tasks = getStackTasks(store, stack.id);
      const taskIds = new Set(tasks.map(t => t.id));
      const subtasks = store.subtasks.filter(s => taskIds.has(s.taskId));
      const dependencies = store.dependencies.filter(
        d => taskIds.has(d.blockingTaskId) || taskIds.has(d.dependentTaskId)
      );
      return json({
        stack,
        tasks,
        subtasks,
        dependencies,
        activeTaskId: store.activeTaskId && taskIds.has(store.activeTaskId) ? store.activeTaskId : undefined,
      });
    }
    return json({
      stacks: store.stacks,
      tasks: store.tasks,
      subtasks: store.subtasks,
      dependencies: store.dependencies,
      artifacts: store.artifacts,
      activeTaskId: store.activeTaskId,
    });
  }),

  // --- Dependencies ---
  "add-dependency": storeTool(async (args, store) => {
    const blockingId = args.blockingTaskId as string;
    const dependentId = args.dependentTaskId as string;
    if (!findTask(store, blockingId)) return toolError("Blocking task not found");
    if (!findTask(store, dependentId)) return toolError("Dependent task not found");
    if (blockingId === dependentId) return toolError("A task cannot depend on itself");
    if (hasCycle(store, blockingId, dependentId)) {
      return toolError("Circular dependency detected");
    }
    const exists = store.dependencies.some(d => d.blockingTaskId === blockingId && d.dependentTaskId === dependentId);
    if (!exists) {
      store.dependencies.push({ blockingTaskId: blockingId, dependentTaskId: dependentId });
    }
    return json({ blockingTaskId: blockingId, dependentTaskId: dependentId });
  }),

  "remove-dependency": storeTool(async (args, store) => {
    const before = store.dependencies.length;
    store.dependencies = store.dependencies.filter(
      d => !(d.blockingTaskId === args.blockingTaskId && d.dependentTaskId === args.dependentTaskId)
    );
    if (store.dependencies.length === before) return toolError("Dependency not found");
    return toolResult("Dependency removed");
  }),

  // --- Subtasks ---
  "add-subtask": storeTool(async (args, store) => {
    const taskId = args.taskId as string;
    if (!findTask(store, taskId)) return toolError("Task not found");
    const existing = store.subtasks.filter(s => s.taskId === taskId);
    const subtask: Subtask = {
      id: genId(), taskId, title: args.title as string,
      completed: false, position: existing.length, createdAt: new Date().toISOString(),
    };
    store.subtasks.push(subtask);
    return json(subtask);
  }),

  "update-subtask": storeTool(async (args, store) => {
    const subtask = findSubtask(store, args.subtaskId as string);
    if (!subtask) return toolError("Subtask not found");
    if (args.title !== undefined) subtask.title = args.title as string;
    if (args.completed !== undefined) subtask.completed = args.completed as boolean;
    return json(subtask);
  }),

  "complete-subtask": storeTool(async (args, store) => {
    const subtask = findSubtask(store, args.subtaskId as string);
    if (!subtask) return toolError("Subtask not found");
    subtask.completed = true;
    return json(subtask);
  }),

  "uncomplete-subtask": storeTool(async (args, store) => {
    const subtask = findSubtask(store, args.subtaskId as string);
    if (!subtask) return toolError("Subtask not found");
    subtask.completed = false;
    return json(subtask);
  }),

  "delete-subtask": storeTool(async (args, store) => {
    const idx = store.subtasks.findIndex(s => s.id === args.subtaskId);
    if (idx === -1) return toolError("Subtask not found");
    const deleted = store.subtasks[idx];
    if (!deleted) return toolError("Subtask not found");
    const taskId = deleted.taskId;
    store.subtasks.splice(idx, 1);
    const remaining = store.subtasks.filter(s => s.taskId === taskId).sort((a, b) => a.position - b.position);
    remaining.forEach((s, i) => { s.position = i; });
    return toolResult("Subtask deleted");
  }),

  "reorder-subtasks": storeTool(async (args, store) => {
    const ids = args.subtaskIds as string[];
    if (!ids?.length) return toolError("subtaskIds is required");
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (id === undefined) continue;
      const s = findSubtask(store, id);
      if (s) s.position = i;
    }
    return json(ids.map(id => findSubtask(store, id)).filter(Boolean));
  }),

  // --- Artifacts & Flags ---
  "add-artifact": storeTool(async (args, store) => {
    const taskId = args.taskId as string;
    if (!findTask(store, taskId)) return toolError("Task not found");
    const artifact: Artifact = {
      id: genId(), taskId, type: args.type as string, title: args.title as string,
      url: args.url as string, metadata: args.metadata as Record<string, unknown> | undefined,
      createdAt: new Date().toISOString(),
    };
    store.artifacts.push(artifact);
    return json(artifact);
  }),

  "mark-ready-for-agent": storeTool(async (args, store) => {
    const task = findTask(store, args.taskId as string);
    if (!task) return toolError("Task not found");
    task.readyForAgent = true;
    return json(task);
  }),

  "unmark-ready-for-agent": storeTool(async (args, store) => {
    const task = findTask(store, args.taskId as string);
    if (!task) return toolError("Task not found");
    task.readyForAgent = false;
    return json(task);
  }),
};

// --- JSON-RPC adapter (kept for tests + any caller that invokes handlers directly) ---

export async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  if (req.method !== "tools/call") {
    return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Unknown method: ${req.method}` } };
  }
  const name = (req.params?.name as string) ?? "";
  const args = (req.params?.arguments as Record<string, unknown>) ?? {};
  const handler = tools[name];
  if (!handler) {
    return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Unknown tool: ${name}` } };
  }
  try {
    const result = await handler(args);
    if (result.isError) {
      const first = result.content[0];
      const msg = first && first.type === "text" ? first.text : "Tool error";
      return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: msg } };
    }
    return { jsonrpc: "2.0", id: req.id, result };
  } catch (err) {
    if (err instanceof JsonRpcError) {
      return { jsonrpc: "2.0", id: req.id, error: { code: err.code, message: err.message } };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: msg } };
  }
}

// --- Production wiring ---
//
// Gated on `import.meta.main` so test imports don't open stdin. Order is
// load-bearing: `getChannel()` arms the dispatcher registration before
// `createToolDispatcher(tools)` supplies the handlers; `ch.start()` then
// kicks off the stdin read loop.

if (import.meta.main) {
  const ch = getChannel();
  createToolDispatcher(tools);
  ch.start();
}
