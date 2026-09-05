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
  createLoopRunStore,
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
  type LoopContract,
  type LoopRunState,
  type MemoryRecord,
  type PageActionEvent,
  type ScheduleHandlerContext,
  type StorageScope,
  type SubscribableEventMap,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import { spawnAssignment, cancelRun } from "@ezcorp/sdk/runtime";
// NOTE: this module loads inside the SANDBOXED subprocess (under
// `src/extensions/runtime/sandbox-preload.ts`), which ALWAYS poisons
// `node:fs` / `node:child_process` / Bun.spawn / Bun.file. A static import
// of `node:fs` here throws "Extension sandbox: 'fs module' blocked" at
// module-load time — crashing the FIRST spawn (the dashboard render → every
// tool surfaces "Transport closed"). So open_pr's worktree file manipulation
// is driven entirely by the SHELL via the unjailed host runner (subprocesses
// run OUTSIDE the preload poisoning). `node:path` (join/dirname) and the host
// `mktemp -d`/`rm -rf` shell commands replace all node:fs usage. See the
// sandbox-preload FS_MODULES block + tasks/phase-3-filesystem-hardening.md.
// Seam B (ez-sandbox) — open_pr jails its git/gh subprocess via the host's
// buildSandboxArgv so a run's shell can't read/write `.ezcorp/data` (the
// PGlite DB + JWT secret).
//
// CRITICAL — these host modules statically import `node:fs` /
// `node:child_process` (poisoned in the sandboxed subprocess). A STATIC import
// here pulls them into ez-code's module-load graph, so module load crashes
// with "Extension sandbox: 'fs module' blocked" on the FIRST spawn (the
// dashboard render). So they're loaded LAZILY via dynamic `import()` inside
// `makeProductionShell`'s runner — which only runs when open_pr actually fires
// (a shell subprocess, OUTSIDE the poisoning), never at module load. Types are
// imported type-only (erased at runtime, no eager fs evaluation).

/** Payload of the `task:assignment_update` event (re-derived from the
 *  exported event map — the concrete type isn't re-exported by name). */
type TaskAssignmentUpdateEvent = SubscribableEventMap["task:assignment_update"];

/**
 * Canonical name of the bundled coder agent_config row the host ships
 * with ez-code (see `src/extensions/ez-code-coder-agent.ts`). When
 * `dispatch_run` is called WITHOUT an `agentName`, it defaults to this —
 * so the tool works out of the box on a fresh install.
 *
 * The host's `resolveAgentConfigForUser` treats this name (and the
 * `coder` / `ez-code` aliases) as a reference to the bundled coder and
 * resolves it BY ITS FIXED ID — NOT by owner — so it works for every
 * user even after the boot migration adopts the row into the first admin.
 *
 * Mirrored here as a literal (NOT imported) on purpose: this module loads
 * inside the sandboxed subprocess, and `ez-code-coder-agent.ts`
 * transitively imports the DB layer (poisoned `node:fs`). The string is
 * the contract.
 */
export const DEFAULT_CODER_AGENT = "ez-code coder";

/**
 * Fixed, well-known id of the bundled coder — kept in sync (by hand) with
 * `EZ_CODE_CODER_AGENT_ID` in `src/extensions/ez-code-coder-agent.ts`.
 * Duplicated as a LITERAL (never imported) so this sandboxed module never
 * pulls the host DB layer into its load graph. `resolveDispatchAgentName`
 * passing this id (or the canonical name) both resolve the coder by id
 * host-side; the id is the most robust form (immune to any name drift).
 */
export const DEFAULT_CODER_AGENT_ID = "ec0de000-c0de-4a9e-b0de-c0de1ec0de00";

/** Friendly aliases (case-insensitive) the LLM may pass for the default
 *  coder. All resolve host-side to the bundled coder (by fixed id); we
 *  normalize them here so a bare `"coder"` always hits the bundled agent
 *  even if a user later creates an unrelated row named "coder". */
