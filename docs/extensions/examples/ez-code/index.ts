#!/usr/bin/env bun
// ── ez-code — Warren-style coding-agent control plane ────────────────
//
// B1 surface:
//   - `dispatch_run` tool → spawnAssignment + persist a run record to Storage.
//   - `list_runs` tool → read the run records (newest first).
//   - registerEventHandler("task:assignment_update") → append the event to the
//     run's log + flip its status, then pushPage("dashboard", …) for a live
//     SSE-driven refresh of the Hub tab.
//   - definePage("dashboard") → a stats header + a runs table with status
//     badges + an event-log view, rendered from declarative tree data.
//
// All page content is data: the host renders native Svelte from the tree;
// this code never touches the DOM. Run history is self-tracked in Storage
// (v1 gap: extensions cannot read agent_runs through the SDK).

import {
  Memory,
  PageBuilder,
  Schedule,
  Storage,
  createToolDispatcher,
  definePage,
  fsExists,
  fsRead,
  getChannel,
  pushPage,
  registerEventHandler,
  toolError,
  toolResult,
  type HubPageTree,
  type MemoryRecord,
  type PageActionEvent,
  type ScheduleHandlerContext,
  type SubscribableEventMap,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import { spawnAssignment, cancelRun } from "@ezcorp/sdk/runtime";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// Seam B (ez-sandbox) — open_pr jails its git/gh subprocess via the host's
// buildSandboxArgv so a run's shell can't read/write `.ezcorp/data` (the
// PGlite DB + JWT secret). A reference example may reach into the host
// sandbox layer (other examples already import host modules in their config).
import { buildSandboxArgv } from "../../../../src/extensions/sandbox/build-sandbox-argv";
import { getSandboxTier } from "../../../../src/extensions/sandbox/capability-probe";

/** Payload of the `task:assignment_update` event (re-derived from the
 *  exported event map — the concrete type isn't re-exported by name). */
type TaskAssignmentUpdateEvent = SubscribableEventMap["task:assignment_update"];

export const PAGE_ID = "dashboard";
export const RUNS_KEY = "runs";
export const MAX_RUNS = 100;
export const MAX_EVENTS_PER_RUN = 50;
export const CANCEL_EVENT = "ez-code:cancel";
export const STEER_EVENT = "ez-code:steer";
export const TRIGGER_CRONS = ["0 * * * *", "0 9 * * *"] as const;
export const TRIGGERS_PATH = ".ezcorp/extension-data/ez-code/triggers.json";
export const TASKS_KEY = "tasks";
export const MAX_TASKS = 50;

/** A cron-trigger entry (Warren triggers.yaml analog). */
export interface Trigger {
  cron: string;
  agentName: string;
  task: string;
  title?: string;
  autonomousContinuation?: boolean;
  enabled?: boolean;
}

/** A lightweight self-tracked task/issue (seeds). */
export interface TaskRecord {
  id: string;
  title: string;
  status: "open" | "closed";
  createdAt: string;
  runId?: string;
}

export type RunStatus = "dispatched" | "running" | "completed" | "failed" | "cancelled";

export interface RunEvent {
  at: string; // ISO timestamp
  status: string; // raw assignment status from the host event
  note?: string;
}

export interface RunRecord {
  id: string; // agentRunId (the host-generated run id)
  taskId: string;
  assignmentId: string;
  subConversationId: string;
  agentName: string;
  title: string;
  task: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  events: RunEvent[];
}

// ── Run stores (Storage-backed; injectable for tests) ────────────────
//
// PRIVACY (cross-user leak fix): user-dispatched runs are PER-USER and MUST
// NOT bleed into the shared Hub page tree (which the host caches per
// (extension,pageId) and serves to ALL users — render() gets no requesting
// user, see hub-render-pull.ts). So we keep TWO buckets:
//   - USER scope (Storage("user") → ctx.userId): runs a user dispatched.
//     Read/written only in the invoking user's tool-call context. NEVER
//     pushed into the shared tree.
//   - GLOBAL scope (Storage("global") → null, reachable from ownerless cron
//     fires): cron-fired/system runs. These are the ONLY runs the shared
//     dashboard renders, and even then their private `/chat/<sub>` deep-links
//     are stripped.

export interface RunStore {
  read(): Promise<RunRecord[]>;
  write(runs: RunRecord[]): Promise<void>;
}

function storageBackedRunStore(scope: "user" | "global"): RunStore {
  const storage = new Storage(scope);
  return {
    async read() {
      const result = await storage.get<RunRecord[]>(RUNS_KEY);
      return Array.isArray(result.value) ? result.value : [];
    },
    async write(runs) {
      await storage.set(RUNS_KEY, runs);
    },
  };
}

let userStore: RunStore | null = null;
let globalStore: RunStore | null = null;
function getUserStore(): RunStore {
  if (!userStore) userStore = storageBackedRunStore("user");
  return userStore;
}
function getGlobalStore(): RunStore {
  if (!globalStore) globalStore = storageBackedRunStore("global");
  return globalStore;
}
/** Test seam: substitute the per-user (tool-context) run store. */
export function _setUserStoreForTests(s: RunStore | null): void {
  userStore = s;
}
/** Test seam: substitute the global (cron/system) run store. */
export function _setGlobalStoreForTests(s: RunStore | null): void {
  globalStore = s;
}

// Indirections so tests can observe pushes + drive spawn deterministically.
let pushPageImpl: typeof pushPage = pushPage;
export function _setPushPageForTests(fn: typeof pushPage | null): void {
  pushPageImpl = fn ?? pushPage;
}
let spawnImpl: typeof spawnAssignment = spawnAssignment;
export function _setSpawnForTests(fn: typeof spawnAssignment | null): void {
  spawnImpl = fn ?? spawnAssignment;
}
let cancelImpl: typeof cancelRun = cancelRun;
export function _setCancelForTests(fn: typeof cancelRun | null): void {
  cancelImpl = fn ?? cancelRun;
}
// append-message has no SDK wrapper — call the reverse RPC directly. The
// seam lets tests observe the request without a live channel.
type AppendMessageRpc = (params: Record<string, unknown>) => Promise<unknown>;
let appendMessageImpl: AppendMessageRpc = (params) =>
  getChannel().request("ezcorp/append-message", params);
export function _setAppendMessageForTests(fn: AppendMessageRpc | null): void {
  appendMessageImpl = fn ?? ((params) => getChannel().request("ezcorp/append-message", params));
}

// ── Pure helpers ──────────────────────────────────────────────────

/** Prepend the newest run; cap the list. Pure — returns a new array. */
export function appendRun(runs: RunRecord[], run: RunRecord): RunRecord[] {
  return [run, ...runs].slice(0, MAX_RUNS);
}

/** Map a host assignment status onto our run status. Pure. */
export function mapStatus(assignmentStatus: string): RunStatus {
  switch (assignmentStatus) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "dispatched";
  }
}

