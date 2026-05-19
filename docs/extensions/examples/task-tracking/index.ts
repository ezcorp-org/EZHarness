#!/usr/bin/env bun
// task-tracking — multi-task planning + sub-agent coordination extension.
//
// Converted from the built-in tool formerly at
// src/runtime/tools/task-tracking.ts during Phase 3. Storage is
// conversation-scoped and written via the SDK's `Storage("conversation")`
// helper on every mutation — no process-local cache layered on top. The
// host forces `_meta.conversationId` through every reverse RPC so the
// extension never has to plumb the conversation id itself.
//
// Permission contract: requires `storage: true`, `taskEvents: true`,
// `agentConfig: "read"`, `spawnAgents: { maxPerHour, maxConcurrent }`,
// and `eventSubscriptions: ["task:assignment_update"]`. The host's
// capability tier (src/extensions/*-handler.ts) rejects all calls if
// any grant is missing; the extension itself performs no access checks.
//
// Commit 1 ships the 5 read/simple tools + shared scaffolding. Commit 2
// adds the remaining mutation tools; commit 3 wires the spawn path on
// `assignTo`; commit 4 adds the task:assignment_update subscription that
// bridges sub-run completions into this extension's state.

import {
  createToolDispatcher,
  getChannel,
  Storage,
  TaskEvents,
  AgentConfigs,
  JsonRpcError,
  registerEventHandler,
  spawnAssignment,
  cancelRun,
  toolError,
  toolResult,
  type SpawnAssignmentInput,
  type SpawnAssignmentHandle,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";
import {
  detectCycle,
  isBlocked,
  unsatisfiedDeps,
  type ReadonlyTask,
  type ReadonlySnapshot,
} from "../../../../src/runtime/task-dependencies";

// ── Types (mirrored from the legacy built-in) ───────────────────────

export type TaskStatus = "pending" | "active" | "completed" | "failed";
export type AssignmentStatus = "assigned" | "running" | "completed" | "failed";

export interface TaskAssignment {
  id: string;
  agentConfigId: string;
  agentName: string;
  isTeam: boolean;
  status: AssignmentStatus;
  assignedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  subConversationId?: string;
  agentRunId?: string;
  resultPreview?: string;
  /** Current autonomous self-continuation cycle (1-based). Present only
   *  while an opted-in assignment is looping; surfaced on the task card
   *  as "autonomous n/m" so the loop is observable and stoppable. */
  autonomousCycle?: number;
  /** The cycle cap for this assignment's autonomous continuation. */
  autonomousMaxCycles?: number;
}

export interface TrackedSubtask {
  id: string;
  title: string;
  completed: boolean;
  position: number;
  assignments?: TaskAssignment[];
}

export interface TrackedTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  agentId?: string;
  agentName?: string;
  assignments: TaskAssignment[];
  subtasks: TrackedSubtask[];
  priority: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  failureReason?: string;
  completionSummary?: string;
  dependsOn?: string[];
}

export interface PersistedSnapshot {
  tasks: TrackedTask[];
  activeTaskId?: string;
  schemaVersion: 1;
}

// ── Storage + capability bindings (swappable for tests) ─────────────

interface StorageLike {
  get<T>(key: string): Promise<{ value: T | null; exists: boolean }>;
  set<T>(key: string, value: T, opts?: { ttlSeconds?: number }): Promise<unknown>;
}

interface TaskEventsLike {
  emitSnapshot(tasks: TrackedTask[], activeTaskId?: string): Promise<void>;
  emitAssignmentUpdate(taskId: string, assignment: TaskAssignment): Promise<void>;
}

interface AgentConfigsLike {
  list(): Promise<Array<{ id: string; name: string; description: string; isTeam: boolean; ownerUserId: string | null }>>;
  resolve(
    idOrName: string,
  ): Promise<{ id: string; name: string; description: string; isTeam: boolean; ownerUserId: string | null } | null>;
}

type SpawnFn = (input: SpawnAssignmentInput) => Promise<SpawnAssignmentHandle>;

let storage: StorageLike = new Storage("conversation");
let taskEvents: TaskEventsLike = new TaskEvents();
let agentConfigs: AgentConfigsLike = new AgentConfigs();
let spawn: SpawnFn = spawnAssignment;
type CancelFn = typeof cancelRun;
let cancel: CancelFn = cancelRun;

/** Test-only: inject a fake storage backend. */
export function _setStoreForTests(fake: StorageLike): void {
  storage = fake;
}
/** Test-only: inject a fake TaskEvents emitter. */
export function _setTaskEventsForTests(fake: TaskEventsLike): void {
  taskEvents = fake;
}
/** Test-only: inject a fake AgentConfigs resolver. */
export function _setAgentConfigsForTests(fake: AgentConfigsLike): void {
  agentConfigs = fake;
}
/** Test-only: inject a fake cancelRun. */
export function _setCancelForTests(fake: CancelFn): void { cancel = fake; }

/** Test-only: inject a fake spawnAssignment. */
export function _setSpawnForTests(fake: SpawnFn): void {
  spawn = fake;
}
/** Test-only: restore real SDK bindings. */
export function _resetBindingsForTests(): void {
  storage = new Storage("conversation");
  taskEvents = new TaskEvents();
  agentConfigs = new AgentConfigs();
  spawn = spawnAssignment;
  cancel = cancelRun;
}

// Storage key for the persisted snapshot. Pre-Phase-3 the built-in
// used "__tasks" under the synthetic extensionId "builtin" (reserved-
// prefix exemption). The bundled extension doesn't get that exemption
// — storage-handler.ts rejects `__`-prefixed keys for non-builtin
// extensions — so we use the un-prefixed "tasks". Migration maps the
// old key to this one.
const STORAGE_KEY = "tasks";

function emptySnapshot(): PersistedSnapshot {
  return { tasks: [], schemaVersion: 1 };
}

async function loadSnapshot(): Promise<PersistedSnapshot> {
  const row = await storage.get<PersistedSnapshot | { tasks: TrackedTask[]; activeTaskId?: string }>(STORAGE_KEY);
  if (!row.exists || !row.value) return emptySnapshot();
  const v = row.value as PersistedSnapshot & { tasks?: TrackedTask[]; activeTaskId?: string };
  const result: PersistedSnapshot = {
    tasks: Array.isArray(v.tasks) ? v.tasks : [],
    schemaVersion: 1,
  };
  if (v.activeTaskId !== undefined) result.activeTaskId = v.activeTaskId;
  return result;
}

async function saveSnapshot(snap: PersistedSnapshot): Promise<void> {
  await storage.set<PersistedSnapshot>(STORAGE_KEY, {
    tasks: snap.tasks,
    ...(snap.activeTaskId !== undefined ? { activeTaskId: snap.activeTaskId } : {}),
    schemaVersion: 1,
  });
}

async function emitState(snap: PersistedSnapshot): Promise<void> {
  await taskEvents.emitSnapshot(snap.tasks, snap.activeTaskId);
}

function genId(): string {
  return crypto.randomUUID();
}

function toReadonly(snap: PersistedSnapshot): ReadonlySnapshot {
  return { tasks: snap.tasks as ReadonlyTask[] };
}

