/**
 * Phase 48 Wave 2 — GET/POST /api/ez/conversation
 *
 * Find-or-create entrypoint for the user's single Ez conversation. The
 * floating Ez panel calls this on first open and stores the returned
 * id in component state for the rest of the session. Both verbs are
 * idempotent — POST is a no-op alias for GET so a future cache layer
 * doesn't have to special-case "creating"; the server is always the
 * source of truth.
 *
 * Uniqueness is enforced at the DB by the partial index
 * `conversations_user_ez_unique` (Wave 1). This handler simply forwards
 * to `getOrCreateEzConversation(userId)`, which handles the lookup-then-
 * insert race by retrying the SELECT on a unique-constraint collision.
 *
 * Auth: requires the standard chat scope (read suffices for both verbs
 * because creation here is a read-shaped find-or-create).
 */
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getOrCreateEzConversation } from "$server/db/queries/conversations";
import { logger } from "$server/logger";
import type { RequestHandler } from "./$types";

const log = logger.child("api.ez.conversation");

async function findOrCreate(locals: App.Locals): Promise<Response> {
  // requireAuth throws a 401 Response when locals.user is missing —
  // the outer try/catch turns that into a normal return so the handler
  // contract is "always returns a Response" rather than "sometimes
  // throws Response, sometimes returns Response", which trips up
  // unit-test harnesses that assert on the returned value.
  try {
    const scopeErr = requireScope(locals, "read");
    if (scopeErr) return scopeErr;
    const user = requireAuth(locals);
    try {
      const conv = await getOrCreateEzConversation(user.id);
      return json({
        conversationId: conv.id,
        kind: conv.kind,
        modeId: conv.modeId,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
      });
    } catch (err) {
      log.warn("getOrCreateEzConversation failed", { userId: user.id, error: String(err) });
      return errorJson(500, "Failed to resolve Ez conversation");
    }
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

export const GET: RequestHandler = async ({ locals }) => findOrCreate(locals);
export const POST: RequestHandler = async ({ locals }) => findOrCreate(locals);