const CODER_ALIASES: ReadonlySet<string> = new Set(["coder", "ez-code", "ez-code coder"]);

/** Whether `agentName` (omitted/blank or a known alias) means "use the
 *  bundled coder". Pure. */
export function isDefaultCoderRequest(agentName?: string): boolean {
  if (typeof agentName !== "string" || !agentName.trim()) return true;
  return CODER_ALIASES.has(agentName.trim().toLowerCase());
}

/** Resolve the effective agent name for a dispatch: omitted/blank or a
 *  known alias → the canonical bundled coder; anything else passes
 *  through verbatim (an explicit, user-named agent). Pure. */
export function resolveDispatchAgentName(agentName?: string): string {
  return isDefaultCoderRequest(agentName) ? DEFAULT_CODER_AGENT : agentName!.trim();
}

export const PAGE_ID = "dashboard";
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

// ── Run stores (loop-store-backed; injectable for tests) ─────────────
//
// MIGRATION (Loop SDK primitive, §5 upgrade): run records now live in the
// SDK `loop-store` — ONE Storage key per run + an index key, all mutations
// under `withLock` — replacing the previous single `"runs"` blob that
// read-modify-wrote the whole array on every fire (a race under concurrent
// dispatches). The store exposes per-run ops (`create`/`get`/`list`/
// `update`) so callers never round-trip the full array, and the pure
// helpers (appendRun/mapStatus/applyAssignmentUpdate/isLive/recordRunEvent)
// are GONE — that logic now lives in `@ezcorp/sdk/runtime`'s loop-core /
// loop-store.
//
// PRIVACY (cross-user leak fix): user-dispatched runs are PER-USER and MUST
// NOT bleed into the shared Hub page tree (the host caches it per
// (extension,pageId) and serves it to ALL users — render() gets no
// requesting user). So we keep TWO scoped stores:
//   - USER scope ("user" → ctx.userId): runs a user dispatched. Read/written
//     only in the invoking user's tool context. NEVER rendered into the
//     shared tree.
//   - GLOBAL scope ("global", reachable from ownerless cron fires):
//     cron-fired/system runs. The ONLY runs the shared dashboard renders.

const EZ_LOOP_ID = "ez-code";
// NOTE: `EZ_CONTRACT` intentionally omits `idempotencyKey` — every run is
// keyed by the host-generated `agentRunId`, which is already unique per
// dispatch, so there is no duplicate-fire to collapse.
const EZ_CONTRACT: LoopContract = {
  states: ["dispatched", "running", "completed", "failed", "cancelled"],
  terminal: ["completed", "failed", "cancelled"],
  retention: { maxRuns: MAX_RUNS, maxEventsPerRun: MAX_EVENTS_PER_RUN },
};

/** The ez-code-specific run fields stored as the loop run's `outcome`. The
 *  status / events / timestamps live on the LoopRunState itself. */
export interface RunOutcome {
  taskId: string;
  assignmentId: string;
  subConversationId: string;
  agentName: string;
  title: string;
  task: string;
}

/** Whether a run status is still live (steerable / cancellable). Replaces
 *  the old exported `isLive` pure helper; the vocabulary is the same. */
export function isLive(status: RunStatus): boolean {
  return status === "dispatched" || status === "running";
}

/** Map a host assignment status onto a RunStatus. Replaces the old exported
 *  `mapStatus` helper (unchanged behavior). */
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

/** Per-run store ops ez-code's handlers need, backed by loop-store. */
export interface RunStore {
  /** All runs, newest first. */
  list(): Promise<RunRecord[]>;
  /** One run by id, or null. */
  get(id: string): Promise<RunRecord | null>;
  /** Create a new (dispatched) run. */
  create(run: RunRecord): Promise<void>;
  /** Apply a status + event-log update to an existing run. No-op if absent.
   *  `status` omitted keeps the current status; `note` adds an event. */
  update(
    id: string,
    next: { status?: RunStatus; eventStatus: string; note?: string },
  ): Promise<void>;
}

