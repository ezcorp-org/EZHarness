import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import * as convQueries from "$server/db/queries/conversations";
import {
  getTaskSnapshotForConversation,
  TaskTrackingNotInstalledError,
} from "$server/runtime/task-tracking-host";

/**
 * Cold-start loader for the task-tracking panel.
 *
 * Returns the persisted task snapshot for a conversation read straight
 * from the task-tracking bundled extension's extension_storage row.
 * Called when the user opens a conversation so persisted tasks render
 * immediately without waiting for the first agent run.
 *
 * Phase 3 commit-5: consumed via `getTaskSnapshotForConversation`
 * instead of the legacy in-memory `getTaskSnapshot` Map — the
 * authoritative store now lives in `extension_storage` under the
 * bundled extension's real DB id.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const conversationId = params.id;
  const conv = await convQueries.getConversation(conversationId);
  if (!conv) return errorJson(404, "Not found");
  // sec-H3: fail-closed — unowned rows (null userId) are admin-only
  if (conv.userId !== user.id && user.role !== "admin") return errorJson(404, "Not found");

  // "No tasks" and "we couldn't read the tasks" must NOT look the same to the
  // client. The panel hydrates from this route on mount / conversation switch
  // / SSE reconnect and REPLACES what it is rendering, so answering a
  // transient DB failure with an empty snapshot would blank a populated task
  // panel — the failure mode this route previously had (`.catch(() =>
  // undefined)`) and nobody saw only because nothing consumed it yet.
  //
  // A missing extension row IS a real "no tasks" answer (nothing has ever
  // been persisted), so that one stays a 200.
  let snapshot: Awaited<ReturnType<typeof getTaskSnapshotForConversation>>;
  try {
    snapshot = await getTaskSnapshotForConversation(conversationId);
  } catch (err) {
    if (!(err instanceof TaskTrackingNotInstalledError)) {
      return errorJson(503, "Task snapshot temporarily unavailable");
    }
    snapshot = undefined;
  }

  return json(snapshot ?? { conversationId, tasks: [], activeTaskId: undefined });
};