function getNextPendingTask(snap: PersistedSnapshot): TrackedTask | undefined {
  return [...snap.tasks]
    .sort((a, b) => a.priority - b.priority)
    .find((t) => t.status === "pending" && !isBlocked(t, toReadonly(snap)));
}

// ── Spawn wrapper + error ladder (§3.1) ─────────────────────────────
//
// Every call to `spawn()` can reject with a JsonRpcError whose .code +
// .data are preserved end-to-end since SDK commit e65c01f. The ladder
// below mirrors the plan's §3.1 decision table:
//
//   -32000 quota/depth          → transient; do NOT mutate task state.
//   -32001 permission/not-wired → logical (defensive). toolError only.
//   -32029 burst rate-limit     → transient; toolError, let LLM retry.
//   -32602 invalid params       → terminal. Mark assignment `failed`.
//   -32603 dispatch failure     → terminal. Mark assignment `failed`.
//
// For the two terminal branches the caller is responsible for persisting
// the failure + emitting `task:assignment_update` so the UI reflects
// the dead assignment. For the transient branches the assignment stays
// in `assigned` and the caller reports back to the LLM.

type AttemptSpawnOutcome =
  | { status: "started"; handle: SpawnAssignmentHandle }
  | { status: "quota-exceeded"; reason: string; message: string }
  | { status: "permission-missing"; message: string }
  | { status: "rate-limited"; message: string }
  | { status: "invalid"; message: string; terminal: true }
  | { status: "dispatch-failed"; message: string; terminal: true }
  | { status: "unknown-error"; message: string; terminal: true };

