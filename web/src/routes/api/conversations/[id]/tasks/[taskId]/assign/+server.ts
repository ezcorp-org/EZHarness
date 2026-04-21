import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import * as convQueries from "$server/db/queries/conversations";
import { getAgentConfig } from "$server/db/queries/agent-configs";
import { getBus } from "$lib/server/context";
import {
  getTaskSnapshotForConversation,
  writeTaskSnapshotForConversation,
  ensureTaskTrackingWired,
} from "$server/runtime/task-tracking-host";

/**
 * POST — Assign an agent or team to a task.
 * DELETE — Remove an assignment that is still in "assigned" status.
 *
 * Phase 3 commit-5 routes state through the bundled task-tracking
 * extension's `extension_storage` row via task-tracking-host helpers
 * instead of the removed in-memory `getOrCreateStore` / `persistToDb`
 * pair. The bundled extension subscribes to the emitted
 * `task:assignment_update` / `task:snapshot` bus events too, but its
 * idempotency guard (see docs/extensions/examples/task-tracking/
 * index.ts `handleAssignmentUpdate`) means a self-echo of the manual
 * route's emission is a no-op. Calling
 * `writeTaskSnapshotForConversation` before emitting keeps the
 * extension's storage authoritative without a race.
 */

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const conv = await convQueries.getConversation(params.id);
  if (!conv) return json({ error: "Not found" }, { status: 404 });
  // sec-H3b: fail-closed — unowned rows (null userId) are admin-only
  if (conv.userId !== user.id && user.role !== "admin") return json({ error: "Not found" }, { status: 404 });

  const body = await request.json() as { agentConfigId: string; subtaskId?: string };
  if (!body.agentConfigId) {
    return json({ error: "agentConfigId is required" }, { status: 400 });
  }

  await ensureTaskTrackingWired(params.id);
  const snapshot = await getTaskSnapshotForConversation(params.id) ?? {
    conversationId: params.id,
    tasks: [],
  };
  const task = snapshot.tasks.find((t) => t.id === params.taskId);
  if (!task) return json({ error: "Task not found" }, { status: 404 });

  const config = await getAgentConfig(body.agentConfigId);
  if (!config) return json({ error: "Agent config not found" }, { status: 404 });

  const refs = config.references as { members?: unknown[] } | null;
  const isTeam = Array.isArray(refs?.members) && refs.members.length > 0;

  const assignment = {
    id: crypto.randomUUID(),
    agentConfigId: body.agentConfigId,
    agentName: config.name,
    isTeam,
    status: "assigned" as const,
    assignedAt: new Date().toISOString(),
  };

  if (body.subtaskId) {
    const subtask = task.subtasks.find((s) => s.id === body.subtaskId);
    if (!subtask) return json({ error: "Subtask not found" }, { status: 404 });
    subtask.assignments = subtask.assignments ?? [];
    subtask.assignments.push(assignment);
  } else {
    task.assignments.push(assignment);
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

  return json({ assignment, snapshot });
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const conv = await convQueries.getConversation(params.id);
  if (!conv) return json({ error: "Not found" }, { status: 404 });
  // sec-H3b: fail-closed — unowned rows (null userId) are admin-only
  if (conv.userId !== user.id && user.role !== "admin") return json({ error: "Not found" }, { status: 404 });

  const body = await request.json() as { assignmentId: string };
  if (!body.assignmentId) {
    return json({ error: "assignmentId is required" }, { status: 400 });
  }

  await ensureTaskTrackingWired(params.id);
  const snapshot = await getTaskSnapshotForConversation(params.id) ?? {
    conversationId: params.id,
    tasks: [],
  };
  const task = snapshot.tasks.find((t) => t.id === params.taskId);
  if (!task) return json({ error: "Task not found" }, { status: 404 });

  // Check task-level assignments
  let idx = task.assignments.findIndex((a) => a.id === body.assignmentId);
  if (idx >= 0) {
    const target = task.assignments[idx]!;
    if (target.status !== "assigned") {
      return json(
        { error: `Cannot remove assignment in "${target.status}" status` },
        { status: 409 },
      );
    }
    task.assignments.splice(idx, 1);
  } else {
    // Check subtask-level assignments
    let found = false;
    for (const subtask of task.subtasks) {
      if (!subtask.assignments) continue;
      idx = subtask.assignments.findIndex((a) => a.id === body.assignmentId);
      if (idx >= 0) {
        const target = subtask.assignments[idx]!;
        if (target.status !== "assigned") {
          return json(
            { error: `Cannot remove assignment in "${target.status}" status` },
            { status: 409 },
          );
        }
        subtask.assignments.splice(idx, 1);
        found = true;
        break;
      }
    }
    if (!found) return json({ error: "Assignment not found" }, { status: 404 });
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

  return json({ ok: true });
};
