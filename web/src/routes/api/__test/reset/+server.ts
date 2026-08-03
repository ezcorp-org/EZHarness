/**
 * TEST-ONLY conversation reset. Gated by `isTestSurfaceEnabled()` (404
 * otherwise) and `chat`-scoped auth. Deletes a conversation the caller owns
 * (cascading its messages / runs / tool-call state), giving a spec a clean
 * slate between runs. Ownership is enforced: a non-admin caller can only
 * reset their own conversation (mirrors the route ownership contract).
 *
 * POST { conversationId } → { ok, deleted }
 */
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { isTestSurfaceEnabled } from "$lib/server/test-surface";
import { getConversation, deleteConversation } from "$server/db/queries/conversations";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  let body: { conversationId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorJson(400, "Invalid JSON body");
  }
  if (typeof body.conversationId !== "string" || body.conversationId.length === 0) {
    return errorJson(400, "`conversationId` must be a non-empty string");
  }

  const conv = await getConversation(body.conversationId);
  // Idempotent: an already-deleted conversation is a no-op success so a
  // spec's teardown never trips on re-runs.
  if (!conv) return json({ ok: true, deleted: false });

  // Ownership: only the owner (or an admin) may reset.
  // sec-H3: fail-closed — the old leading `conv.userId &&` short-circuited on
  // a null owner, so an unowned conversation was resettable (deletable) by any
  // caller. Lower severity than the production routes because this whole route
  // is fail-closed behind `isTestSurfaceEnabled()` above, but it is the same
  // defect and takes the same fix.
  if (conv.userId !== user.id && user.role !== "admin") {
    return errorJson(403, "Forbidden");
  }

  const deleted = await deleteConversation(body.conversationId);
  return json({ ok: true, deleted });
};