async function attemptSpawn(
  input: SpawnAssignmentInput,
): Promise<AttemptSpawnOutcome> {
  try {
    const handle = await spawn(input);
    return { status: "started", handle };
  } catch (err) {
    if (err instanceof JsonRpcError) {
      const msg = err.message || "spawn failed";
      switch (err.code) {
        case -32000: {
          const reason = typeof (err.data as { reason?: unknown })?.reason === "string"
            ? (err.data as { reason: string }).reason
            : "quota-exceeded";
          return { status: "quota-exceeded", reason, message: msg };
        }
        case -32001:
          return { status: "permission-missing", message: msg };
        case -32029:
          return { status: "rate-limited", message: msg };
        case -32602:
          return { status: "invalid", message: msg, terminal: true };
        case -32603:
          return { status: "dispatch-failed", message: msg, terminal: true };
        default:
          return { status: "unknown-error", message: msg, terminal: true };
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "unknown-error", message: msg, terminal: true };
  }
}

/**
 * Walk every running assignment on a task (including subtask-scoped
 * ones), ask the host to cancel the run, and transition the assignment
 * to a terminal state so it can't stay stuck as "running" after its
 * owning task has been completed or failed.
 *
 * Idempotent against the `run:cancel` listener in start-assignment.ts
 * — we mutate `status` to the terminal state BEFORE calling cancel, so
 * when run:cancel eventually fires the listener's `status !== "running"`
 * guard short-circuits and doesn't overwrite our transition.
 *
 * Cancel failures (ownership -32001, already-cancelled, etc.) are
 * intentionally swallowed: the parent task's terminal transition is
 * the user's explicit intent; a stuck cancel RPC must not block it.
 */
async function terminateRunningAssignments(
  task: TrackedTask,
  terminalStatus: "completed" | "failed",
  note: string,
): Promise<void> {
  const now = new Date().toISOString();
  const timestampField = terminalStatus === "completed" ? "completedAt" : "failedAt";
  const targets: TaskAssignment[] = [];
  for (const a of task.assignments) {
    if (a.status === "running" || a.status === "assigned") targets.push(a);
  }
  for (const sub of task.subtasks) {
    for (const a of sub.assignments ?? []) {
      if (a.status === "running" || a.status === "assigned") targets.push(a);
    }
  }
  for (const a of targets) {
    a.status = terminalStatus;
    (a as unknown as Record<string, string>)[timestampField] = now;
    a.resultPreview = note;
    if (a.agentRunId) {
      try {
        await cancel(a.agentRunId);
      } catch {
        // Ownership mismatch / already-cancelled — parent's terminal
        // transition is the source of truth; keep going.
      }
    }
  }
}

/**
 * Persist an assignment failure transition and emit the update.
 * Caller must have already mutated the in-memory assignment object to
 * reflect the failure — this function only saves + emits.
 */
async function recordAssignmentFailure(
  snap: PersistedSnapshot,
  taskId: string,
  assignment: TaskAssignment,
  errorMessage: string,
): Promise<void> {
  assignment.status = "failed";
  assignment.failedAt = new Date().toISOString();
  assignment.resultPreview = errorMessage;
  // Promote the owning task to failed so the UI surfaces the block.
  const task = snap.tasks.find((t) => t.id === taskId);
  if (task && task.status !== "completed" && task.status !== "failed") {
    task.status = "failed";
    task.failedAt = new Date().toISOString();
    task.failureReason = errorMessage;
    if (snap.activeTaskId === task.id) snap.activeTaskId = undefined;
  }
  await saveSnapshot(snap);
  await emitState(snap);
  await taskEvents.emitAssignmentUpdate(taskId, assignment);
}

/** Short human-readable sentence describing a spawn outcome for the LLM. */
function describeSpawnOutcome(
  agentName: string,
  isTeam: boolean,
  wantedAutoStart: boolean,
  outcome: AttemptSpawnOutcome | "skipped-blocked" | "skipped-terminal" | "not-requested",
  waitingOn?: string[],
): string {
  const who = `@${agentName}${isTeam ? " (team)" : ""}`;
  if (!wantedAutoStart || outcome === "not-requested") {
    return `Assigned ${who} in 'assigned' status — manual start required.`;
  }
  if (outcome === "skipped-terminal") {
    return `Assigned ${who}. Auto-start skipped because the task is already completed or failed — manual start required.`;
  }
  if (outcome === "skipped-blocked") {
    const waiting = waitingOn ?? [];
    const list = waiting.length > 0
      ? waiting.map((n) => `"${n}"`).join(", ")
      : "prerequisite tasks";
    return `Assigned ${who}. Auto-start deferred — waiting for ${list} to complete. Will auto-run when prerequisites finish.`;
  }
  switch (outcome.status) {
    case "started":
      return `Auto-started ${who} — it is running now.`;
    case "quota-exceeded":
      return `Assigned ${who}. Auto-start skipped (quota: ${outcome.reason}) — assignment left in 'assigned' status for manual start.`;
    case "rate-limited":
      return `Assigned ${who}. Auto-start temporarily rate-limited — assignment left in 'assigned' status for manual start.`;
    case "permission-missing":
      return `Assigned ${who}. Auto-start failed (permission denied) — assignment left in 'assigned' status for manual start.`;
    case "invalid":
      return `Assigned ${who}. Auto-start failed (${outcome.message}) — marked assignment as failed.`;
    case "dispatch-failed":
      return `Assigned ${who}. Auto-start failed (${outcome.message}) — marked assignment as failed.`;
    case "unknown-error":
      return `Assigned ${who}. Auto-start failed (${outcome.message}) — marked assignment as failed.`;
  }
}

/**
 * Kick off a spawn for an `assigned` assignment and fold the outcome
 * back into the snapshot. Called from task_plan / task_add / task_assign
 * and (in commit-4) from the unblock-dependents sweep in the
 * task:assignment_update subscription.
 *
 * Assumes the caller has already persisted the base snapshot WITH the
 * assignment object in `assigned` status; this function may further
 * mutate assignment fields and re-persist on failure.
 */
async function runSpawnForAssignment(
  snap: PersistedSnapshot,
  task: TrackedTask,
  assignment: TaskAssignment,
): Promise<AttemptSpawnOutcome> {
  const outcome = await attemptSpawn({
    task: task.description || task.title,
    agentConfigId: assignment.agentConfigId,
    title: task.title,
    taskId: task.id,
    assignmentId: assignment.id,
  });
  if (outcome.status === "started") {
    assignment.status = "running";
    assignment.startedAt = new Date().toISOString();
    assignment.subConversationId = outcome.handle.subConversationId;
    assignment.agentRunId = outcome.handle.agentRunId;
    await saveSnapshot(snap);
    await emitState(snap);
    await taskEvents.emitAssignmentUpdate(task.id, assignment);
    return outcome;
  }
  if (outcome.status === "invalid" || outcome.status === "dispatch-failed" || outcome.status === "unknown-error") {
    await recordAssignmentFailure(snap, task.id, assignment, outcome.message);
    return outcome;
  }
  // Transient — quota/permission/rate. Leave assignment as `assigned`.
  return outcome;
}

function notFoundError(snap: PersistedSnapshot, badId: string): string {
  if (snap.tasks.length === 0) {
    return `Task "${badId}" not found. There are no tasks tracked yet — call task_plan to create some first.`;
  }
  const list = snap.tasks
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .map((t) => `- taskId: "${t.id}" [${t.status}] ${t.title}`)
    .join("\n");
  return `Task "${badId}" not found. Current tasks:\n${list}\n\nRe-issue the call with one of the taskIds above (the string in quotes).`;
}

// ── Tool handlers (commit-1 scope: the 5 simple ones) ──────────────

const planHandler: ToolHandler = async (args) => {
  const { tasks, replace } = args as {
    tasks?: Array<{
      title: string;
      description?: string;
      subtasks?: string[];
      assignTo?: string;
      autoStart?: boolean;
      dependsOn?: string[];
    }>;
    replace?: boolean;
  };
  if (!Array.isArray(tasks)) {
    return toolError("task_plan requires a 'tasks' array");
  }

  const snap = await loadSnapshot();
  // Default: append mode. Preserves all existing tasks (including
  // pending ones). `replace: true` opts into the destructive "wipe
  // pending, keep in-flight/done" behavior for explicit replan.
  // Rationale: the old destructive default silently dropped pending
  // work when the LLM misinterpreted assign requests as replans
  // (see retrospective for the 6→1-task vanishing incident).
  const kept = replace === true
    ? snap.tasks.filter((t) => t.status !== "pending")
    : [...snap.tasks];
  const now = new Date().toISOString();
  const basePriority = kept.length;
  const newTasks: TrackedTask[] = tasks.map((t, idx) => ({
    id: genId(),
    title: t.title,
    description: t.description ?? "",
    status: "pending" as const,
    assignments: [],
    subtasks: (t.subtasks ?? []).map((st, stIdx) => ({
      id: genId(),
      title: st,
      completed: false,
      position: stIdx,
    })),
    priority: basePriority + idx,
    createdAt: now,
  }));

  // Resolve dependsOn entries: id OR title-within-this-plan. Unresolvable
  // entries become warnings, not failures.
  const titleToNewId = new Map<string, string>();
  for (let i = 0; i < tasks.length; i++) {
    titleToNewId.set(tasks[i]!.title.trim().toLowerCase(), newTasks[i]!.id);
  }
  const knownIds = new Set<string>([
    ...kept.map((t) => t.id),
    ...newTasks.map((t) => t.id),
  ]);
  const depWarnings: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const inputDeps = tasks[i]!.dependsOn ?? [];
    if (inputDeps.length === 0) continue;
    const resolved: string[] = [];
    for (const ref of inputDeps) {
      if (knownIds.has(ref)) {
        if (ref === newTasks[i]!.id) {
          depWarnings.push(`Task "${tasks[i]!.title}" cannot depend on itself — skipped.`);
          continue;
        }
        resolved.push(ref);
        continue;
      }
      const byTitle = titleToNewId.get(ref.trim().toLowerCase());
      if (byTitle) {
        if (byTitle === newTasks[i]!.id) {
          depWarnings.push(`Task "${tasks[i]!.title}" cannot depend on itself — skipped.`);
          continue;
        }
        resolved.push(byTitle);
        continue;
      }
      depWarnings.push(
        `Task "${tasks[i]!.title}": dependency "${ref}" is neither a known taskId nor a title from this plan — skipped.`,
      );
    }
    if (resolved.length > 0) newTasks[i]!.dependsOn = resolved;
  }

  const proposedAll = [...kept, ...newTasks];
  const cycle = detectCycle(proposedAll as ReadonlyTask[]);
  if (cycle) {
    return toolError(
      `Rejected: task_plan would introduce a dependency cycle: ${cycle.join(" → ")}. No tasks were created. Adjust the \`dependsOn\` lists so the graph is acyclic and try again.`,
    );
  }

  // Resolve assignTo entries against AgentConfigs. Unresolvable ones
  // are warnings — the task still lands, just without the assignment.
  interface ResolvedAssignment {
    idx: number;
    assignment: TaskAssignment;
    isTeam: boolean;
    agentName: string;
    wantedAutoStart: boolean;
  }
  const resolvedAssignments: ResolvedAssignment[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const assignTo = tasks[i]!.assignTo;
    if (!assignTo) continue;
    const config = await agentConfigs.resolve(assignTo);
    if (!config) {
      depWarnings.push(
        `Task "${tasks[i]!.title}": agent "${assignTo}" not found — no assignment created.`,
      );
      continue;
    }
    const assignment: TaskAssignment = {
      id: genId(),
      agentConfigId: config.id,
      agentName: config.name,
      isTeam: config.isTeam,
      status: "assigned",
      assignedAt: now,
    };
    newTasks[i]!.assignments.push(assignment);
    resolvedAssignments.push({
      idx: i,
      assignment,
      isTeam: config.isTeam,
      agentName: config.name,
      wantedAutoStart: tasks[i]!.autoStart !== false,
    });
  }

  snap.tasks = [...kept, ...newTasks];

  let autoStarted: TrackedTask | undefined;
  if (!snap.activeTaskId) {
    const firstUnblocked = newTasks.find((t) => !isBlocked(t, toReadonly(snap)));
    if (firstUnblocked) {
      firstUnblocked.status = "active";
      firstUnblocked.startedAt = new Date().toISOString();
      snap.activeTaskId = firstUnblocked.id;
      autoStarted = firstUnblocked;
    }
  }

  await saveSnapshot(snap);
  await emitState(snap);

  // Spawn every `assigned` resolved assignment whose task is unblocked.
  // Blocked tasks get a deferred note — commit-4's task:assignment_update
  // subscription sweeps them when prereqs complete.
  const spawnMessages: string[] = [];
  for (const r of resolvedAssignments) {
    const task = newTasks[r.idx]!;
    if (task.status === "completed" || task.status === "failed") {
      spawnMessages.push(
        `  • task "${task.title}" → ${describeSpawnOutcome(r.agentName, r.isTeam, r.wantedAutoStart, "skipped-terminal")}`,
      );
      continue;
    }
    if (!r.wantedAutoStart) {
      spawnMessages.push(
        `  • task "${task.title}" → ${describeSpawnOutcome(r.agentName, r.isTeam, false, "not-requested")}`,
      );
      continue;
    }
    if (isBlocked(task, toReadonly(snap))) {
      const waitingOn = unsatisfiedDeps(task, toReadonly(snap)).map((t) => t.title);
      spawnMessages.push(
        `  • task "${task.title}" → ${describeSpawnOutcome(r.agentName, r.isTeam, true, "skipped-blocked", waitingOn)}`,
      );
      continue;
    }
    const outcome = await runSpawnForAssignment(snap, task, r.assignment);
    spawnMessages.push(
      `  • task "${task.title}" → ${describeSpawnOutcome(r.agentName, r.isTeam, true, outcome)}`,
    );
  }

  const lines = newTasks
    .map((t) => {
      const marker = t.id === snap.activeTaskId ? "[ACTIVE]" : "[pending]";
      return `- taskId: "${t.id}" ${marker} ${t.title}`;
    })
    .join("\n");
  const nextHint = autoStarted
    ? `The first task is now ACTIVE: "${autoStarted.title}". Begin working on it now. When done, call task_complete with taskId "${autoStarted.id}" — it will auto-advance to the next task.`
    : `A task is already active. Call task_list to see current state, or task_complete on the active task to advance.`;

  const depSummary = newTasks.some((t) => t.dependsOn && t.dependsOn.length > 0)
    ? `\n\nDependencies:\n${newTasks
        .filter((t) => t.dependsOn && t.dependsOn.length > 0)
        .map((t) => {
          const depTitles = (t.dependsOn ?? []).map(
            (id) => proposedAll.find((x) => x.id === id)?.title ?? id,
          );
          return `  • "${t.title}" depends on: ${depTitles.map((d) => `"${d}"`).join(", ")}`;
        })
        .join("\n")}`
    : "";

  const warningSummary = depWarnings.length > 0
    ? `\n\nDependency warnings:\n${depWarnings.map((w) => `  • ${w}`).join("\n")}`
    : "";

  const assignmentSummary = spawnMessages.length > 0
    ? `\n\nAssignments:\n${spawnMessages.join("\n")}`
    : "";

  return toolResult(
    `Created task plan with ${newTasks.length} tasks:\n\n${lines}${depSummary}${warningSummary}${assignmentSummary}\n\n${nextHint}`,
  );
};

