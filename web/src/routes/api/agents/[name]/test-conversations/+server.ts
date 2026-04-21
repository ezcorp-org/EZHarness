import { json } from "@sveltejs/kit";
import { getAgentConfigByName } from "$server/db/queries/agent-configs";
import { deleteTestConversations, getTestConversations } from "$server/db/queries/conversations";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const config = await getAgentConfigByName(params.name);
  if (!config) return json({ error: "Agent not found" }, { status: 404 });

  const conversations = await getTestConversations(config.id);
  return json(conversations);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const config = await getAgentConfigByName(params.name);
  if (!config) return json({ error: "Agent not found" }, { status: 404 });

  const deleted = await deleteTestConversations(config.id);
  return json({ deleted });
};