/**
 * Apply a task:assignment_update event to the matching run (by agentRunId
 * or assignmentId): flip status + append a capped event-log entry. Pure —
 * returns a NEW array; runs not matching pass through unchanged. Returns
 * the same array reference semantics aside, callers persist the result.
 */
export function applyAssignmentUpdate(
  runs: RunRecord[],
  evt: TaskAssignmentUpdateEvent,
): RunRecord[] {
  const a = evt.assignment;
  const at = new Date().toISOString();
  return runs.map((r) => {
    const matches =
      (a.agentRunId && r.id === a.agentRunId) ||
      r.assignmentId === a.id ||
      r.taskId === evt.taskId;
    if (!matches) return r;
    const status = mapStatus(a.status);
    const events = [
      { at, status: a.status, ...(a.resultPreview ? { note: a.resultPreview } : {}) },
      ...r.events,
    ].slice(0, MAX_EVENTS_PER_RUN);
    return { ...r, status, updatedAt: at, events };
  });
}

/** Whether any run in the list matches the event (by run/assignment/task id).
 *  Pure — lets the caller skip a store write when the event isn't for this
 *  bucket. */
export function runMatches(runs: RunRecord[], evt: TaskAssignmentUpdateEvent): boolean {
  const a = evt.assignment;
  return runs.some(
    (r) =>
      (!!a.agentRunId && r.id === a.agentRunId) ||
      r.assignmentId === a.id ||
      r.taskId === evt.taskId,
  );
}

/** A run is steerable/cancellable only while it's still live. Pure. */
export function isLive(status: RunStatus): boolean {
  return status === "dispatched" || status === "running";
}

/** Append a free-form event to the matching run (status optionally forced).
 *  Pure — returns a NEW array. */
export function recordRunEvent(
  runs: RunRecord[],
  runId: string,
  evt: { status: string; note?: string },
  forceStatus?: RunStatus,
): RunRecord[] {
  const at = new Date().toISOString();
  return runs.map((r) => {
    if (r.id !== runId) return r;
    const events = [{ at, ...evt }, ...r.events].slice(0, MAX_EVENTS_PER_RUN);
    return { ...r, updatedAt: at, ...(forceStatus ? { status: forceStatus } : {}), events };
  });
}

const STATUS_BADGE: Record<RunStatus, string> = {
  dispatched: "● dispatched",
  running: "▶ running",
  completed: "✓ completed",
  failed: "✗ failed",
  cancelled: "⊘ cancelled",
};

/** Optional sidebars surfaced on the dashboard (B4): agent memory (mulch) +
 *  the task/issue queue (seeds). */
export interface DashboardExtras {
  memories?: MemoryRecord[];
  tasks?: TaskRecord[];
}

/** Append the memory (mulch) + task (seeds) sections to a page. Pure. */
export function appendExtras(page: PageBuilder, extras: DashboardExtras): void {
  const tasks = extras.tasks ?? [];
  const memories = extras.memories ?? [];
  if (tasks.length > 0) {
    page.heading(3, "Task queue (seeds)");
    page.table(
      ["Task", "Status", "Created"],
      tasks.map((t) => ({
        cells: [t.title, t.status, t.createdAt.slice(0, 16).replace("T", " ")],
      })),
    );
  }
  if (memories.length > 0) {
    page.heading(3, "Agent memory (mulch)");
    page.table(
      ["Memory", "Category", "Confidence"],
      memories.map((m) => ({
        cells: [m.content.slice(0, 80), m.category, m.confidence],
      })),
    );
  }
}

