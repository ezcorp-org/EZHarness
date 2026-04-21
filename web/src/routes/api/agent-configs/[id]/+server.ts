import { json } from "@sveltejs/kit";
import * as agentConfigQueries from "$server/db/queries/agent-configs";
import { configToAgent } from "$server/runtime/config-to-agent";
import { requireAuth } from "$server/auth/middleware";
import { getExecutor } from "$lib/server/context";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const config = await agentConfigQueries.getAgentConfig(params.id);
  if (!config) return json({ error: "Not found" }, { status: 404 });
  if (config.userId && config.userId !== user.id) return json({ error: "Not found" }, { status: 404 });
  return json(config);
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const config = await agentConfigQueries.getAgentConfig(params.id);
  if (!config) return json({ error: "Not found" }, { status: 404 });
  if (config.userId && config.userId !== user.id) return json({ error: "Not found" }, { status: 404 });

  const body = await request.json();
  const updated = await agentConfigQueries.updateAgentConfig(params.id, body);
  if (!updated) return json({ error: "Not found" }, { status: 404 });

  // Re-register the agent
  const executor = getExecutor();
  const agentDef = configToAgent({
    name: updated.name,
    description: updated.description,
    capabilities: updated.capabilities as any,
    prompt: updated.prompt,
    inputSchema: updated.inputSchema as any,
    outputFormat: (updated.outputFormat as "text" | "json") ?? "text",
    provider: updated.provider as any,
    model: updated.model ?? undefined,
    temperature: updated.temperature ?? undefined,
    maxTokens: updated.maxTokens ?? undefined,
  });
  executor.registerAgent(agentDef);

  return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const config = await agentConfigQueries.getAgentConfig(params.id);
  if (!config) return json({ error: "Not found" }, { status: 404 });
  if (config.userId && config.userId !== user.id) return json({ error: "Not found" }, { status: 404 });

  await agentConfigQueries.deleteAgentConfig(params.id);
  getExecutor().unregisterAgent(config.name);

  return json({ ok: true });
};