const addHandler: ToolHandler = async (args) => {
  const { title, description, subtasks, afterTaskId, dependsOn, assignTo, autoStart } = args as {
    title?: string;
    description?: string;
    subtasks?: string[];
    afterTaskId?: string;
    dependsOn?: string[];
    assignTo?: string;
    autoStart?: boolean;
  };
  if (typeof title !== "string" || !title.trim()) {
    return toolError("task_add requires a non-empty 'title' string");
  }

  const snap = await loadSnapshot();
  const now = new Date().toISOString();

  let insertIdx = snap.tasks.length;
  if (afterTaskId) {
    const refIdx = snap.tasks.findIndex((t) => t.id === afterTaskId);
    if (refIdx >= 0) insertIdx = refIdx + 1;
  }

  const depWarnings: string[] = [];
  const resolvedDeps: string[] = [];
  const knownIds = new Set(snap.tasks.map((t) => t.id));
  for (const ref of dependsOn ?? []) {
    if (knownIds.has(ref)) {
      resolvedDeps.push(ref);
    } else {
      depWarnings.push(`dependency "${ref}" is not a known taskId — skipped.`);
    }
  }

  const newTask: TrackedTask = {
    id: genId(),
    title,
    description: description ?? "",
    status: "pending",
    assignments: [],
    subtasks: (subtasks ?? []).map((st, idx) => ({
      id: genId(),
      title: st,
      completed: false,
      position: idx,
    })),
    priority: insertIdx,
    createdAt: now,
    ...(resolvedDeps.length > 0 ? { dependsOn: resolvedDeps } : {}),
  };

  const proposedAll = [...snap.tasks, newTask];
  const cycle = detectCycle(proposedAll as ReadonlyTask[]);
  if (cycle) {
    return toolError(
      `Rejected: task_add would introduce a dependency cycle: ${cycle.join(" → ")}. Task not created.`,
    );
  }

  // Resolve assignTo (best-effort, non-fatal on miss).
  let createdAssignment: TaskAssignment | undefined;
  let resolvedAgent: { id: string; name: string; isTeam: boolean } | undefined;
  if (assignTo) {
    const config = await agentConfigs.resolve(assignTo);
    if (config) {
      resolvedAgent = { id: config.id, name: config.name, isTeam: config.isTeam };
      createdAssignment = {
        id: genId(),
        agentConfigId: config.id,
        agentName: config.name,
        isTeam: config.isTeam,
        status: "assigned",
        assignedAt: now,
      };
      newTask.assignments.push(createdAssignment);
    } else {
      depWarnings.push(`agent "${assignTo}" not found — no assignment created.`);
    }
  }

  snap.tasks.splice(insertIdx, 0, newTask);
  for (let i = 0; i < snap.tasks.length; i++) {
    snap.tasks[i]!.priority = i;
  }

  await saveSnapshot(snap);
  await emitState(snap);

  // Spawn if we have an assignment + auto-start was requested.
  let spawnMsg = "";
  if (createdAssignment && resolvedAgent) {
    const wantedAutoStart = autoStart !== false;
    if (!wantedAutoStart) {
      spawnMsg = `\n${describeSpawnOutcome(resolvedAgent.name, resolvedAgent.isTeam, false, "not-requested")}`;
    } else if (isBlocked(newTask, toReadonly(snap))) {
      const waiting = unsatisfiedDeps(newTask, toReadonly(snap)).map((t) => t.title);
      spawnMsg = `\n${describeSpawnOutcome(resolvedAgent.name, resolvedAgent.isTeam, true, "skipped-blocked", waiting)}`;
    } else {
      const outcome = await runSpawnForAssignment(snap, newTask, createdAssignment);
      spawnMsg = `\n${describeSpawnOutcome(resolvedAgent.name, resolvedAgent.isTeam, true, outcome)}`;
    }
  }

  const depSummary = resolvedDeps.length > 0
    ? `\nDepends on: ${resolvedDeps
        .map((id) => `"${snap.tasks.find((t) => t.id === id)?.title ?? id}"`)
        .join(", ")}.`
    : "";
  const warningSummary = depWarnings.length > 0
    ? `\nDependency warnings: ${depWarnings.join("; ")}`
    : "";

  return toolResult(
    `Added task: "${title}" (taskId: "${newTask.id}") at position ${insertIdx + 1} of ${snap.tasks.length}.${depSummary}${warningSummary}${spawnMsg}`,
  );
};

