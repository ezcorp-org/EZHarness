import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import { getTopics, getTopicState, getMessageWatermark } from "$server/db/queries/contexts";
import { detectTopics } from "$server/contexts/detect";
import { ContextsUnavailableError } from "$server/contexts/config";
import type { ConversationTopic, ConversationTopicState } from "$server/db/schema";
import { detectTopicsSchema } from "./schema";

/** Frozen response shape: only the client-relevant topic fields. */
function shapeTopics(topics: ConversationTopic[]) {
  return topics.map((t) => ({
    id: t.id,
    label: t.label,
    typeId: t.typeId,
    messageIds: t.messageIds,
  }));
}

/**
 * Staleness = the conversation has moved since the last analysis. Never
 * analyzed → stale iff there are any messages. Analyzed → stale when the
 * newest message id or the message count differs from the watermark.
 */
function computeStale(
  currentCount: number,
  currentLastId: string | null,
  state: ConversationTopicState | undefined,
): boolean {
  if (!state) return currentCount > 0;
  return currentCount !== state.messageCount || currentLastId !== state.lastMessageId;
}

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const ownership = await resolveRootConversationForOwnership(params.id, user);
  if (!ownership) return errorJson(404, "Not found");

  const [topics, state, watermark] = await Promise.all([
    getTopics(params.id),
    getTopicState(params.id),
    getMessageWatermark(params.id),
  ]);

  return json({
    topics: shapeTopics(topics),
    stale: computeStale(watermark.count, watermark.lastMessageId, state),
    analyzedAt: state ? state.analyzedAt.toISOString() : null,
  });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const ownership = await resolveRootConversationForOwnership(params.id, user);
  if (!ownership) return errorJson(404, "Not found");

  const parsed = detectTopicsSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return errorJson(400, "Invalid request body");

  try {
    const result = await detectTopics(params.id);
    return json({
      topics: shapeTopics(result.topics),
      stale: false,
      analyzedAt: result.analyzedAt,
    });
  } catch (err) {
    // Ladder exhausted → actionable 503 shown in the popover. Any other
    // error is a genuine fault → let SvelteKit surface it as a 500.
    if (err instanceof ContextsUnavailableError) return errorJson(503, err.message);
    throw err;
  }
};
