import { json } from "@sveltejs/kit";
import * as agentConfigQueries from "$server/db/queries/agent-configs";
import { configToAgent } from "$server/runtime/config-to-agent";
import { requireAuth } from "$server/auth/middleware";
import { getExecutor } from "$lib/server/context";
import { createAgentConfigSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  return json(await agentConfigQueries.listAgentConfigs(user.id));
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const result = createAgentConfigSchema.safeParse(await request.json());
  if (!result.success) {
    return validationError(result.error);
  }
  const body = result.data;

  const config = await agentConfigQueries.createAgentConfig({ ...body, userId: user.id } as any);

  // Register the agent with the executor
  const executor = getExecutor();
  const agentDef = configToAgent({
    name: config.name,
    description: config.description,
    capabilities: config.capabilities as any,
    prompt: config.prompt,
    inputSchema: config.inputSchema as any,
    outputFormat: (config.outputFormat as "text" | "json") ?? "text",
    provider: config.provider as any,
    model: config.model ?? undefined,
    temperature: config.temperature ?? undefined,
    maxTokens: config.maxTokens ?? undefined,
  });
  executor.registerAgent(agentDef);

  return json(config, { status: 201 });
};
