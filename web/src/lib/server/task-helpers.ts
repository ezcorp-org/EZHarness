// Helpers shared across the task-lifecycle HTTP handlers under
// web/src/routes/api/conversations/[id]/tasks/. Extracted from the
// duplicated patterns in
//   - tasks/[taskId]/assignments/[assignmentId]/start/+server.ts
//   - tasks/[taskId]/assignments/[assignmentId]/stop/+server.ts
//   - tasks/[taskId]/retry/+server.ts
//
// Keep these helpers thin and side-effect free — every caller still
// owns its own auth, snapshot read/write, and bus emission.

import type {
  TaskAssignment,
  TaskSnapshot,
  TrackedTask,
} from "$server/runtime/task-tracking-host";
import {
  ensureTaskTrackingWired,
  getTaskSnapshotForConversation,
  writeTaskSnapshotForConversation,
} from "$server/runtime/task-tracking-host";
import { getBus } from "$lib/server/context";

/**
 * Wire task-tracking and load the conversation's snapshot, then find a
 * task by id within it. Returns the snapshot (always defined — falls
 * back to an empty `{ conversationId, tasks: [] }`) plus the task or
 * `undefined` when the id is not present.
 *
 * Five task-lifecycle handlers (assign POST, assign DELETE, retry,
 * /assignments/[id]/start, /assignments/[id]/stop) all open with this
 * exact three-step preamble. Each caller is responsible for emitting
 * its own 404 when `task` is undefined — the expected log lines and
 * follow-up status checks (e.g. retry's `task.status === "failed"`
 * gate) differ between handlers.
 */
export async function loadSnapshotAndFindTask(
  conversationId: string,
  taskId: string,
): Promise<{ snapshot: TaskSnapshot; task: TrackedTask | undefined }> {
  await ensureTaskTrackingWired(conversationId);
  const snapshot: TaskSnapshot = (await getTaskSnapshotForConversation(conversationId)) ?? {
    conversationId,
    tasks: [],
  };
  const task = snapshot.tasks.find((t) => t.id === taskId);
  return { snapshot, task };
}

/**
 * Find an assignment by id at the task level or under any of the task's
 * subtasks. Returns `undefined` when the id is not present anywhere.
 *
 * Used by /assignments/[assignmentId]/{start,stop} which both need to
 * locate an assignment regardless of which depth it lives at. Each
 * caller is responsible for its own status check after the lookup —
 * the expected status differs between handlers ("assigned" for start,
 * "running" for stop).
 */
export function findAssignment(
  task: TrackedTask,
  assignmentId: string,
): TaskAssignment | undefined {
  const direct = task.assignments.find((a) => a.id === assignmentId);
  if (direct) return direct;
  for (const subtask of task.subtasks) {
    const match = subtask.assignments?.find((a) => a.id === assignmentId);
    if (match) return match;
  }
  return undefined;
}

/**
 * Persist the snapshot for a conversation and broadcast a
 * `task:snapshot` event on the shared bus. Every task-lifecycle HTTP
 * handler that mutates the snapshot needs this exact pair, including
 * the conditional `activeTaskId` spread (the bus payload only carries
 * the field when it is defined). Callers that also need to broadcast
 * `task:assignment_update` should still emit that themselves — the
 * assignment delta isn't always available here (e.g. the DELETE path
 * has no surviving assignment object).
 */
export async function writeAndBroadcastSnapshot(
  conversationId: string,
  snapshot: TaskSnapshot,
): Promise<void> {
  await writeTaskSnapshotForConversation(conversationId, {
    tasks: snapshot.tasks,
    ...(snapshot.activeTaskId !== undefined ? { activeTaskId: snapshot.activeTaskId } : {}),
  });
  getBus().emit("task:snapshot", {
    conversationId,
    tasks: snapshot.tasks,
    ...(snapshot.activeTaskId !== undefined ? { activeTaskId: snapshot.activeTaskId } : {}),
  });
}

/**
 * Emit a `task:assignment_update` bus event with the canonical
 * `{ conversationId, taskId, assignment }` payload shape used by the
 * assign POST, retry, and stop handlers. The bundled task-tracking
 * extension subscribes to this event and persists the merged state
 * back to its own storage row; the manual handlers also emit it so
 * client subscriptions update without waiting for the extension's
 * write-back.
 *
 * Callers that need to fan out across multiple assignments (e.g. the
 * retry handler resetting N failed assignments) should call this once
 * per assignment.
 */
export function broadcastAssignmentUpdate(
  conversationId: string,
  taskId: string,
  assignment: TaskAssignment,
): void {
  getBus().emit("task:assignment_update", {
    conversationId,
    taskId,
    assignment,
  });
}

/**
 * Pick the five fields `startAssignment` actually reads off a stored
 * agent-config row (`{id, name, prompt, model, provider}`). The
 * `getAgentConfig` query returns the full DB row with extra columns
 * (timestamps, references, etc.) that the runtime spawn doesn't need;
 * the verbatim picker literal was duplicated at retry:134-140 and
 * start:105-111. Keeping it here makes it obvious why those five
 * fields (and only those five) cross the boundary into the spawn
 * payload.
 */
export function pickSpawnAgentConfig(config: {
  id: string;
  name: string;
  prompt: string;
  model?: string | null;
  provider?: string | null;
}): { id: string; name: string; prompt: string; model?: string | null; provider?: string | null } {
  return {
    id: config.id,
    name: config.name,
    prompt: config.prompt,
    model: config.model,
    provider: config.provider,
  };
}
