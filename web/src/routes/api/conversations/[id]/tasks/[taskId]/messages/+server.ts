import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import * as convQueries from "$server/db/queries/conversations";
import { getTaskSnapshotForConversation } from "$server/runtime/task-tracking-host";
import type { TaskAssignment } from "$server/runtime/task-tracking-host";

/**
 * GET — Fetch messages for all assignments on a task, grouped by assignment.
 * Each assignment with a subConversationId gets its messages loaded from DB.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const conv = await convQueries.getConversation(params.id);
  if (!conv) return errorJson(404, "Not found");
  // sec-H3b: fail-closed — unowned rows (null userId) are admin-only
  if (conv.userId !== user.id && user.role !== "admin") return errorJson(404, "Not found");

  const snapshot = await getTaskSnapshotForConversation(params.id).catch(() => undefined);
  const task = snapshot?.tasks.find((t) => t.id === params.taskId);
  if (!task) return errorJson(404, "Task not found");

  // Collect all assignments with subConversationIds (from task + subtask level)
  const allAssignments: TaskAssignment[] = [
    ...task.assignments,
    ...task.subtasks.flatMap((s) => s.assignments ?? []),
  ];

  const assignmentsWithConvos = allAssignments.filter((a) => a.subConversationId);

  const streams = await Promise.all(
    assignmentsWithConvos.map(async (a) => {
      const messages = await convQueries.getMessages(a.subConversationId!);
      return {
        assignmentId: a.id,
        agentName: a.agentName,
        subConversationId: a.subConversationId!,
        status: a.status,
        messages,
      };
    }),
  );

  return json({ streams });
};
