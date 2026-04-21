import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import * as convQueries from "$server/db/queries/conversations";
import { getAgentConfig } from "$server/db/queries/agent-configs";
import { getExecutor, getBus } from "$lib/server/context";
import {
  ensureTaskTrackingWired,
  getTaskSnapshotForConversation,
  writeTaskSnapshotForConversation,
} from "$server/runtime/task-tracking-host";
import type { TaskAssignment, TaskSnapshot } from "$server/runtime/task-tracking-host";

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
  try {
    const body = await request.json();
    bodyModel = body?.model;
    bodyProvider = body?.provider;
  } catch { /* empty body is fine */ }

  const conv = await convQueries.getConversation(params.id);
  if (!conv) return json({ error: "Not found" }, { status: 404 });
  // sec-H3b: fail-closed — unowned rows (null userId) are admin-only
  if (conv.userId !== user.id && user.role !== "admin") return json({ error: "Not found" }, { status: 404 });

  await ensureTaskTrackingWired(params.id);
  const snapshot: TaskSnapshot = await getTaskSnapshotForConversation(params.id) ?? {
    conversationId: params.id,
    tasks: [],
    activeTaskId: undefined,
  };

  const task = snapshot.tasks.find((t) => t.id === params.taskId);
  if (!task) return json({ error: "Task not found" }, { status: 404 });
  if (task.status !== "failed") {
    return json(
      { error: `Task is "${task.status}", expected "failed"` },
      { status: 409 },
    );
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
  for (const a of resetAssignments) {
    bus.emit("task:assignment_update", {
      conversationId: params.id,
      taskId: params.taskId,
      assignment: a,
    });
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
      bus,
      conversationId: params.id,
      taskId: params.taskId,
      assignment,
      task,
      snapshot,
      projectId,
      agentConfig: {
        id: config.id,
        name: config.name,
        prompt: config.prompt,
        model: config.model,
        provider: config.provider,
      },
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