const listHandler: ToolHandler = async () => {
  const snap = await loadSnapshot();
  const sorted = [...snap.tasks].sort((a, b) => a.priority - b.priority);
  if (sorted.length === 0) {
    return toolResult("No tasks tracked for this conversation.");
  }
  const lines = sorted.map((t) => {
    const statusTag = `[${t.status.toUpperCase()}]`;
    const agent = t.agentName ? ` @${t.agentName}` : "";
    const subtaskSummary = t.subtasks.length > 0
      ? ` (${t.subtasks.filter((s) => s.completed).length}/${t.subtasks.length} subtasks)`
      : "";
    return `- taskId: "${t.id}" ${statusTag} ${t.title}${agent}${subtaskSummary}`;
  });
  const active = sorted.find((t) => t.id === snap.activeTaskId);
  const footer = active
    ? `\n\nCurrently active: taskId "${active.id}" — ${active.title}. Call task_complete when done.`
    : "";
  return toolResult(`Tasks in this conversation:\n\n${lines.join("\n")}${footer}`);
};

const subtaskToggleHandler: ToolHandler = async (args) => {
  const { taskId, subtaskId, completed } = args as {
    taskId?: string;
    subtaskId?: string;
    completed?: boolean;
  };
  if (typeof taskId !== "string" || typeof subtaskId !== "string" || typeof completed !== "boolean") {
    return toolError("task_subtask_toggle requires taskId, subtaskId, completed");
  }

  const snap = await loadSnapshot();
  const task = snap.tasks.find((t) => t.id === taskId);
  if (!task) return toolError(notFoundError(snap, taskId));
  const subtask = task.subtasks.find((s) => s.id === subtaskId);
  if (!subtask) return toolError(`Subtask ${subtaskId} not found`);

  subtask.completed = completed;
  await saveSnapshot(snap);
  await emitState(snap);
  return toolResult(`${completed ? "Checked" : "Unchecked"}: ${subtask.title}`);
};

