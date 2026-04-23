import { json } from "@sveltejs/kit";
import * as convQueries from "$server/db/queries/conversations";
import { getAgentConfig } from "$server/db/queries/agent-configs";
import { requireAuth } from "$server/auth/middleware";
import { createConversationSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return errorJson(400, "projectId required");

  const search = url.searchParams.get("search");
  if (search) {
    return json(await convQueries.searchConversations(projectId, search, user.id));
  }

  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");
  const limit = limitParam !== null ? Math.min(Math.max(parseInt(limitParam, 10) || 0, 1), 200) : undefined;
  const offset = offsetParam !== null ? Math.max(parseInt(offsetParam, 10) || 0, 0) : undefined;

  return json(await convQueries.listConversations(projectId, user.id, { limit, offset }));
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const result = createConversationSchema.safeParse(await request.json());
  if (!result.success) {
    return validationError(result.error);
  }
  const body = result.data;

  let systemPrompt: string | undefined;
  let title: string | undefined = body.title;

  if (body.agentConfigId) {
    const agentConfig = await getAgentConfig(body.agentConfigId);
    if (!agentConfig) {
      return errorJson(404, "Agent config not found");
    }
    systemPrompt = agentConfig.prompt;
    if (!title) title = `Chat with ${agentConfig.name}`;
  }

  const conv = await convQueries.createConversation(body.projectId, {
    title,
    model: body.model,
    provider: body.provider,
    agentConfigId: body.agentConfigId,
    systemPrompt,
    test: body.test,
    userId: user.id,
    parentConversationId: body.parentConversationId,
    parentMessageId: body.parentMessageId,
  });
  return json(conv, { status: 201 });
};
