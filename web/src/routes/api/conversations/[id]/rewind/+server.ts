import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { logger } from "$server/logger";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import { getExecutor, getBus } from "$lib/server/context";
import { getActiveRun } from "$server/db/queries/active-runs";
import { rewindSession, isSessionHistoryProducerEnabled } from "$server/db/session-sync";
import { rewindConversationSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";
import type { RequestHandler } from "./$types";

const log = logger.child("api.rewind");

/**
 * POST /api/conversations/:id/rewind — rewind/checkpoint the conversation to a
 * message (Sessions P4, design §4). Moves the session's durable leaf pointer to
 * `targetMessageId` (pi `moveTo` — a `leaf` pointer entry, never a message
 * reparent) + optional `branch_summary`. The abandoned tail stays in `messages`
 * as a recoverable sibling branch; the client re-parents its next send onto the
 * new leaf.
 *
 * Guards (all-or-nothing with the flag):
 *  - flag OFF → 409 `session_producer_disabled` (the session leaf drives nothing
 *    unless the producer reads it).
 *  - a LIVE run in flight → 409 `active_run` (no mid-stream tree mutation —
 *    simplest safe choice; the client cancels first, then rewinds).
 *  - target not a live row of THIS conversation → 400 (target validation).
 *  - unowned/missing conversation → 404 (fail-closed, sibling-route pattern).
 *
 * Emits `conversation:tree-changed` (conversation-scoped) so other tabs refresh.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conversationId = params.id;

  const ownership = await resolveRootConversationForOwnership(conversationId, user);
  if (!ownership) return errorJson(404, "Not found");

  if (!(await isSessionHistoryProducerEnabled())) {
    return errorJson(409, "Session history producer is disabled", { code: "session_producer_disabled" });
  }

  // Never mutate the tree under a live run. Check the in-memory controller
  // first, then the DB row (survives a restart) — either means "running".
  const memRun = getExecutor().getActiveRunForConversation(conversationId);
  const dbRun = memRun ? null : await getActiveRun(conversationId);
  if (memRun || dbRun) {
    return errorJson(409, "Cannot rewind while a run is active", { code: "active_run" });
  }

  const parsed = rewindConversationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationError(parsed.error);

  const outcome = await rewindSession(conversationId, parsed.data.targetMessageId, parsed.data.summary);
  if (!outcome.ok) {
    return errorJson(400, "targetMessageId does not belong to this conversation", { code: "target_not_found" });
  }

  // Best-effort nudge to other tabs/subscribers — the tree is already durable.
  try {
    getBus().emit("conversation:tree-changed", { conversationId, currentLeaf: outcome.tree.currentLeaf });
  } catch (err) {
    log.warn("tree-changed emit failed (rewind already persisted)", { conversationId, error: String(err) });
  }

  return json(outcome.tree);
};
