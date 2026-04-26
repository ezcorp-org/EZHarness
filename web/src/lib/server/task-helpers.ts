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
import { writeTaskSnapshotForConversation } from "$server/runtime/task-tracking-host";
import { getBus } from "$lib/server/context";

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