/** Build the dashboard tree from the run list (+ optional B4 extras). Pure. */
export function buildDashboard(runs: RunRecord[], extras: DashboardExtras = {}): HubPageTree {
  const active = runs.filter((r) => r.status === "dispatched" || r.status === "running").length;
  const completed = runs.filter((r) => r.status === "completed").length;
  const failed = runs.filter((r) => r.status === "failed").length;

  const page = new PageBuilder("ez-code")
    .markdownBlock(
      "Ephemeral coding-agent runs dispatched on the active project. " +
        "Status refreshes live as each run emits `task:assignment_update`.",
    )
    .stats([
      { label: "Total runs", value: String(runs.length), hint: `last ${MAX_RUNS} kept` },
      { label: "Active", value: String(active) },
      { label: "Completed", value: String(completed) },
      { label: "Failed", value: String(failed) },
    ]);

  if (runs.length === 0) {
    page.emptyState(
      "No runs dispatched yet",
      "Use the `dispatch_run` tool to spawn a coding-agent run on this project.",
    );
    appendExtras(page, extras);
    return page.build();
  }

  page.table(
    ["Run", "Agent", "Status", "Updated", "Latest event"],
    runs.map((r) => {
      const cells = [
        r.title || r.id.slice(0, 8),
        r.agentName,
        STATUS_BADGE[r.status],
        r.updatedAt.slice(0, 16).replace("T", " "),
        r.events[0] ? `${r.events[0].status}${r.events[0].note ? ` — ${r.events[0].note}` : ""}` : "—",
      ];
      // PRIVACY: this tree is the SHARED Hub page (cached + served to all
      // users). It carries ONLY ownerless cron/system runs (see the store
      // split) and must NEVER expose a private `/chat/<subConversationId>`
      // deep-link cross-user. Live runs still get a confirm-gated CANCEL
      // action (a legitimate system action keyed on the run id); there is no
      // per-user deep-link href on any row.
      if (isLive(r.status)) {
        return {
          cells,
          action: {
            event: CANCEL_EVENT,
            payload: { runId: r.id },
            confirm: `Cancel run "${r.title || r.id.slice(0, 8)}"? This stops the agent.`,
          },
        };
      }
      return { cells };
    }),
  );

  appendExtras(page, extras);
  return page.build();
}

// ── Handlers ──────────────────────────────────────────────────────

/** Read GLOBAL (cron/system) runs + memory + tasks and build the SHARED
 *  dashboard. Memory/task reads fail-SOFT (a reverse-RPC blip must not blank
 *  the page). PRIVACY: reads the global store ONLY — user-dispatched runs are
 *  per-user (user scope) and are NEVER rendered into this shared, cross-user
 *  cached tree. */
export async function buildDashboardLive(): Promise<HubPageTree> {
  const runs = await getGlobalStore().read();
  let memories: MemoryRecord[] = [];
  let tasks: TaskRecord[] = [];
  try {
    memories = await memoryImpl();
  } catch {
    /* fail-soft */
  }
  try {
    tasks = await getTaskStore().read();
  } catch {
    /* fail-soft */
  }
  return buildDashboard(runs, { memories, tasks });
}

export async function renderDashboard(): Promise<HubPageTree> {
  return buildDashboardLive();
}

/** Push a fresh SHARED dashboard tree (global/cron runs only). Only called
 *  from ownerless/system contexts — NEVER from a user tool call (that would
 *  cache one user's private runs into the shared tree). */
async function pushSharedDashboard(): Promise<void> {
  pushPageImpl(PAGE_ID, await buildDashboardLive());
}

/** Shared dispatch logic: spawn a sub-agent + persist a run record into the
 *  given store. `push` is true only for ownerless/system (cron) dispatches —
 *  user tool dispatches write to the per-user store and do NOT push (privacy).
 */
export async function dispatchRunCore(
  input: {
    agentName: string;
    task: string;
    title?: string;
    autonomousContinuation?: boolean;
  },
  store: RunStore,
  push: boolean,
): Promise<RunRecord> {
  const handle = await spawnImpl({
    agentName: input.agentName,
    task: input.task,
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    ...(input.autonomousContinuation ? { autonomousContinuation: {} } : {}),
  });
  const now = new Date().toISOString();
  const record: RunRecord = {
    id: handle.agentRunId,
    taskId: handle.taskId,
    assignmentId: handle.assignmentId,
    subConversationId: handle.subConversationId,
    agentName: input.agentName,
    title: input.title?.trim() ?? "",
    task: input.task,
    status: "dispatched",
    createdAt: now,
    updatedAt: now,
    events: [{ at: now, status: "dispatched" }],
  };
  const runs = appendRun(await store.read(), record);
  await store.write(runs);
  if (push) await pushSharedDashboard();
  return record;
}

/** dispatch_run tool — spawn a sub-agent + persist to the PER-USER store.
 *  Runs in the invoking user's tool-call context (Storage("user") →
 *  ctx.userId), so the record is private to that user and is NOT pushed into
 *  the shared dashboard. */