const listAgentsHandler: ToolHandler = async () => {
  try {
    const configs = await agentConfigs.list();
    if (configs.length === 0) {
      return toolResult(
        "No agents or teams are configured. Create agents in the settings panel first.",
      );
    }
    const lines = configs.map((c) => {
      const tag = c.isTeam ? " [team]" : "";
      const desc = c.description ? ` — ${c.description}` : "";
      return `- **${c.name}**${tag} (agentConfigId: "${c.id}")${desc}`;
    });
    return toolResult(
      `Available agents and teams:\n\n${lines.join("\n")}\n\nUse the agentConfigId with \`task_assign\` or the \`assignTo\` field in \`task_plan\` to assign agents to tasks.`,
    );
  } catch (err) {
    return toolError(
      `Failed to list agents: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

// ── commit-2 mutation tools ─────────────────────────────────────────

const startHandler: ToolHandler = async (args) => {
  const { taskId } = args as { taskId?: string };
  if (typeof taskId !== "string") return toolError("task_start requires 'taskId'");
  const snap = await loadSnapshot();
  const task = snap.tasks.find((t) => t.id === taskId);
  if (!task) return toolError(notFoundError(snap, taskId));
  for (const other of snap.tasks) {
    if (other.id !== taskId && other.status === "active") {
      other.status = "pending";
      other.startedAt = undefined;
    }
  }
  task.status = "active";
  task.startedAt = new Date().toISOString();
  snap.activeTaskId = task.id;
  await saveSnapshot(snap);
  await emitState(snap);
  return toolResult(`Started task: ${task.title}`);
};

const completeHandler: ToolHandler = async (args) => {
  const { taskId, summary } = args as { taskId?: string; summary?: string };
  if (typeof taskId !== "string") return toolError("task_complete requires 'taskId'");
  const snap = await loadSnapshot();
  const task = snap.tasks.find((t) => t.id === taskId);
  if (!task) return toolError(notFoundError(snap, taskId));

  await terminateRunningAssignments(
    task,
    "completed",
    "Parent task was manually completed",
  );

  task.status = "completed";
  task.completedAt = new Date().toISOString();
  if (summary) task.completionSummary = summary;
  if (snap.activeTaskId === task.id) snap.activeTaskId = undefined;

  // Auto-advance to the next pending task. Commit 3 extends this to also
  // fire `spawnAssignment` for newly-unblocked dependents; for commit 2
  // we only mutate state — assignments stay in `assigned` status.
  const next = getNextPendingTask(snap);
  if (next) {
    next.status = "active";
    next.startedAt = new Date().toISOString();
    snap.activeTaskId = next.id;
  }

  await saveSnapshot(snap);
  await emitState(snap);

  const remaining = snap.tasks.filter(
    (t) => t.status === "pending" || t.status === "active",
  ).length;
  if (next) {
    const descLine = next.description ? `\ndescription: ${next.description}` : "";
    return toolResult(
      `Completed: ${task.title}\n\nAuto-advanced. Next task is now ACTIVE:\ntaskId: "${next.id}"\ntitle: ${next.title}${descLine}\n\n${remaining} task(s) remaining. Continue working on this task. When done, call task_complete with taskId "${next.id}".`,
    );
  }
  return toolResult(
    `Completed: ${task.title}\n\nAll tasks done! ${snap.tasks.filter((t) => t.status === "completed").length} completed, ${snap.tasks.filter((t) => t.status === "failed").length} failed.`,
  );
};

const failHandler: ToolHandler = async (args) => {
  const { taskId, reason } = args as { taskId?: string; reason?: string };
  if (typeof taskId !== "string" || typeof reason !== "string") {
    return toolError("task_fail requires 'taskId' and 'reason'");
  }
  const snap = await loadSnapshot();
  const task = snap.tasks.find((t) => t.id === taskId);
  if (!task) return toolError(notFoundError(snap, taskId));

  await terminateRunningAssignments(
    task,
    "failed",
    `Parent task was failed: ${reason}`,
  );

  task.status = "failed";
  task.failedAt = new Date().toISOString();
  task.failureReason = reason;
  if (snap.activeTaskId === task.id) snap.activeTaskId = undefined;
  await saveSnapshot(snap);
  await emitState(snap);
  return toolResult(`Failed task: ${task.title}\nReason: ${reason}`);
};

const updateHandler: ToolHandler = async (args) => {
  const { taskId, title, description, status, dependsOn } = args as {
    taskId?: string;
    title?: string;
    description?: string;
    status?: TaskStatus;
    dependsOn?: string[];
  };
  if (typeof taskId !== "string") return toolError("task_update requires 'taskId'");
  const snap = await loadSnapshot();
  const task = snap.tasks.find((t) => t.id === taskId);
  if (!task) return toolError(notFoundError(snap, taskId));

  const depWarnings: string[] = [];
  if (dependsOn !== undefined) {
    const knownIds = new Set(snap.tasks.map((t) => t.id));
    const resolved: string[] = [];
    for (const ref of dependsOn) {
      if (ref === task.id) {
        depWarnings.push("Task cannot depend on itself — skipped.");
        continue;
      }
      if (knownIds.has(ref)) resolved.push(ref);
      else depWarnings.push(`"${ref}" is not a known taskId — skipped.`);
    }
    const prevDeps = task.dependsOn;
    task.dependsOn = resolved.length > 0 ? resolved : undefined;
    const cycle = detectCycle(snap.tasks as ReadonlyTask[]);
    if (cycle) {
      task.dependsOn = prevDeps;
      return toolError(
        `Rejected: update would introduce a dependency cycle: ${cycle.join(" → ")}. Task unchanged.`,
      );
    }
  }

  if (title !== undefined) task.title = title;
  if (description !== undefined) task.description = description;
  if (status !== undefined) task.status = status;

  await saveSnapshot(snap);
  await emitState(snap);

  const warningMsg = depWarnings.length > 0 ? ` Warnings: ${depWarnings.join("; ")}.` : "";
  return toolResult(`Updated task: ${task.title}.${warningMsg}`);
};

const setDepsHandler: ToolHandler = async (args) => {
  const { taskId, dependsOn } = args as { taskId?: string; dependsOn?: string[] };
  if (typeof taskId !== "string" || !Array.isArray(dependsOn)) {
    return toolError("task_set_dependencies requires 'taskId' and 'dependsOn' array");
  }
  const snap = await loadSnapshot();
  const task = snap.tasks.find((t) => t.id === taskId);
  if (!task) return toolError(notFoundError(snap, taskId));

  const knownIds = new Set(snap.tasks.map((t) => t.id));
  const resolved: string[] = [];
  const warnings: string[] = [];
  for (const ref of dependsOn) {
    if (ref === task.id) {
      warnings.push("Task cannot depend on itself — skipped.");
      continue;
    }
    if (knownIds.has(ref)) resolved.push(ref);
    else warnings.push(`"${ref}" is not a known taskId — skipped.`);
  }

  const prevDeps = task.dependsOn;
  task.dependsOn = resolved.length > 0 ? resolved : undefined;
  const cycle = detectCycle(snap.tasks as ReadonlyTask[]);
  if (cycle) {
    task.dependsOn = prevDeps;
    return toolError(
      `Rejected: this would introduce a dependency cycle: ${cycle.join(" → ")}. Task unchanged.`,
    );
  }

  await saveSnapshot(snap);
  await emitState(snap);

  const warningMsg = warnings.length > 0 ? ` Warnings: ${warnings.join("; ")}.` : "";
  const depTitles = resolved.map((id) => snap.tasks.find((t) => t.id === id)?.title ?? id);
  const depsDescription = resolved.length > 0
    ? `Task "${task.title}" now depends on: ${depTitles.map((t) => `"${t}"`).join(", ")}.`
    : `Task "${task.title}" has no prerequisites.`;
  return toolResult(`${depsDescription}${warningMsg}`);
};

const unassignHandler: ToolHandler = async (args) => {
  const { taskId, assignmentId } = args as { taskId?: string; assignmentId?: string };
  if (typeof taskId !== "string" || typeof assignmentId !== "string") {
    return toolError("task_unassign requires 'taskId' and 'assignmentId'");
  }
  const snap = await loadSnapshot();
  const task = snap.tasks.find((t) => t.id === taskId);
  if (!task) return toolError(notFoundError(snap, taskId));

  let idx = task.assignments.findIndex((a) => a.id === assignmentId);
  if (idx >= 0) {
    const target = task.assignments[idx]!;
    if (target.status !== "assigned") {
      return toolError(
        `Cannot unassign: assignment is "${target.status}", not "assigned". Only idle assignments can be removed.`,
      );
    }
    task.assignments.splice(idx, 1);
    await saveSnapshot(snap);
    await emitState(snap);
    return toolResult(`Unassigned @${target.agentName} from task: ${task.title}`);
  }

  for (const subtask of task.subtasks) {
    if (!subtask.assignments) continue;
    idx = subtask.assignments.findIndex((a) => a.id === assignmentId);
    if (idx >= 0) {
      const target = subtask.assignments[idx]!;
      if (target.status !== "assigned") {
        return toolError(
          `Cannot unassign: assignment is "${target.status}", not "assigned".`,
        );
      }
      subtask.assignments.splice(idx, 1);
      await saveSnapshot(snap);
      await emitState(snap);
      return toolResult(`Unassigned @${target.agentName} from subtask: ${subtask.title}`);
    }
  }

  return toolError(
    `Assignment "${assignmentId}" not found on task "${task.title}" or its subtasks.`,
  );
};

// ── commit-3 assignment tool ────────────────────────────────────────

const assignHandler: ToolHandler = async (args) => {
  const { taskId, agentConfigId, subtaskId, autoStart } = args as {
    taskId?: string;
    agentConfigId?: string;
    subtaskId?: string;
    autoStart?: boolean;
  };
  if (typeof taskId !== "string" || typeof agentConfigId !== "string") {
    return toolError("task_assign requires 'taskId' and 'agentConfigId'");
  }

  const snap = await loadSnapshot();
  const task = snap.tasks.find((t) => t.id === taskId);
  if (!task) return toolError(notFoundError(snap, taskId));

  const config = await agentConfigs.resolve(agentConfigId);
  if (!config) {
    return toolError(
      `Agent "${agentConfigId}" not found by ID or name. Call task_list_agents to see available agents.`,
    );
  }

  const assignment: TaskAssignment = {
    id: genId(),
    agentConfigId: config.id,
    agentName: config.name,
    isTeam: config.isTeam,
    status: "assigned",
    assignedAt: new Date().toISOString(),
  };

  if (subtaskId) {
    const subtask = task.subtasks.find((s) => s.id === subtaskId);
    if (!subtask) {
      return toolError(`Subtask "${subtaskId}" not found in task "${task.title}".`);
    }
    subtask.assignments = subtask.assignments ?? [];
    subtask.assignments.push(assignment);
  } else {
    task.assignments.push(assignment);
  }

  await saveSnapshot(snap);
  await emitState(snap);

  const wantedAutoStart = autoStart !== false;
  let spawnMsg: string;
  if (!wantedAutoStart) {
    spawnMsg = describeSpawnOutcome(config.name, config.isTeam, false, "not-requested");
  } else if (task.status === "completed" || task.status === "failed") {
    spawnMsg = describeSpawnOutcome(config.name, config.isTeam, true, "skipped-terminal");
  } else if (isBlocked(task, toReadonly(snap))) {
    const waiting = unsatisfiedDeps(task, toReadonly(snap)).map((t) => t.title);
    spawnMsg = describeSpawnOutcome(config.name, config.isTeam, true, "skipped-blocked", waiting);
  } else {
    const outcome = await runSpawnForAssignment(snap, task, assignment);
    spawnMsg = describeSpawnOutcome(config.name, config.isTeam, true, outcome);
  }

  return toolResult(
    `Assigned @${config.name}${config.isTeam ? " (team)" : ""} to ${subtaskId ? "subtask" : "task"}: ${task.title} [assignmentId: "${assignment.id}"]\n${spawnMsg}`,
  );
};

/**
 * Stop a running assignment mid-execution. Cancels the underlying sub-
 * agent run via the Phase 4 `ezcorp/cancel-run` reverse-RPC and resets
 * the assignment to "assigned" so `task_resume` can pick it up.
 * Preserves subConversationId — the resumed run reuses the same sub-
 * conversation so the sub-agent sees its full prior context.
 *
 * Ownership: cancelRun is gated on the caller extension having spawned
 * the run (see phase-4-plan.md §5.3). The task-tracking extension owns
 * runs it started via `spawnAssignment` (through this extension's
 * assignHandler autoStart / startHandler / etc). Runs started via the
 * HTTP /api/conversations/.../start route don't belong to the extension
 * and cancel will reject with -32001 — the handler surfaces that to
 * the LLM with guidance to use the UI's Stop button.
 */
const stopHandler: ToolHandler = async (args) => {
  const { taskId, assignmentId, reason } = args as {
    taskId?: string;
    assignmentId?: string;
    reason?: string;
  };
  if (typeof taskId !== "string" || typeof assignmentId !== "string") {
    return toolError("task_stop requires 'taskId' and 'assignmentId'");
  }
  const snap = await loadSnapshot();
  const task = snap.tasks.find((t) => t.id === taskId);
  if (!task) return toolError(notFoundError(snap, taskId));

  // Find assignment at task level or subtask level.
  let assignment: TaskAssignment | undefined = task.assignments.find((a) => a.id === assignmentId);
  if (!assignment) {
    for (const subtask of task.subtasks) {
      assignment = subtask.assignments?.find((a) => a.id === assignmentId);
      if (assignment) break;
    }
  }
  if (!assignment) return toolError(`Assignment ${assignmentId} not found on task ${taskId}`);
  if (assignment.status !== "running") {
    return toolError(`Assignment is "${assignment.status}", expected "running"`);
  }

  if (!assignment.agentRunId) {
    return toolError(`Assignment has no agentRunId — cannot cancel an unmaterialized run`);
  }

  // Ask the host to cancel. Ownership check happens host-side.
  try {
    const result = await cancel(assignment.agentRunId);
    if (!result.cancelled) {
      const detailReason = typeof (result as { reason?: unknown }).reason === "string"
        ? (result as { reason: string }).reason
        : "unknown";
      return toolError(
        `Host rejected cancel: ${detailReason}. This usually means the run was started outside this extension (e.g. via the UI). Ask the user to click Stop on the assignment pill.`,
      );
    }
  } catch (err) {
    if (err instanceof JsonRpcError && err.code === -32001) {
      return toolError(
        `Cannot cancel this run — it was started outside this extension. Ask the user to click Stop on the assignment pill in the task panel.`,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    return toolError(`Cancel failed: ${msg}`);
  }

  // Reset state. Preserve subConversationId for resume.
  assignment.status = "assigned";
  delete assignment.agentRunId;
  delete assignment.startedAt;

  // Fall the task back to pending if nothing else on it is running.
  const anyRunning = task.assignments.some((a) => a.status === "running")
    || task.subtasks.some((s) => (s.assignments ?? []).some((a) => a.status === "running"));
  if (!anyRunning && task.status === "active") {
    task.status = "pending";
    if (snap.activeTaskId === task.id) snap.activeTaskId = undefined;
  }

  await saveSnapshot(snap);
  await emitState(snap);
  await taskEvents.emitAssignmentUpdate(taskId, assignment);

  const reasonLine = reason ? `\nReason: ${reason}` : "";
  return toolResult(
    `Stopped assignment "${assignment.agentName}" on task "${task.title}".${reasonLine}\nContext preserved — call task_resume with the same taskId + assignmentId to continue.`,
  );
};

/**
 * Resume a previously-stopped assignment. Re-spawns on the SAME sub-
 * conversation so the sub-agent sees its full prior context.
 * `spawnAssignment`'s `reuseSubConversationFor: agentConfigId` asks the
 * host to look up the existing sub-conv for the parent conversation +
 * agent config pair; since we preserved `subConversationId` on the
 * assignment when it was stopped, the host will find and reuse it.
 */
const resumeHandler: ToolHandler = async (args) => {
  const { taskId, assignmentId } = args as {
    taskId?: string;
    assignmentId?: string;
  };
  if (typeof taskId !== "string" || typeof assignmentId !== "string") {
    return toolError("task_resume requires 'taskId' and 'assignmentId'");
  }
  const snap = await loadSnapshot();
  const task = snap.tasks.find((t) => t.id === taskId);
  if (!task) return toolError(notFoundError(snap, taskId));

  let assignment: TaskAssignment | undefined = task.assignments.find((a) => a.id === assignmentId);
  if (!assignment) {
    for (const subtask of task.subtasks) {
      assignment = subtask.assignments?.find((a) => a.id === assignmentId);
      if (assignment) break;
    }
  }
  if (!assignment) return toolError(`Assignment ${assignmentId} not found on task ${taskId}`);
  if (assignment.status !== "assigned") {
    return toolError(`Assignment is "${assignment.status}", expected "assigned" (call task_stop first if it's running).`);
  }
  if (!assignment.subConversationId) {
    return toolError(
      `Assignment has no prior subConversationId — nothing to resume. Use task_start / task_assign autoStart to begin a fresh run.`,
    );
  }

  // Dependency gate — mirror task_start / assign.
  if (isBlocked(task as ReadonlyTask, snap as unknown as ReadonlySnapshot)) {
    const waiting = unsatisfiedDeps(task as ReadonlyTask, snap as unknown as ReadonlySnapshot).map((t) => t.title);
    return toolError(`Task is blocked — waiting for prerequisites: ${waiting.join(", ")}`);
  }

  // Re-spawn. Passing reuseSubConversationFor nudges the host to match
  // the existing sub-conversation (same agentConfigId under the same
  // parent conversation), which lines up with the one we stored on
  // assignment.subConversationId before the stop.
  const input: SpawnAssignmentInput = {
    task: task.description || task.title,
    agentConfigId: assignment.agentConfigId,
    taskId,
    assignmentId,
    title: task.title,
    reuseSubConversationFor: assignment.agentConfigId,
  };
  const outcome = await attemptSpawn(input);
  if (outcome.status !== "started") {
    if (outcome.status === "invalid" || outcome.status === "dispatch-failed" || outcome.status === "unknown-error") {
      // Mark the assignment failed — mirrors the ladder in assignHandler.
      await recordAssignmentFailure(snap, taskId, assignment, outcome.message);
      return toolError(`Resume failed (${outcome.status}): ${outcome.message}`);
    }
    return toolError(`Resume rejected (${outcome.status}): ${outcome.message}`);
  }

  // Happy path — transition to running, record the fresh run ids.
  assignment.status = "running";
  assignment.startedAt = new Date().toISOString();
  assignment.agentRunId = outcome.handle.agentRunId;
  // subConversationId is preserved; the host confirms reuse via the handle.
  assignment.subConversationId = outcome.handle.subConversationId;

  if (task.status === "pending") {
    task.status = "active";
    if (!task.startedAt) task.startedAt = new Date().toISOString();
    snap.activeTaskId = task.id;
  }

  await saveSnapshot(snap);
  await emitState(snap);
  await taskEvents.emitAssignmentUpdate(taskId, assignment);

  return toolResult(
    `Resumed assignment "${assignment.agentName}" on task "${task.title}". Sub-agent sees full prior context (subConversationId ${assignment.subConversationId}).`,
  );
};

export const tools: Record<string, ToolHandler> = {
  task_plan: planHandler,
  task_add: addHandler,
  task_list: listHandler,
  task_subtask_toggle: subtaskToggleHandler,
  task_list_agents: listAgentsHandler,
  task_start: startHandler,
  task_complete: completeHandler,
  task_fail: failHandler,
  task_update: updateHandler,
  task_set_dependencies: setDepsHandler,
  task_unassign: unassignHandler,
  task_assign: assignHandler,
  task_stop: stopHandler,
  task_resume: resumeHandler,
};

// ── commit-4 two-hop bridge (task:assignment_update subscription) ───
//
// The host's start-assignment.ts emits `task:assignment_update` inside
// its run:complete / run:error listeners (post-commit-5; while the
// built-in still exists the event is emitted from there). The host
// forces `payload.conversationId` to the one we're wired to, so we
// trust it blindly.
//
// Design points from the plan §4.2:
//   - `agent:complete` is NOT subscribed — it lacks conversationId
//     and isn't in Phase 2c's allowlist. The bridge carries completion
//     through `task:assignment_update` instead.
//   - The extension ALSO emits task:assignment_update itself (from
//     runSpawnForAssignment). Phase 2c re-delivers it. Idempotency is
//     load-bearing: if the local assignment is already in the incoming
//     status (or past it — terminal), the handler is a no-op.
//   - Completed → auto-advance + unblock ready dependents (spawning any
//     newly-ready assignments).
//   - Failed → flip the owning task to failed.

interface IncomingAssignmentUpdate {
  conversationId: string;
  taskId: string;
  assignment: TaskAssignment;
}

async function auto_advance_after_complete(
  snap: PersistedSnapshot,
  completedTaskId: string,
  summary?: string,
): Promise<void> {
  const task = snap.tasks.find((t) => t.id === completedTaskId);
  if (!task || task.status === "completed" || task.status === "failed") return;

  // Tasks with multiple assignments only roll up when every assignment
  // has reached a terminal state. Prevents siblings from being orphaned
  // "running" while the parent task flips to completed on first finish.
  const allTerminal = task.assignments.every(
    (a) => a.status === "completed" || a.status === "failed",
  );
  if (!allTerminal) return;

  task.status = "completed";
  task.completedAt = new Date().toISOString();
  if (summary) task.completionSummary = summary;
  if (snap.activeTaskId === task.id) snap.activeTaskId = undefined;

  const next = getNextPendingTask(snap);
  if (next) {
    next.status = "active";
    next.startedAt = new Date().toISOString();
    snap.activeTaskId = next.id;
  }
}

async function unblockReadyDependents(snap: PersistedSnapshot): Promise<void> {
  // Match the built-in's sweep: non-terminal tasks with `assigned`
  // assignments that are no longer blocked. Newly-ready → spawn each
  // assignment individually so the error ladder applies per-assignment.
  const candidates = snap.tasks.filter(
    (t) =>
      t.status !== "completed" &&
      t.status !== "failed" &&
      !isBlocked(t, toReadonly(snap)) &&
      t.assignments.some((a) => a.status === "assigned"),
  );
  for (const task of candidates) {
    for (const assignment of task.assignments) {
      if (assignment.status !== "assigned") continue;
      // runSpawnForAssignment handles persist+emit itself. We pass the
      // live snapshot so its mutation is visible to subsequent iters.
      await runSpawnForAssignment(snap, task, assignment);
    }
  }
}

async function handleAssignmentUpdate(
  payload: IncomingAssignmentUpdate,
): Promise<void> {
  const snap = await loadSnapshot();
  const task = snap.tasks.find((t) => t.id === payload.taskId);
  const incoming = payload.assignment;
  if (!task) {
    // Update arrived for a task this extension doesn't own. Log so the
    // silent drop is diagnosable, and re-emit the current snapshot to
    // keep the UI in sync with storage (guards against UI drift when an
    // upstream event was missed).
    console.warn(
      `[task-tracking] assignment update for unknown taskId: ${payload.taskId} (assignmentId=${incoming.id}, status=${incoming.status}); known tasks=${snap.tasks.length}`,
    );
    await emitState(snap);
    return;
  }
  const existing = task.assignments.find((a) => a.id === incoming.id);
  if (!existing) {
    // Subtask-scoped assignment?
    for (const subtask of task.subtasks) {
      if (!subtask.assignments) continue;
      const sa = subtask.assignments.find((a) => a.id === incoming.id);
      if (sa) {
        if (sa.status === "completed" || sa.status === "failed") return;
        Object.assign(sa, incoming);
        await saveSnapshot(snap);
        await emitState(snap);
        return;
      }
    }
    // Same pattern as the unknown-task branch: surface the drop and
    // resync so the UI isn't left hanging on a stale assignment row.
    console.warn(
      `[task-tracking] assignment update for unknown assignmentId: ${incoming.id} on task ${task.id} (status=${incoming.status})`,
    );
    await emitState(snap);
    return;
  }
  // Idempotency guard: skip self-echo and already-terminal transitions.
  // After this early return `existing.status` is narrowed to the
  // non-terminal subset, so any incoming terminal status is a real
  // transition (no extra prev-status check needed below).
  if (existing.status === "completed" || existing.status === "failed") return;
  Object.assign(existing, incoming);

  if (incoming.status === "completed") {
    await auto_advance_after_complete(snap, task.id, incoming.resultPreview);
  } else if (incoming.status === "failed") {
    if (task.status !== "completed" && task.status !== "failed") {
      task.status = "failed";
      task.failedAt = new Date().toISOString();
      task.failureReason = incoming.resultPreview;
      if (snap.activeTaskId === task.id) snap.activeTaskId = undefined;
    }
  }

  await saveSnapshot(snap);
  await emitState(snap);

  // After a completion we may have newly-unblocked dependents to spawn.
  if (incoming.status === "completed") {
    await unblockReadyDependents(snap);
  }
}

// Expose the internal helpers for test cases that need to seed state
// without going through the tool-call path.
export const _internals = {
  loadSnapshot,
  saveSnapshot,
  emitState,
  getNextPendingTask,
  notFoundError,
  STORAGE_KEY,
  runSpawnForAssignment,
  attemptSpawn,
  recordAssignmentFailure,
  toReadonly,
  handleAssignmentUpdate,
  unblockReadyDependents,
};

// Export shared utilities used by later commits' handlers so unit tests
// importing this module have one place to reach for them.
export { unsatisfiedDeps, isBlocked, detectCycle };

// Production wiring — gated on `import.meta.main` so test imports don't
// open stdin. See scratchpad/index.ts for the canonical pattern.
if (import.meta.main) {
  const ch = getChannel();
  createToolDispatcher(tools);
  registerEventHandler("task:assignment_update", handleAssignmentUpdate);
  ch.start();
}