/** Map a stored LoopRunState back to the surfaced RunRecord shape. */
export function toRunRecord(run: LoopRunState<RunOutcome>): RunRecord {
  const o = run.outcome;
  return {
    id: run.id,
    taskId: o?.taskId ?? "",
    assignmentId: o?.assignmentId ?? "",
    subConversationId: o?.subConversationId ?? "",
    agentName: o?.agentName ?? "",
    title: o?.title ?? "",
    task: o?.task ?? "",
    status: run.status as RunStatus,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    events: run.events.map((e) => ({
      at: e.at,
      status: e.status,
      ...(e.note ? { note: e.note } : {}),
    })),
  };
}

/** A RunStore backed by the SDK loop-store for the given scope. */
function loopBackedRunStore(scope: StorageScope): RunStore {
  const store = createLoopRunStore<RunOutcome>(EZ_LOOP_ID, {
    ...EZ_CONTRACT,
    scope,
  });
  return {
    async list() {
      return (await store.list()).map(toRunRecord);
    },
    async get(id) {
      const run = await store.get(id);
      return run ? toRunRecord(run) : null;
    },
    async create(run) {
      await store.claim({
        id: run.id,
        loopId: EZ_LOOP_ID,
        status: run.status,
        outcome: {
          taskId: run.taskId,
          assignmentId: run.assignmentId,
          subConversationId: run.subConversationId,
          agentName: run.agentName,
          title: run.title,
          task: run.task,
        },
      });
    },
    async update(id, next) {
      // No unlocked pre-read: `transition` resolves an OMITTED status to the
      // run's CURRENT status UNDER its lock (TOCTOU fix). So a "steered" /
      // "pr_opened" event-only update (status undefined) can't race-revert a
      // concurrent status flip; a missing run is a no-op inside transition.
      await store.transition(id, {
        ...(next.status ? { status: next.status } : {}),
        eventStatus: next.eventStatus,
        ...(next.note ? { note: next.note } : {}),
      });
    },
  };
}