export const dispatchRun: ToolHandler = async (args) => {
  const { agentName, task, title, autonomousContinuation } = (args ?? {}) as {
    agentName?: unknown;
    task?: unknown;
    title?: unknown;
    autonomousContinuation?: unknown;
  };
  if (typeof agentName !== "string" || agentName.trim().length === 0) {
    return toolError("'agentName' is required and must be a non-empty string");
  }
  if (typeof task !== "string" || task.trim().length === 0) {
    return toolError("'task' is required and must be a non-empty string");
  }

  let record: RunRecord;
  try {
    record = await dispatchRunCore(
      {
        agentName: agentName.trim(),
        task: task.trim(),
        ...(typeof title === "string" ? { title } : {}),
        autonomousContinuation: autonomousContinuation === true,
      },
      getUserStore(),
      false, // user-private — never push into the shared tree
    );
  } catch (err) {
    return toolError(`dispatch_run failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return toolResult(
    JSON.stringify({
      runId: record.id,
      subConversationId: record.subConversationId,
      status: record.status,
    }),
  );
};

/** list_runs tool — read the invoking user's OWN runs (per-user store),
 *  newest first. */
export const listRuns: ToolHandler = async (args) => {
  const { limit } = (args ?? {}) as { limit?: unknown };
  const runs = await getUserStore().read();
  const n = typeof limit === "number" && limit > 0 ? Math.floor(limit) : MAX_RUNS;
  const slice = runs.slice(0, n).map((r) => ({
    id: r.id,
    title: r.title,
    agentName: r.agentName,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    latestEvent: r.events[0] ?? null,
  }));
  return toolResult(JSON.stringify({ runs: slice }));
};

// ── steer_run ─────────────────────────────────────────────────────

/** Shared steer logic over a given store: append a steering turn into the
 *  run's sub-conversation, record the steer event, and (for shared/global
 *  runs only) push a fresh dashboard. Returns the outcome. */
export async function steerRunById(
  runId: string,
  message: string,
  parentMessageId: string | undefined = undefined,
  store: RunStore = getUserStore(),
  push = false,
): Promise<{ ok: boolean; error?: string }> {
  const runs = await store.read();
  const run = runs.find((r) => r.id === runId);
  if (!run) return { ok: false, error: `no run with id '${runId}'` };
  if (!isLive(run.status)) {
    return { ok: false, error: `run '${runId}' is ${run.status} — not steerable` };
  }
  try {
    await appendMessageImpl({
      conversationId: run.subConversationId,
      ...(parentMessageId ? { parentMessageId } : {}),
      role: "extension",
      content: `[ez-code steer] ${message}`,
      excluded: true,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const next = recordRunEvent(runs, runId, {
    status: "steered",
    note: message.slice(0, 120),
  });
  await store.write(next);
  if (push) await pushSharedDashboard();
  return { ok: true };
}

/** steer_run tool — steer one of the invoking user's OWN runs (user store). */
export const steerRun: ToolHandler = async (args) => {
  const { runId, message, parentMessageId } = (args ?? {}) as {
    runId?: unknown;
    message?: unknown;
    parentMessageId?: unknown;
  };
  if (typeof runId !== "string" || !runId.trim()) {
    return toolError("'runId' is required and must be a non-empty string");
  }
  if (typeof message !== "string" || !message.trim()) {
    return toolError("'message' is required and must be a non-empty string");
  }
  const res = await steerRunById(
    runId.trim(),
    message.trim(),
    typeof parentMessageId === "string" && parentMessageId.trim() ? parentMessageId.trim() : undefined,
    getUserStore(),
    false,
  );
  if (!res.ok) return toolError(`steer_run failed: ${res.error}`);
  return toolResult(JSON.stringify({ runId, steered: true }));
};

// ── cancel_run ────────────────────────────────────────────────────

/** Shared cancel logic over a given store: host-side cancel + flip the
 *  record to cancelled (and push for shared/global runs only). */
export async function cancelRunById(
  runId: string,
  store: RunStore = getUserStore(),
  push = false,
): Promise<{ ok: boolean; error?: string }> {
  const runs = await store.read();
  const run = runs.find((r) => r.id === runId);
  if (!run) return { ok: false, error: `no run with id '${runId}'` };
  let result: Awaited<ReturnType<typeof cancelRun>>;
  try {
    result = await cancelImpl(runId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!result.cancelled) {
    return { ok: false, error: `host rejected cancel: ${result.reason ?? "unknown"}` };
  }
  const next = recordRunEvent(runs, runId, { status: "cancelled" }, "cancelled");
  await store.write(next);
  if (push) await pushSharedDashboard();
  return { ok: true };
}

/** cancel_run tool — cancel one of the invoking user's OWN runs (user store). */
export const cancelRunTool: ToolHandler = async (args) => {
  const { runId } = (args ?? {}) as { runId?: unknown };
  if (typeof runId !== "string" || !runId.trim()) {
    return toolError("'runId' is required and must be a non-empty string");
  }
  const res = await cancelRunById(runId.trim(), getUserStore(), false);
  if (!res.ok) return toolError(`cancel_run failed: ${res.error}`);
  return toolResult(JSON.stringify({ runId, cancelled: true }));
};

// ── open_pr (branch → commit → push → gh pr create) ───────────────

/** Result of running one shell command. */
export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a command in a given cwd. Injectable so tests drive git/gh
 *  deterministically against a throwaway repo + a mocked remote. */
export type ShellRunner = (
  cmd: string[],
  cwd: string,
) => Promise<ShellResult>;

/**
 * Resolve the per-run jail's rw allowlist for a git WORKTREE checkout: the
 * worktree itself (RW — git writes the index/branch refs + the commit's tree)
 * plus the device dir, and the MAIN repo's `.git` dir (RW — a linked worktree
 * stores its per-worktree metadata under `<mainRepo>/.git/worktrees/<name>`
 * and commits/pushes write objects + refs into the shared `.git`).
 *
 * Crucially the worktree contains ONLY tracked files (gitignored `.ezcorp/` is
 * absent by construction), and `<mainRepo>/.git` is a SIBLING of `.ezcorp`, so
 * granting it does NOT grant `.ezcorp`. The repo ROOT is never granted on any
 * tier — `.ezcorp/data` (PGlite DB + JWT secret) is therefore never in the
 * jail's allowlist, closing the read-capability residual.
 */
export function worktreeRwPaths(worktree: string, gitDir: string): string[] {
  return [worktree, gitDir, "/dev"];
}

/**
 * Production runner — runs `cmd` in `cwd` (an `.ezcorp`-free git worktree)
 * UNDER the Seam B sandbox jail (`buildSandboxArgv`): the worktree + the main
 * repo's `.git` dir are read-write, system dirs read-only, and the project
 * repo ROOT is NEVER granted. On the advisory tier this is a plain spawn
 * (documented status-quo). The extension holds `shell: true`.
 *
 * `gitDir` is the main repo's `.git` directory (the worktree's commits/pushes
 * write objects + refs there). When omitted (e.g. the advisory smoke path) the
 * jail grants only the worktree + `/dev`.
 *
 * `projectRoot` is the MAIN repo root — used ONLY to compute the forbidden
 * `.ezcorp/data` path the builder asserts every grant stays clear of. It must
 * be the repo (whose data dir is the real secret), NOT the worktree (which is
 * outside the repo and contains no `.ezcorp/`). When omitted it defaults to
 * the cwd (the advisory smoke path, where cwd is a throwaway dir).
 *
 * Security: because the granted set is the worktree (tracked files only) +
 * `<mainRepo>/.git` (a sibling of `.ezcorp`) — never the repo root — the
 * in-repo `.ezcorp/data` convention path AND the real platform DB/JWT secret
 * are outside every grant and stay denied READ and WRITE on all tiers.
 */
export function makeProductionShell(gitDir?: string, projectRoot?: string): ShellRunner {
  return async (cmd, cwd) => {
    const rwPaths = gitDir ? worktreeRwPaths(cwd, gitDir) : [cwd, "/dev"];
    const built = buildSandboxArgv({
      tier: getSandboxTier(),
      workspaceDir: rwPaths[0] ?? cwd,
      // The forbidden-data-dir anchor is the MAIN repo (its `.ezcorp/data` is
      // the secret). Defaults to cwd when no repo is threaded (smoke path).
      projectRoot: projectRoot ?? cwd,
      rwPaths: rwPaths.slice(1),
      command: cmd[0]!,
      args: cmd.slice(1),
    });
    const proc = Bun.spawn(built.argv, {
      cwd,
      env: { ...process.env, ...built.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  };
}
/** Default production runner — jails to the cwd + `/dev` only (no `.git`
 *  grant). `openPrForRun` builds a `gitDir`-aware runner per run. */
export const productionShell: ShellRunner = makeProductionShell();
let shellImpl: ShellRunner = productionShell;
export function _setShellForTests(fn: ShellRunner | null): void {
  shellImpl = fn ?? productionShell;
}

// ── Host-side git orchestration (UNJAILED) ────────────────────────
//
// Worktree setup/teardown + change enumeration run as plain host git in the
// MAIN repo — they are NOT the jailed git/gh that this fix isolates (those run
// inside the `.ezcorp`-free worktree). Injectable so the integration test can
// drive a throwaway repo and assert the jail spec without a live host git.

/** Runs a command in `cwd` and returns its result. Plain host spawn. */
export type HostRunner = (cmd: string[], cwd: string) => Promise<ShellResult>;
export const productionHostRunner: HostRunner = async (cmd, cwd) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};
let hostRunnerImpl: HostRunner = productionHostRunner;
export function _setHostRunnerForTests(fn: HostRunner | null): void {
  hostRunnerImpl = fn ?? productionHostRunner;
}

// The active project's git repo root (host-injected at spawn). The per-run
// git work runs HERE — the active project only, no multi-repo cloning.
let projectRootImpl: () => string | undefined = () => process.env.EZCORP_PROJECT_ROOT;
export function _setProjectRootForTests(fn: (() => string | undefined) | null): void {
  projectRootImpl = fn ?? (() => process.env.EZCORP_PROJECT_ROOT);
}

/** Branch name for a run. Pure — slugifies the run id. */
export function branchForRun(runId: string): string {
  const slug = runId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40);
  return `ez-code/${slug}`;
}

/** One parsed `git status --porcelain -z` entry. `kind` is derived from the
 *  two-letter XY status so the materializer can copy / delete / rename
 *  faithfully. `path` is repo-relative (the post-rename path for renames). */
export interface StatusEntry {
  kind: "modify" | "delete" | "rename";
  path: string; // current (post-rename) repo-relative path
  oldPath?: string; // pre-rename path (rename only)
}

/**
 * Parse `git status --porcelain -z` output into a faithful change list. The
 * `-z` format is NUL-separated; a rename/copy entry (`R`/`C`) is followed by a
 * SECOND NUL-separated field carrying the OLD path. Gitignored files (incl.
 * `.ezcorp/`) are absent — `--porcelain` excludes them by default. Pure.
 *
 * XY semantics we care about (X=index, Y=worktree):
 *   - `D` in either column → the path was deleted → replicate the deletion.
 *   - `R`/`C` → rename/copy → delete the old path + copy the new one.
 *   - anything else with content (`M`/`A`/`?`/`T`…) → copy the current file.
 */
export function parsePorcelainZ(out: string): StatusEntry[] {
  const fields = out.split("\0").filter((f) => f.length > 0);
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i]!;
    // Format: "XY <path>" (the status is 2 chars + a space, then the path).
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    const x = xy[0];
    const y = xy[1];
    if (x === "R" || x === "C") {
      // Rename/copy: the NEXT field is the OLD path.
      const oldPath = fields[++i] ?? "";
      entries.push({ kind: "rename", path, oldPath });
      continue;
    }
    if (x === "D" || y === "D") {
      entries.push({ kind: "delete", path });
      continue;
    }
    entries.push({ kind: "modify", path });
  }
  return entries;
}

/**
 * Materialize the run's working-tree changes from `srcRepo` into `worktree`
 * WITHOUT git stash. The worktree is a detached checkout of HEAD (tracked
 * files only — gitignored `.ezcorp/` is absent by construction); we layer the
 * run's pending changes on top so the commit carries exactly the intended
 * diff, INCLUDING newly-created untracked (non-ignored) files. Stash-free:
 * the change set comes from `git status --porcelain -z` (which itself excludes
 * gitignored paths) and is replayed by plain filesystem copy/delete.
 */
export async function materializeChanges(
  srcRepo: string,
  worktree: string,
  entries: StatusEntry[],
): Promise<void> {
  for (const e of entries) {
    if (e.kind === "delete") {
      rmSync(join(worktree, e.path), { force: true });
      continue;
    }
    if (e.kind === "rename") {
      if (e.oldPath) rmSync(join(worktree, e.oldPath), { force: true });
      copyInto(srcRepo, worktree, e.path);
      continue;
    }
    copyInto(srcRepo, worktree, e.path);
  }
}

/** Copy `rel` from `srcRepo` into `worktree`, creating parent dirs. Preserves
 *  symlinks as symlinks (so a symlinked change isn't dereferenced into the
 *  worktree). A source that vanished mid-run is skipped (treated as a no-op,
 *  mirroring git's own tolerance). */
function copyInto(srcRepo: string, worktree: string, rel: string): void {
  const src = join(srcRepo, rel);
  const dst = join(worktree, rel);
  mkdirSync(dirname(dst), { recursive: true });
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(src);
  } catch {
    return; // vanished — skip
  }
  rmSync(dst, { force: true, recursive: true });
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(src), dst);
    return;
  }
  if (stat.isDirectory()) {
    // A directory entry in porcelain output is a submodule boundary; copy
    // it shallowly (its tracked contents come through as their own entries).
    mkdirSync(dst, { recursive: true });
    return;
  }
  copyFileSync(src, dst);
}

/**
 * Shared open-PR logic. To close the repo-root read residual, git/gh run
 * inside a FRESH git WORKTREE (a detached checkout of HEAD outside the repo)
 * that contains ONLY tracked files — gitignored `.ezcorp/` (PGlite DB + JWT
 * secret) is absent by construction. The run's pending changes are
 * materialized into the worktree stash-free (from `git status --porcelain`),
 * then branch → commit → push → `gh pr create` run there UNDER the Seam B
 * jail, whose allowlist is the worktree + the main repo's `.git` (a SIBLING of
 * `.ezcorp`) — never the repo root. The worktree is removed on every path.
 * Returns the PR url on success; each step fails closed on a non-zero exit.
 */
export async function openPrForRun(
  runId: string,
  opts: { title?: string; body?: string } = {},
  store: RunStore = getUserStore(),
  push = false,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const runs = await store.read();
  const run = runs.find((r) => r.id === runId);
  if (!run) return { ok: false, error: `no run with id '${runId}'` };

  const repo = projectRootImpl();
  if (!repo) {
    return { ok: false, error: "EZCORP_PROJECT_ROOT unset — no active project repo" };
  }

  const branch = branchForRun(runId);
  const title = (opts.title ?? run.title ?? `ez-code run ${runId}`).trim() || `ez-code run ${runId}`;
  const body = opts.body ?? `Automated PR for ez-code run \`${runId}\` (agent: ${run.agentName}).`;

  // Resolve the main repo's `.git` dir (host-side; the worktree's git ops
  // write objects/refs there). `git rev-parse --absolute-git-dir` yields the
  // absolute path; fall back to `<repo>/.git` if the probe fails.
  const gitDirProbe = await hostRunnerImpl(["git", "rev-parse", "--absolute-git-dir"], repo);
  const gitDir =
    gitDirProbe.exitCode === 0 && gitDirProbe.stdout.trim()
      ? gitDirProbe.stdout.trim()
      : join(repo, ".git");

  // Detect the repo's default branch for the PR base (host-side — pure read).
  const headRef = await hostRunnerImpl(
    ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
    repo,
  );
  const base =
    headRef.exitCode === 0 ? headRef.stdout.trim().split("/").pop() || "main" : "main";

  // Create the throwaway worktree OUTSIDE the repo (never under `.ezcorp/`).
  const wtRoot = mkdtempSync(join(tmpdir(), "ez-code-wt-"));
  const worktree = join(wtRoot, "wt");
  let added = false;
  try {
    const add = await hostRunnerImpl(
      ["git", "worktree", "add", "--detach", worktree, "HEAD"],
      repo,
    );
    if (add.exitCode !== 0) {
      return {
        ok: false,
        error: `git worktree add failed (exit ${add.exitCode}): ${add.stderr.trim() || add.stdout.trim()}`,
      };
    }
    added = true;

    // Enumerate the run's pending changes (excludes gitignored `.ezcorp/`).
    const status = await hostRunnerImpl(["git", "status", "--porcelain", "-z"], repo);
    if (status.exitCode !== 0) {
      return {
        ok: false,
        error: `git status failed (exit ${status.exitCode}): ${status.stderr.trim()}`,
      };
    }
    await materializeChanges(repo, worktree, parsePorcelainZ(status.stdout));

    // The jailed git/gh runner: worktree (RW) + main `.git` (RW) + ro runtime
    // + /dev. The repo ROOT is NEVER granted, so `.ezcorp/data` is denied.
    const jailedShell = makeProductionShell(gitDir, repo);
    // When tests inject a custom shell, honor it; otherwise use the
    // gitDir-aware production jail (NOT the default cwd-only runner).
    const runCmd =
      shellImpl === productionShell ? jailedShell : shellImpl;

    const steps: string[][] = [
      ["git", "switch", "-c", branch],
      ["git", "add", "-A"],
      ["git", "commit", "-m", title],
      ["git", "push", "-u", "origin", branch],
      // --base targets the detected default branch; --head is our run branch.
      ["gh", "pr", "create", "--base", base, "--title", title, "--body", body, "--head", branch],
    ];

    let prUrl = "";
    for (const cmd of steps) {
      const res = await runCmd(cmd, worktree);
      if (res.exitCode !== 0) {
        return {
          ok: false,
          error: `\`${cmd.join(" ")}\` failed (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`,
        };
      }
      if (cmd[0] === "gh") prUrl = res.stdout.trim();
    }

    const next = recordRunEvent(runs, runId, {
      status: "pr_opened",
      note: prUrl || branch,
    });
    await store.write(next);
    if (push) await pushSharedDashboard();
    return { ok: true, url: prUrl || undefined };
  } finally {
    // Cleanup on BOTH success and failure — never leak the worktree.
    if (added) {
      await hostRunnerImpl(["git", "worktree", "remove", "--force", worktree], repo);
    }
    rmSync(wtRoot, { recursive: true, force: true });
  }
}

/** open_pr tool — branch → commit → push → gh pr create for a run. */
export const openPr: ToolHandler = async (args) => {
  const { runId, title, body } = (args ?? {}) as {
    runId?: unknown;
    title?: unknown;
    body?: unknown;
  };
  if (typeof runId !== "string" || !runId.trim()) {
    return toolError("'runId' is required and must be a non-empty string");
  }
  const res = await openPrForRun(runId.trim(), {
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof body === "string" ? { body } : {}),
  });
  if (!res.ok) return toolError(`open_pr failed: ${res.error}`);
  return toolResult(JSON.stringify({ runId, prUrl: res.url ?? null, opened: true }));
};

// ── B4: cron triggers + memory (mulch) + tasks (seeds) ────────────

/** Trigger reader (fsRead-backed; injectable for tests). Returns [] when the
 *  file is absent or malformed (a missing triggers file is a no-op). */
export type TriggersReader = () => Promise<Trigger[]>;
export const productionTriggers: TriggersReader = async () => {
  try {
    if (!(await fsExists(TRIGGERS_PATH))) return [];
    const raw = (await fsRead(TRIGGERS_PATH, { encoding: "utf-8" })) as string;
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.triggers) ? parsed.triggers : [];
    return arr.filter(
      (t: unknown): t is Trigger =>
        !!t &&
        typeof (t as Trigger).cron === "string" &&
        typeof (t as Trigger).agentName === "string" &&
        typeof (t as Trigger).task === "string",
    );
  } catch {
    return [];
  }
};
let triggersImpl: TriggersReader = productionTriggers;
export function _setTriggersForTests(fn: TriggersReader | null): void {
  triggersImpl = fn ?? productionTriggers;
}

