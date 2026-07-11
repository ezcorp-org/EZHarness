// Boot reconciliation of interrupted sub-agent assignments (durability, C2).
//
// When the process restarts mid-flight, the watchdog's boot path
// (interruptAllRuns / terminalizeOrphanedRuns) terminalizes every in-flight
// `runs` / `active_runs` row — but the task-tracking extension's persisted
// task snapshot still records the sub-agent's assignment as `running`. On the
// next panel load that assignment is stuck "running" forever with a dead run
// behind it.
//
// This pass reconciles those dangling assignments AFTER terminalization: for
// each conversation's persisted snapshot, any assignment still `running` whose
// `agentRunId` maps to a now-terminal (or absent) run is transitioned to
// `failed` with an actionable preview, the mutated snapshot is persisted, and
// the matching `task:assignment_update` + `agent:complete` events are emitted
// so the panel + any waiting extension state converge on next load.
//
// DESIGN — full resume (re-spawning the sub-agent) is a deliberate v1
// NON-GOAL. The sub-agent's context lives in its sub-conversation; re-driving
// it belongs to the user via `task_resume` / `send_to_agent`, which reuse that
// sub-conversation. This pass only makes the interrupted state HONEST (failed,
// with guidance) so the UI isn't wedged and the resume affordances are usable.
//
// The storage write is the source of truth here: this runs early in boot,
// before the task-tracking extension subprocess has subscribed to the bus, so
// the emitted events are for any live SSE session; the persisted snapshot is
// what the panel + extension reload from.

import type { EventBus } from "./events";
import type { AgentEvents } from "../types";
import { logger } from "../logger";
import { listStorageRowsForKey } from "../db/queries/extension-storage";
import { getRunStatusesByIds } from "../db/queries/runs";
import {
  getTaskTrackingExtensionId,
  writeTaskSnapshotForConversation,
  STORAGE_KEY,
  type TaskAssignment,
  type TrackedTask,
} from "./task-tracking-host";

const log = logger.child("boot-reconcile-assignments");

/** Actionable preview stamped onto a reconciled (failed) assignment. */
export const INTERRUPT_PREVIEW =
  "interrupted by restart — use task_resume or send_to_agent to continue";

interface DanglingTarget {
  conversationId: string;
  taskId: string;
  assignment: TaskAssignment;
}

/**
 * Reconcile task-tracking assignments left `running` by a restart. Returns
 * the number of assignments transitioned to `failed`. Best-effort: a
 * not-yet-installed extension (very early boot) is a quiet no-op.
 */
export async function reconcileInterruptedAssignments(
  bus: EventBus<AgentEvents>,
): Promise<number> {
  let extId: string;
  try {
    extId = await getTaskTrackingExtensionId();
  } catch {
    // task-tracking not installed yet (uninitialized boot) — nothing to do.
    return 0;
  }

  const rows = await listStorageRowsForKey(extId, "conversation", STORAGE_KEY);

  // Gather every RUNNING assignment (task- or subtask-scoped) per conversation
  // so each snapshot is persisted at most once.
  const perConversation = new Map<
    string,
    {
      snapshot: { tasks: TrackedTask[]; activeTaskId?: string };
      running: DanglingTarget[];
    }
  >();
  const runIds = new Set<string>();

  for (const row of rows) {
    const conversationId = row.scopeId;
    if (!conversationId) continue; // conversation scope always carries an id
    const value = row.value as
      | { tasks?: TrackedTask[]; activeTaskId?: string }
      | null;
    const tasks = Array.isArray(value?.tasks) ? value!.tasks : [];
    const running: DanglingTarget[] = [];
    for (const task of tasks) {
      for (const assignment of collectRunningAssignments(task)) {
        running.push({ conversationId, taskId: task.id, assignment });
        if (assignment.agentRunId) runIds.add(assignment.agentRunId);
      }
    }
    if (running.length === 0) continue;
    perConversation.set(conversationId, {
      snapshot: {
        tasks,
        ...(value?.activeTaskId !== undefined
          ? { activeTaskId: value.activeTaskId }
          : {}),
      },
      running,
    });
  }

  if (perConversation.size === 0) return 0;

  const statuses = await getRunStatusesByIds([...runIds]);

  let reconciled = 0;
  for (const [conversationId, entry] of perConversation) {
    const patched: DanglingTarget[] = [];
    for (const target of entry.running) {
      const runId = target.assignment.agentRunId;
      // Still `running` after boot terminalization ⇒ treat as genuinely live
      // and leave alone (defensive: a fresh process owns none, but this keeps
      // the decision independent of terminalization ordering). A missing run
      // row (evicted / never persisted) counts as terminal → reconcile it.
      const status = runId ? statuses.get(runId) : undefined;
      if (status === "running") continue;
      const assignment = target.assignment;
      assignment.status = "failed";
      assignment.failedAt = new Date().toISOString();
      assignment.resultPreview = INTERRUPT_PREVIEW;
      patched.push(target);
    }
    if (patched.length === 0) continue;

    await writeTaskSnapshotForConversation(conversationId, entry.snapshot);
    for (const target of patched) {
      emitReconciled(bus, target);
      reconciled++;
    }
    log.info("Reconciled interrupted assignments", {
      conversationId,
      count: patched.length,
    });
  }

  return reconciled;
}

/** Every `running` assignment on a task — task-level plus subtask-level. */
function collectRunningAssignments(task: TrackedTask): TaskAssignment[] {
  const out: TaskAssignment[] = [];
  for (const a of task.assignments ?? []) {
    if (a.status === "running") out.push(a);
  }
  for (const sub of task.subtasks ?? []) {
    for (const a of sub.assignments ?? []) {
      if (a.status === "running") out.push(a);
    }
  }
  return out;
}

/** Emit the reconciling `task:assignment_update` + `agent:complete` so the
 *  panel + any waiting ext state converge on next load. */
function emitReconciled(bus: EventBus<AgentEvents>, target: DanglingTarget): void {
  const { conversationId, taskId, assignment } = target;
  bus.emit("task:assignment_update", {
    conversationId,
    taskId,
    assignment,
    resultFull: INTERRUPT_PREVIEW,
  });
  bus.emit("agent:complete", {
    runId: assignment.agentRunId ?? "",
    agentRunId: assignment.agentRunId ?? "",
    subConversationId: assignment.subConversationId ?? "",
    agentName: assignment.agentName,
    agentConfigId: assignment.agentConfigId,
    success: false,
    resultPreview: assignment.resultPreview ?? INTERRUPT_PREVIEW,
    parentConversationId: conversationId,
  });
}
