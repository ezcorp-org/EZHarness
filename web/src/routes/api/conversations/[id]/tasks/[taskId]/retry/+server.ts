import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import * as convQueries from "$server/db/queries/conversations";
import { getAgentConfig } from "$server/db/queries/agent-configs";
import { getExecutor, getBus } from "$lib/server/context";
import { writeTaskSnapshotForConversation } from "$server/runtime/task-tracking-host";
import type { TaskAssignment } from "$server/runtime/task-tracking-host";
import {
  broadcastAssignmentUpdate,
  loadSnapshotAndFindTask,
  pickSpawnAgentConfig,
  writeAndBroadcastSnapshot,
} from "$lib/server/task-helpers";

// Boundary validation. Same shape as the sibling /start endpoint —
// optional `{ model, provider }` for the auto-spawn path; empty body
// is a valid retry-without-spawn. Passthrough keeps wire-compat.
const retryBodySchema = z.object({
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
}).passthrough();

/**
 * POST — Retry a failed task.
 *
 * Resets the task + all `failed` assignments back to runnable state
 * (task: failed → pending; assignment: failed → assigned; clears
 * `failedAt` / `failureReason` / `completedAt` / `resultPreview`).
 * If the task has exactly one assignment after reset, auto-spawns a
 * fresh sub-agent run via the shared `startAssignment` helper — same
 * path the manual Start button uses. If the task has 0 or >1
 * assignments, the reset happens but no spawn — user picks which
 * assignment to start.
 *
 * 409 if the task isn't in `failed` status; 404 if the task doesn't
 * exist. Body optional: `{ model?, provider? }` for the spawn's
 * parent-turn model defaults (parity with the /start endpoint).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  let bodyModel: string | undefined;
  let bodyProvider: string | undefined;
  const raw = await request.json().catch(() => undefined);
  if (raw !== undefined) {
    const parsed = retryBodySchema.safeParse(raw);
    if (!parsed.success) {
      return errorJson(400, "Invalid body: model and provider must be strings");
    }
    bodyModel = parsed.data.model;
    bodyProvider = parsed.data.provider;
  }

  const conv = await convQueries.getConversation(params.id);
  if (!conv) return errorJson(404, "Not found");
  // sec-H3b: fail-closed — unowned rows (null userId) are admin-only
  if (conv.userId !== user.id && user.role !== "admin") return errorJson(404, "Not found");

  const { snapshot, task } = await loadSnapshotAndFindTask(params.id, params.taskId);
  if (!task) return errorJson(404, "Task not found");
  if (task.status !== "failed") {
    return errorJson(409, `Task is "${task.status}", expected "failed"`);
  }

  // Reset task state.
  task.status = "pending";
  delete task.failedAt;
  delete task.failureReason;
  delete task.completedAt;
  delete task.completionSummary;

  // Reset failed assignments (both top-level and per-subtask).
  // TaskAssignment only carries failedAt/completedAt/resultPreview as
  // failure residue — no separate failureReason field (that's on the
  // task itself).
  const resetAssignments: TaskAssignment[] = [];
  for (const a of task.assignments) {
    if (a.status === "failed") {
      a.status = "assigned";
      delete a.failedAt;
      delete a.completedAt;
      delete a.resultPreview;
      resetAssignments.push(a);
    }
  }
  for (const subtask of task.subtasks) {
    for (const a of subtask.assignments ?? []) {
      if (a.status === "failed") {
        a.status = "assigned";
        delete a.failedAt;
        delete a.completedAt;
        delete a.resultPreview;
        resetAssignments.push(a);
      }
    }
  }

  await writeAndBroadcastSnapshot(params.id, snapshot);

  for (const a of resetAssignments) {
    broadcastAssignmentUpdate(params.id, params.taskId, a);
  }

  // Auto-spawn when there's exactly one runnable assignment. Matches
  // intuitive retry UX: "retry" does what "start" would have done on
  // the happy path.
  if (resetAssignments.length === 1) {
    const assignment = resetAssignments[0]!;
    const config = await getAgentConfig(assignment.agentConfigId);
    if (!config) {
      return json({
        snapshot,
        resetAssignmentIds: resetAssignments.map((a) => a.id),
        spawned: null,
        error: "Agent config not found — assignment reset but not started.",
      });
    }
    const projectId = conv.projectId ?? "global";
    const { startAssignment } = await import("$server/runtime/start-assignment");
    const { subConversationId, agentRunId } = await startAssignment({
      executor: getExecutor(),
      bus: getBus(),
      conversationId: params.id,
      taskId: params.taskId,
      assignment,
      task,
      snapshot,
      projectId,
      agentConfig: pickSpawnAgentConfig(config),
      parentModel: bodyModel ?? conv.model ?? undefined,
      parentProvider: bodyProvider ?? conv.provider ?? undefined,
    });
    await writeTaskSnapshotForConversation(params.id, {
      tasks: snapshot.tasks,
      ...(snapshot.activeTaskId !== undefined ? { activeTaskId: snapshot.activeTaskId } : {}),
    });
    return json({
      snapshot,
      resetAssignmentIds: resetAssignments.map((a) => a.id),
      spawned: { assignmentId: assignment.id, runId: agentRunId, subConversationId },
    });
  }

  return json({
    snapshot,
    resetAssignmentIds: resetAssignments.map((a) => a.id),
    spawned: null,
  });
};