// Memory (mulch) reader — injectable; defaults to the SDK Memory client.
export type MemoryReader = () => Promise<MemoryRecord[]>;
const productionMemory: MemoryReader = () => new Memory().list({ limit: 10 });
let memoryImpl: MemoryReader = productionMemory;
export function _setMemoryForTests(fn: MemoryReader | null): void {
  memoryImpl = fn ?? productionMemory;
}

// Task (seeds) store — Storage-backed; reuses the run store's seam pattern.
export interface TaskStore {
  read(): Promise<TaskRecord[]>;
  write(tasks: TaskRecord[]): Promise<void>;
}
let taskStore: TaskStore | null = null;
function getTaskStore(): TaskStore {
  if (!taskStore) {
    const storage = new Storage("global");
    taskStore = {
      async read() {
        const r = await storage.get<TaskRecord[]>(TASKS_KEY);
        return Array.isArray(r.value) ? r.value : [];
      },
      async write(tasks) {
        await storage.set(TASKS_KEY, tasks);
      },
    };
  }
  return taskStore;
}
export function _setTaskStoreForTests(s: TaskStore | null): void {
  taskStore = s;
}

/**
 * Select the triggers that fire on a given cron. Pure. A trigger fires when
 * its cron matches AND it is not explicitly disabled.
 */
