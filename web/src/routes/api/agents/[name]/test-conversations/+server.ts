import { json } from "@sveltejs/kit";
import { getAgentConfigByName } from "$server/db/queries/agent-configs";
import { deleteConversation, getTestConversations } from "$server/db/queries/conversations";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

// Agent configs are shared, but each test conversation belongs to the user
// who ran it: list and delete only the caller's own.
async function ownTestConversations(agentConfigId: string, userId: string) {
  const conversations = await getTestConversations(agentConfigId);
  return conversations.filter((c) => c.userId === userId);
}

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const config = await getAgentConfigByName(params.name);
  if (!config) return errorJson(404, "Agent not found");

  return json(await ownTestConversations(config.id, user.id));
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const config = await getAgentConfigByName(params.name);
  if (!config) return errorJson(404, "Agent not found");

  let deleted = 0;
  for (const conv of await ownTestConversations(config.id, user.id)) {
    if (await deleteConversation(conv.id)) deleted++;
  }
  return json({ deleted });
};
