import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import * as convQueries from "$server/db/queries/conversations";
import { getExecutor, getBus } from "$lib/server/context";
import {
  ensureTaskTrackingWired,
  getTaskSnapshotForConversation,
  writeTaskSnapshotForConversation,
} from "$server/runtime/task-tracking-host";
import type { TaskSnapshot } from "$server/runtime/task-tracking-host";
import { findAssignment } from "$lib/server/task-helpers";

/**
 * POST — Stop a running assignment.
 *
 * Cancels the underlying agent run (via executor.cancelRun) and resets
 * the assignment back to "assigned" so the Start/Resume button re-
 * appears on the pill. Preserves `subConversationId` — the subsequent
 * start call can pass it as `reuseSubConversationId` so the sub-agent
 * resumes with full prior context. Clears `agentRunId` + `startedAt`
 * (fresh run on resume).
 *
 * 409 if the assignment isn't in "running" status. 404 for missing
 * conv / task / assignment.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const conv = await convQueries.getConversation(params.id);
  if (!conv) return errorJson(404, "Not found");
  // sec-H3b: fail-closed — unowned rows (null userId) are admin-only
  if (conv.userId !== user.id && user.role !== "admin") return errorJson(404, "Not found");

  await ensureTaskTrackingWired(params.id);
  const snapshot: TaskSnapshot = await getTaskSnapshotForConversation(params.id) ?? {
    conversationId: params.id,
    tasks: [],
    activeTaskId: undefined,
  };

  const task = snapshot.tasks.find((t) => t.id === params.taskId);
  if (!task) return errorJson(404, "Task not found");

  const assignment = findAssignment(task, params.assignmentId);
  if (!assignment) return errorJson(404, "Assignment not found");
  if (assignment.status !== "running") {
    return errorJson(409, `Assignment is "${assignment.status}", expected "running"`);
  }

  // Cancel the in-flight run. executor.cancelRun returns false if the
  // run is no longer in memory (already finished or evicted); we still
  // reset the assignment state below so the UI recovers.
  const runIdToCancel = assignment.agentRunId;
  let cancelled = false;
  if (runIdToCancel) {
    cancelled = getExecutor().cancelRun(runIdToCancel);
  }

  // Reset state — preserve subConversationId for resume context.
  assignment.status = "assigned";
  delete assignment.agentRunId;
  delete assignment.startedAt;

  // If this was the task's active assignment and nothing else is
  // active, fall back to "pending" on the task so the panel shows it
  // as resumable rather than active-but-no-work.
  const anyRunning = task.assignments.some((a) => a.status === "running")
    || task.subtasks.some((s) => (s.assignments ?? []).some((a) => a.status === "running"));
  if (!anyRunning && task.status === "active") {
    task.status = "pending";
    if (snapshot.activeTaskId === task.id) snapshot.activeTaskId = undefined;
  }

  await writeTaskSnapshotForConversation(params.id, {
    tasks: snapshot.tasks,
    ...(snapshot.activeTaskId !== undefined ? { activeTaskId: snapshot.activeTaskId } : {}),
  });

  const bus = getBus();
  bus.emit("task:snapshot", {
    conversationId: params.id,
    tasks: snapshot.tasks,
    ...(snapshot.activeTaskId !== undefined ? { activeTaskId: snapshot.activeTaskId } : {}),
  });
  bus.emit("task:assignment_update", {
    conversationId: params.id,
    taskId: params.taskId,
    assignment,
  });

  return json({ stopped: true, cancelled, assignment });
};
