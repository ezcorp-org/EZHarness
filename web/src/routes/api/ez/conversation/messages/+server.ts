/**
 * Phase 48 follow-up — DELETE /api/ez/conversation/messages
 *
 * "Clear conversation" / "New chat" for the Ez panel. The schema enforces
 * one Ez conversation per user (partial unique index
 * `conversations_user_ez_unique`), so starting fresh means wiping the
 * message list — the conversation row itself stays so the panel's open
 * SSE subscription and locked mode continue working with the same
 * conversation id.
 *
 * The handler resolves the user's Ez conversation through the same
 * `getOrCreateEzConversation` helper the GET/POST sibling uses, then
 * delegates to `deleteAllMessagesForConversation` for the actual wipe.
 * Cascades on `attachments.message_id` and `tool_calls.message_id` (both
 * ON DELETE CASCADE in the schema) clean up the dependent rows.
 *
 * Auth: requires the `chat` scope (destructive — read isn't enough).
 */
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import {
  getOrCreateEzConversation,
  deleteAllMessagesForConversation,
} from "$server/db/queries/conversations";
import { logger } from "$server/logger";
import type { RequestHandler } from "./$types";

const log = logger.child("api.ez.conversation.messages");

export const DELETE: RequestHandler = async ({ locals }) => {
  // Outer try/catch mirrors the sibling +server.ts: requireAuth throws a
  // 401 Response when locals.user is missing — converting it back to a
  // returned Response keeps the handler contract "always returns" rather
  // than "sometimes throws", which trips up unit-test harnesses that
  // assert on the returned value.
  try {
    const scopeErr = requireScope(locals, "chat");
    if (scopeErr) return scopeErr;
    const user = requireAuth(locals);

    let ezConv: Awaited<ReturnType<typeof getOrCreateEzConversation>>;
    try {
      ezConv = await getOrCreateEzConversation(user.id);
    } catch (err) {
      log.warn("getOrCreateEzConversation failed", { userId: user.id, error: String(err) });
      return errorJson(500, "Failed to resolve Ez conversation");
    }

    let deletedCount: number;
    try {
      deletedCount = await deleteAllMessagesForConversation(ezConv.id);
    } catch (err) {
      log.error("deleteAllMessagesForConversation failed", {
        userId: user.id,
        conversationId: ezConv.id,
        error: String(err),
      });
      return errorJson(500, "Failed to clear Ez conversation");
    }

    log.debug("Ez conversation cleared", {
      userId: user.id,
      conversationId: ezConv.id,
      deletedCount,
    });

    return json({ ok: true, conversationId: ezConv.id, deletedCount });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
