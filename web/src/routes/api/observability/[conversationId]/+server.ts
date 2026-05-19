import { json } from "@sveltejs/kit";
import { getConversationObservability, getConversationStats } from "$server/db/queries/observability";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const { conversationId } = params;
  const [events, stats] = await Promise.all([
    getConversationObservability(conversationId),
    getConversationStats(conversationId),
  ]);
  return json({ events, stats });
};
