import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import * as convQueries from "$server/db/queries/conversations";
import { getTaskSnapshotForConversation } from "$server/runtime/task-tracking-host";

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
  if (!conv) return json({ error: "Not found" }, { status: 404 });
  // sec-H3: fail-closed — unowned rows (null userId) are admin-only
  if (conv.userId !== user.id && user.role !== "admin") return json({ error: "Not found" }, { status: 404 });

  const snapshot = await getTaskSnapshotForConversation(conversationId).catch(() => undefined);

  return json(snapshot ?? { conversationId, tasks: [], activeTaskId: undefined });
};
