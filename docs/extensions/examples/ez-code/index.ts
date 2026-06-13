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
  PageBuilder,
  Storage,
  createToolDispatcher,
  definePage,
  getChannel,
  pushPage,
  registerEventHandler,
  toolError,
  toolResult,
  type HubPageTree,
  type PageActionEvent,
  type SubscribableEventMap,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import { spawnAssignment, cancelRun } from "@ezcorp/sdk/runtime";

/** Payload of the `task:assignment_update` event (re-derived from the
 *  exported event map — the concrete type isn't re-exported by name). */
type TaskAssignmentUpdateEvent = SubscribableEventMap["task:assignment_update"];

export const PAGE_ID = "dashboard";
export const RUNS_KEY = "runs";
export const MAX_RUNS = 100;
export const MAX_EVENTS_PER_RUN = 50;
export const CANCEL_EVENT = "ez-code:cancel";
export const STEER_EVENT = "ez-code:steer";

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

// ── Run store (Storage-backed; injectable for tests) ─────────────────

export interface RunStore {
  read(): Promise<RunRecord[]>;
  write(runs: RunRecord[]): Promise<void>;
}

function productionStore(): RunStore {
  const storage = new Storage("global");
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

let store: RunStore | null = null;
function getStore(): RunStore {
  if (!store) store = productionStore();
  return store;
}
/** Test seam: substitute the Storage-backed run store. */
export function _setStoreForTests(s: RunStore | null): void {
  store = s;
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

/** Build the dashboard tree from the run list. Pure. */
export function buildDashboard(runs: RunRecord[]): HubPageTree {
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
      // Live runs get a confirm-gated CANCEL action on the row; terminal
      // runs deep-link to their sub-conversation. (A row carries either an
      // action OR an href, not both.)
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
      return {
        cells,
        ...(r.subConversationId ? { href: `/chat/${r.subConversationId}` as const } : {}),
      };
    }),
  );

  return page.build();
}

// ── Handlers ──────────────────────────────────────────────────────

export async function renderDashboard(): Promise<HubPageTree> {
  return buildDashboard(await getStore().read());
}

/** dispatch_run tool — spawn a sub-agent + persist a run record. */
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

  let handle: Awaited<ReturnType<typeof spawnAssignment>>;
  try {
    handle = await spawnImpl({
      agentName: agentName.trim(),
      task: task.trim(),
      ...(typeof title === "string" && title.trim() ? { title: title.trim() } : {}),
      ...(autonomousContinuation === true
        ? { autonomousContinuation: {} }
        : {}),
    });
  } catch (err) {
    return toolError(`dispatch_run failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const now = new Date().toISOString();
  const record: RunRecord = {
    id: handle.agentRunId,
    taskId: handle.taskId,
    assignmentId: handle.assignmentId,
    subConversationId: handle.subConversationId,
    agentName: agentName.trim(),
    title: typeof title === "string" ? title.trim() : "",
    task: task.trim(),
    status: "dispatched",
    createdAt: now,
    updatedAt: now,
    events: [{ at: now, status: "dispatched" }],
  };
  const runs = appendRun(await getStore().read(), record);
  await getStore().write(runs);
  pushPageImpl(PAGE_ID, buildDashboard(runs));

  return toolResult(
    JSON.stringify({
      runId: record.id,
      subConversationId: record.subConversationId,
      status: record.status,
    }),
  );
};

/** list_runs tool — read the persisted run records (newest first). */
export const listRuns: ToolHandler = async (args) => {
  const { limit } = (args ?? {}) as { limit?: unknown };
  const runs = await getStore().read();
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

/** Shared steer logic: append a steering turn into the run's
 *  sub-conversation, record the steer event, push a fresh tree. Returns the
 *  outcome so both the tool wrapper and tests can assert it. */
export async function steerRunById(
  runId: string,
  message: string,
  parentMessageId?: string,
): Promise<{ ok: boolean; error?: string }> {
  const runs = await getStore().read();
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
  await getStore().write(next);
  pushPageImpl(PAGE_ID, buildDashboard(next));
  return { ok: true };
}

/** steer_run tool — inject a steering message into a run's sub-conversation. */
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
  );
  if (!res.ok) return toolError(`steer_run failed: ${res.error}`);
  return toolResult(JSON.stringify({ runId, steered: true }));
};

// ── cancel_run ────────────────────────────────────────────────────

/** Shared cancel logic: host-side cancel + flip the record to cancelled. */
export async function cancelRunById(
  runId: string,
): Promise<{ ok: boolean; error?: string }> {
  const runs = await getStore().read();
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
  await getStore().write(next);
  pushPageImpl(PAGE_ID, buildDashboard(next));
  return { ok: true };
}

/** cancel_run tool — cancel a live run (host enforces ownership). */
export const cancelRunTool: ToolHandler = async (args) => {
  const { runId } = (args ?? {}) as { runId?: unknown };
  if (typeof runId !== "string" || !runId.trim()) {
    return toolError("'runId' is required and must be a non-empty string");
  }
  const res = await cancelRunById(runId.trim());
  if (!res.ok) return toolError(`cancel_run failed: ${res.error}`);
  return toolResult(JSON.stringify({ runId, cancelled: true }));
};

// ── page-action handlers (dashboard buttons) ──────────────────────

/** Dashboard "Cancel" row action → cancel the run named in the payload. */
export async function handleCancelAction(event: PageActionEvent): Promise<void> {
  const runId = (event.payload?.runId as string | undefined) ?? "";
  if (runId) await cancelRunById(runId);
}

/** Dashboard steer action → append the payload message to the run. */
export async function handleSteerAction(event: PageActionEvent): Promise<void> {
  const runId = (event.payload?.runId as string | undefined) ?? "";
  const message = (event.payload?.message as string | undefined) ?? "";
  if (runId && message) await steerRunById(runId, message);
}

/** task:assignment_update handler — update the run + push a fresh tree. */
export async function handleAssignmentUpdate(
  evt: TaskAssignmentUpdateEvent,
): Promise<void> {
  const runs = applyAssignmentUpdate(await getStore().read(), evt);
  await getStore().write(runs);
  pushPageImpl(PAGE_ID, buildDashboard(runs));
}

// ── Wiring ────────────────────────────────────────────────────────

export const tools: Record<string, ToolHandler> = {
  dispatch_run: dispatchRun,
  list_runs: listRuns,
  steer_run: steerRun,
  cancel_run: cancelRunTool,
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
}

export function start(): void {
  register();
  getChannel().start();
}

// Production wiring — gated on `import.meta.main` so test imports don't
// open stdin (same pattern as the other examples).
if (import.meta.main) start();
