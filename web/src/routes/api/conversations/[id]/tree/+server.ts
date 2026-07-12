import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import { computeSessionTree, isSessionHistoryProducerEnabled } from "$server/db/session-sync";
import type { RequestHandler } from "./$types";

/**
 * GET /api/conversations/:id/tree — the session-backed message tree + durable
 * leaf pointer for the rewind/branch UI (Sessions P4, design §4).
 *
 * Gated on the `sessions:historyProducer` flag: when OFF this returns 409 (the
 * session leaf is meaningless without the producer). That 409-vs-200 is ALSO
 * how the frontend learns the feature is enabled — the generic
 * `/api/settings/:key` endpoint is admin-only, but rewind must work for the
 * conversation OWNER regardless of role, so the feature's own owner-scoped
 * surface carries the flag signal (no new config channel). Fail-closed on an
 * unowned conversation (404), mirroring the sibling messages route.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const ownership = await resolveRootConversationForOwnership(params.id, user);
  if (!ownership) return errorJson(404, "Not found");

  if (!(await isSessionHistoryProducerEnabled())) {
    return errorJson(409, "Session history producer is disabled", { code: "session_producer_disabled" });
  }

  return json(await computeSessionTree(params.id));
};