export function triggersForCron(triggers: Trigger[], cron: string): Trigger[] {
  return triggers.filter((t) => t.cron === cron && t.enabled !== false);
}

/**
 * Cron-fire handler: read triggers.json, dispatch a run for each trigger that
 * matches the firing cron, and record a `seed` task per dispatch. Pushes the
 * dashboard once after the batch. Each dispatch failure is isolated (one bad
 * trigger doesn't abort the rest).
 */
export async function handleTriggerFire(ctx: ScheduleHandlerContext): Promise<void> {
  const triggers = triggersForCron(await triggersImpl(), ctx.cron);
  if (triggers.length === 0) return;

  let dispatched = false;
  for (const t of triggers) {
    try {
      // Cron fires are OWNERLESS/system — dispatch into the GLOBAL store
      // (Storage("global"), reachable from cron) so they appear on the
      // shared dashboard. Don't push per-dispatch; one batch push below.
      const record = await dispatchRunCore(
        {
          agentName: t.agentName,
          task: t.task,
          ...(t.title ? { title: t.title } : {}),
          autonomousContinuation: t.autonomousContinuation === true,
        },
        getGlobalStore(),
        false,
      );
      // Seed a task entry for the dispatched run.
      const tasks = await getTaskStore().read();
      const seed: TaskRecord = {
        id: record.id,
        title: t.title || t.task.slice(0, 60),
        status: "open",
        createdAt: record.createdAt,
        runId: record.id,
      };
      await getTaskStore().write([seed, ...tasks].slice(0, MAX_TASKS));
      dispatched = true;
    } catch {
      // Isolate: a failing trigger must not abort the rest of the batch.
    }
  }
  if (dispatched) await pushSharedDashboard();
}

