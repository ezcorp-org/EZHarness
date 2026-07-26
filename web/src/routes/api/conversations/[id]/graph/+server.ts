import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import { loadConversationGraph, loadTurnGraph } from "$server/runtime/chat-graph/load";
import type { RequestHandler } from "./$types";

/**
 * GET /api/conversations/:id/graph — the chat DAG.
 *
 *   - no `?turn=` → LEVEL 1, the conversation map: one node per user
 *     prompt, plus rewind / A-B-retry forks and sub-agent spawns.
 *   - `?turn=<userMessageId>` → LEVEL 2, that one turn's internals.
 *
 * Read-only by construction (the graph never writes, so the session-tree
 * invariant "never mutate parentMessageId" is trivially held).
 *
 * Ownership resolves against the ROOT of the `parentConversationId` chain,
 * exactly like the sibling `/tree` route, so a sub-conversation's owner can
 * open the graph of their own sub-chat. Every failure — unknown id, unowned
 * conversation, a `turn` that names a message of a DIFFERENT conversation —
 * collapses to an indistinguishable 404 (never 403), so the endpoint cannot
 * be used to probe the id space.
 *
 * Unlike `/tree` this does NOT 409 when the `sessions:historyProducer` flag
 * is off: the loader degrades to the flat `messages.parentMessageId` chain
 * and flags the payload `degraded: true`.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const ownership = await resolveRootConversationForOwnership(params.id, user);
  if (!ownership) return errorJson(404, "Not found");

  const turn = url.searchParams.get("turn");
  if (turn === null) return json(await loadConversationGraph(params.id));

  const graph = await loadTurnGraph(params.id, turn);
  if (!graph) return errorJson(404, "Not found");
  return json(graph);
};
