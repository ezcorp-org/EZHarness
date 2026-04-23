import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
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
import type { TaskAssignment } from "$server/runtime/task-tracking-host";
import { isBlocked, unsatisfiedDeps, type ReadonlyTask } from "$server/runtime/task-dependencies";

/**
 * POST — Start an assignment. Thin HTTP wrapper that performs auth and
 * lookups, then delegates the spawn + lifecycle wiring to the shared
 * `startAssignment` runtime helper (also used by Phase 2d's
 * spawn-assignment reverse RPC).
 *
 * Body (optional): { model?: string, provider?: string }
 * The frontend sends the user's currently-selected chat model so agents
 * with CURRENT_MODEL_SENTINEL or no model override can use it.
 *
 * Phase 3 commit-5: snapshot read/write goes through
 * task-tracking-host; the blocked-prereq gate reuses the extracted
 * task-dependencies module so it stays in sync with the bundled
 * extension's auto-start gate.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  // Parse optional body for model/provider from frontend
  let bodyModel: string | undefined;
  let bodyProvider: string | undefined;
  try {
    const body = await request.json();
    bodyModel = body?.model;
    bodyProvider = body?.provider;
  } catch { /* empty body is fine */ }

  const conv = await convQueries.getConversation(params.id);
  if (!conv) return errorJson(404, "Not found");
  // sec-H3b: fail-closed — unowned rows (null userId) are admin-only
  if (conv.userId !== user.id && user.role !== "admin") return errorJson(404, "Not found");

  await ensureTaskTrackingWired(params.id);
  const snapshot = await getTaskSnapshotForConversation(params.id) ?? {
    conversationId: params.id,
    tasks: [],
  };

  const task = snapshot.tasks.find((t) => t.id === params.taskId);
  if (!task) {
    console.error("[task-assignment-start] Task not found", {
      taskId: params.taskId,
      conversationId: params.id,
      storeTaskCount: snapshot.tasks.length,
      taskIds: snapshot.tasks.map((t) => t.id),
    });
    return errorJson(404, "Task not found");
  }

  // Find assignment at task level or subtask level
  let assignment: TaskAssignment | undefined;
  assignment = task.assignments.find((a) => a.id === params.assignmentId);
  if (!assignment) {
    for (const subtask of task.subtasks) {
      assignment = subtask.assignments?.find((a) => a.id === params.assignmentId);
      if (assignment) break;
    }
  }
  if (!assignment) return errorJson(404, "Assignment not found");
  if (assignment.status !== "assigned") {
    return errorJson(409, `Assignment is "${assignment.status}", expected "assigned"`);
  }

  // Dependency gate: block manual start when prerequisites aren't complete.
  // Matches the bundled extension's auto-start gate so the two entry
  // points agree on "don't start until prereqs finish."
  const depSnap = { tasks: snapshot.tasks as ReadonlyTask[] };
  if (isBlocked(task as ReadonlyTask, depSnap)) {
    const waitingOn = unsatisfiedDeps(task as ReadonlyTask, depSnap).map((t) => t.title);
    return errorJson(409, "Task is blocked — waiting for prerequisites to complete.", { waitingOn });
  }

  const config = await getAgentConfig(assignment.agentConfigId);
  if (!config) return errorJson(404, "Agent config not found");

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
    agentConfig: {
      id: config.id,
      name: config.name,
      prompt: config.prompt,
      model: config.model,
      provider: config.provider,
    },
    parentModel: bodyModel ?? conv.model ?? undefined,
    parentProvider: bodyProvider ?? conv.provider ?? undefined,
    // Resume-after-stop: when the assignment already carries a sub-
    // conversation id from a prior run, reuse it so the sub-agent sees
    // its full prior context. First starts have no subConversationId
    // and fall through to the normal create-new path.
    ...(assignment.subConversationId ? { reuseSubConversationId: assignment.subConversationId } : {}),
  });

  // Persist the updated snapshot back so the extension sees the
  // "running" assignment state on its next load.
  await writeTaskSnapshotForConversation(params.id, {
    tasks: snapshot.tasks,
    ...(snapshot.activeTaskId !== undefined ? { activeTaskId: snapshot.activeTaskId } : {}),
  });

  console.log("[task-assignment-start] Started", {
    conversationId: params.id,
    taskId: params.taskId,
    assignmentId: assignment.id,
    agentConfigId: assignment.agentConfigId,
    agentName: config.name,
    subConversationId,
    agentRunId,
  });

  return json({
    assignment,
    runId: agentRunId,
    subConversationId,
  });
};