// ── page-action handlers (dashboard buttons) ──────────────────────
//
// The dashboard is the SHARED Hub page (global/cron runs only). Its row
// actions therefore operate on the GLOBAL store and push the shared tree.

/** Dashboard "Cancel" row action → cancel the (global/cron) run named in
 *  the payload. */
export async function handleCancelAction(event: PageActionEvent): Promise<void> {
  const runId = (event.payload?.runId as string | undefined) ?? "";
  if (runId) await cancelRunById(runId, getGlobalStore(), true);
}

/** Dashboard steer action → steer the (global/cron) run named in the payload. */
export async function handleSteerAction(event: PageActionEvent): Promise<void> {
  const runId = (event.payload?.runId as string | undefined) ?? "";
  const message = (event.payload?.message as string | undefined) ?? "";
  if (runId && message) await steerRunById(runId, message, undefined, getGlobalStore(), true);
}

/** task:assignment_update handler — update the run wherever it lives (user
 *  or global store) and push the shared dashboard if a GLOBAL run changed.
 *  The event carries no user binding, so we update BOTH buckets idempotently;
 *  only the store containing the run mutates. We push the shared tree only
 *  when a global run changed (a user-run update must not touch the shared,
 *  cross-user cached tree). */
export async function handleAssignmentUpdate(
  evt: TaskAssignmentUpdateEvent,
): Promise<void> {
  // User store: update silently (no shared push — privacy). Only write when
  // the run actually lives there, so an unrelated global event doesn't
  // rewrite the user's bucket.
  const userBefore = await getUserStore().read();
  if (runMatches(userBefore, evt)) {
    await getUserStore().write(applyAssignmentUpdate(userBefore, evt));
  }

  // Global store: update + push the shared dashboard.
  const runs = applyAssignmentUpdate(await getGlobalStore().read(), evt);
  await getGlobalStore().write(runs);
  pushPageImpl(PAGE_ID, buildDashboard(runs));
}

// ── Wiring ────────────────────────────────────────────────────────

export const tools: Record<string, ToolHandler> = {
  dispatch_run: dispatchRun,
  list_runs: listRuns,
  steer_run: steerRun,
  cancel_run: cancelRunTool,
  open_pr: openPr,
};

/** Register the page (+ its row/button action handlers), tools, and event
 *  handler (no stdin side effects — tests call this against a stubbed
 *  channel). */
export function register(): void {
  definePage({
    id: PAGE_ID,
    render: renderDashboard,
    actions: {
      [CANCEL_EVENT]: handleCancelAction,
      [STEER_EVENT]: handleSteerAction,
    },
  });
  createToolDispatcher(tools);
  registerEventHandler("task:assignment_update", handleAssignmentUpdate);
  // B4: cron triggers — one handler per declared cron. The host only fires
  // crons the manifest declared; each fire reads triggers.json + dispatches.
  const schedule = new Schedule();
  for (const cron of TRIGGER_CRONS) {
    schedule.on(cron, handleTriggerFire);
  }
}

export function start(): void {
  register();
  getChannel().start();
}

// Production wiring — gated on `import.meta.main` so test imports don't
// open stdin (same pattern as the other examples).
if (import.meta.main) start();
