import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import { getTopic } from "$server/db/queries/contexts";
import { extractContext } from "$server/contexts/extract";
import { ContextsUnavailableError } from "$server/contexts/config";
import { extractContextSchema } from "./schema";

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const ownership = await resolveRootConversationForOwnership(params.id, user);
  if (!ownership) return errorJson(404, "Not found");

  const parsed = extractContextSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return errorJson(400, "Invalid request body");

  // Topic must belong to THIS conversation (the query scopes by both ids), so
  // a topic id from another conversation 404s instead of extracting.
  const topic = await getTopic(params.id, params.topicId);
  if (!topic) return errorJson(404, "Topic not found");

  try {
    const saved = await extractContext({
      conversationId: params.id,
      topic: { label: topic.label, typeId: topic.typeId, messageIds: topic.messageIds },
      userId: user.id,
      projectId: ownership.conv.projectId,
    });
    return json({
      context: {
        id: saved.id,
        topicLabel: saved.topicLabel,
        typeId: saved.typeId,
        title: saved.title,
        content: saved.content,
        model: saved.model,
        updatedAt: saved.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof ContextsUnavailableError) return errorJson(503, err.message);
    throw err;
  }
};