let userStore: RunStore | null = null;
let globalStore: RunStore | null = null;
function getUserStore(): RunStore {
  if (!userStore) userStore = loopBackedRunStore("user");
  return userStore;
}
function getGlobalStore(): RunStore {
  if (!globalStore) globalStore = loopBackedRunStore("global");
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
//
// The old appendRun / applyAssignmentUpdate / runMatches / recordRunEvent
// helpers are GONE — that run-list state machine now lives in the SDK
// loop-core / loop-store (per-run keys under withLock). `mapStatus` and
// `isLive` (small, ez-code-specific status mapping) stay, defined up with
// the store. `findRunMatch` below replaces `runMatches`/the inline match in
// the deferred-completion handler.

/** Find the run id (in `runs`) that a task:assignment_update targets, by
 *  agentRunId / assignmentId / taskId. Returns null when none match. */
export function findRunMatch(
  runs: RunRecord[],
  evt: TaskAssignmentUpdateEvent,
): RunRecord | null {
  const a = evt.assignment;
  return (
    runs.find(
      (r) =>
        (!!a.agentRunId && r.id === a.agentRunId) ||
        r.assignmentId === a.id ||
        r.taskId === evt.taskId,
    ) ?? null
  );
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
  const runs = await getGlobalStore().list();
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
    /** When set, spawn resolves the agent by this EXACT id (takes
     *  precedence over `agentName` host-side). Used for the bundled coder
     *  so it resolves by its fixed, unforgeable id regardless of owner.
     *  `agentName` is still kept for the run record's display. */
    agentConfigId?: string;
    task: string;
    title?: string;
    autonomousContinuation?: boolean;
  },
  store: RunStore,
  push: boolean,
): Promise<RunRecord> {
  const handle = await spawnImpl({
    ...(input.agentConfigId
      ? { agentConfigId: input.agentConfigId }
      : { agentName: input.agentName }),
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
  // Persist via the loop-store-backed per-run create (claim) — newest-first
  // index + retention cap are owned by loop-store, not a hand-rolled blob.
  await store.create(record);
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
  // `agentName` is OPTIONAL — omitted (or a `"coder"` alias) defaults to
  // the bundled ez-code coder, so the tool works out of the box. A
  // non-string non-undefined value is still a contract error.
  if (agentName !== undefined && typeof agentName !== "string") {
    return toolError("'agentName' must be a string when provided");
  }
  if (typeof task !== "string" || task.trim().length === 0) {
    return toolError("'task' is required and must be a non-empty string");
  }
  const requestedAgent = typeof agentName === "string" ? agentName : undefined;
  const resolvedAgent = resolveDispatchAgentName(requestedAgent);
  // For the bundled coder, dispatch by its FIXED id (unforgeable, owner-
  // agnostic) rather than the name — most robust resolution. The run
  // record still shows the friendly `agentName`. An explicit user agent
  // dispatches by name as before.
  const useDefaultCoder = isDefaultCoderRequest(requestedAgent);

  let record: RunRecord;
  try {
    record = await dispatchRunCore(
      {
        agentName: resolvedAgent,
        ...(useDefaultCoder ? { agentConfigId: DEFAULT_CODER_AGENT_ID } : {}),
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
  const runs = await getUserStore().list();
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
  const run = await store.get(runId);
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
  // Record a "steered" EVENT without changing the run's status (stays live).
  await store.update(runId, {
    eventStatus: "steered",
    note: message.slice(0, 120),
  });
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
  const run = await store.get(runId);
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
  // Flip the run to cancelled + record the event.
  await store.update(runId, { status: "cancelled", eventStatus: "cancelled" });
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

export async function openPrForRun(
  runId: string,
  opts: { title?: string; body?: string } = {},
  store: RunStore = getUserStore(),
  push = false,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const run = await store.get(runId);
  if (!run) return { ok: false, error: `no run with id '${runId}'` };
  const result = await getChannel().request<{ ok: boolean; url?: string; error?: string }>("ezcorp/project.openPr", {
    runId,
    title: (opts.title ?? run.title ?? `ez-code run ${runId}`).trim() || `ez-code run ${runId}`,
    body: opts.body ?? `Automated PR for ez-code run \`${runId}\` (agent: ${run.agentName}).`,
  });
  if (result.ok) {
    await store.update(runId, { eventStatus: "pr_opened", note: result.url ?? "" });
    if (push) await pushSharedDashboard();
  }
  return result;
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
  const a = evt.assignment;
  const next = {
    status: mapStatus(a.status),
    eventStatus: a.status,
    ...(a.resultPreview ? { note: a.resultPreview } : {}),
  };

  // User store: update SILENTLY (no shared push — privacy). Only the run
  // that actually lives there mutates; an unrelated global event is a no-op.
  const userMatch = findRunMatch(await getUserStore().list(), evt);
  if (userMatch) {
    await getUserStore().update(userMatch.id, next);
  }

  // Global store: update the matching (cron/system) run + push the SHARED
  // dashboard. The push renders the global store ONLY (never user runs).
  const globalMatch = findRunMatch(await getGlobalStore().list(), evt);
  if (globalMatch) {
    await getGlobalStore().update(globalMatch.id, next);
  }
  pushPageImpl(PAGE_ID, buildDashboard(await getGlobalStore().list()));
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
  //
  // DELIBERATE: the cron stays on `Schedule.on` rather than a `defineLoop`
  // cron trigger. `defineLoop`'s `act` is single-fire → single-run, but
  // `handleTriggerFire` reads triggers.json and BATCH-dispatches N runs per
  // fire (1 fire → N dispatches). Wrapping that in defineLoop would need a
  // fan-out shim that adds no DRY, so the batch cron is kept bespoke; the
  // runs it dispatches still persist via the loop-store substrate.
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
