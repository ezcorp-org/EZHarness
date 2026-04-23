import { json } from "@sveltejs/kit";
import { z } from "zod";
import * as convQueries from "$server/db/queries/conversations";
import { getActiveRun } from "$server/db/queries/active-runs";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { validationError } from "$lib/server/security/validation";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

const patchMessageSchema = z.object({
  content: z.string().min(1, "Content is required").max(100_000),
});

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conversationId = params.id;
  const messageId = params.mid;

  const conv = await convQueries.getConversation(conversationId);
  if (!conv) return errorJson(404, "Not found");
  if (conv.userId !== user.id && user.role !== "admin") {
    return errorJson(404, "Not found");
  }

  // Reject edits while a run is actively streaming into this conversation —
  // the executor may be appending to a message row that's about to change
  // under its feet, which produces mangled transcripts.
  const active = await getActiveRun(conversationId);
  if (active) {
    return errorJson(409, "Conversation has an active run; finish or cancel it first");
  }

  const parsed = patchMessageSchema.safeParse(await request.json());
  if (!parsed.success) return validationError(parsed.error);

  const updated = await convQueries.updateMessageContent(conversationId, messageId, parsed.data.content);
  if (!updated) return errorJson(404, "Message not found in this conversation");

  return json(updated);
};
