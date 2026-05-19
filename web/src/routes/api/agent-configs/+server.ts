import { json } from "@sveltejs/kit";
import * as agentConfigQueries from "$server/db/queries/agent-configs";
import { configToAgent } from "$server/runtime/config-to-agent";
import { requireAuth } from "$server/auth/middleware";
import { getExecutor } from "$lib/server/context";
import { createAgentConfigSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";
import { requireScope } from "$lib/server/security/api-keys";
import type { AgentConfig } from "$server/types";
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

  // createAgentConfig's declared parameter type (derived from
  // AgentConfig) is narrower than what createAgentConfigSchema
  // actually produces: description is required-string but the schema
  // leaves it optional (query layer defaults it to ""), and inputSchema
  // is declared as the stricter InputSchema (Record<string, InputField>)
  // where the schema allows Record<string, unknown>. Both gaps are
  // runtime-safe — the query normalizes shapes before insert — so we
  // narrow with a targeted parameter cast instead of a blanket `as any`.
  type CreateParam = Parameters<typeof agentConfigQueries.createAgentConfig>[0];
  const config = await agentConfigQueries.createAgentConfig({
    ...body,
    description: body.description ?? "",
    userId: user.id,
  } as CreateParam);

  // Register the agent with the executor
  const executor = getExecutor();
  // DB JSONB columns decode as string[] / Record<string, unknown>; the
  // AgentConfig shape demanded by configToAgent uses the narrower
  // AgentCapability[] / InputSchema / provider string. Casts are
  // structural widen-backs — the content was validated upstream by
  // createAgentConfigSchema and the query layer.
  const agentDef = configToAgent({
    name: config.name,
    description: config.description,
    capabilities: config.capabilities as AgentConfig["capabilities"],
    prompt: config.prompt,
    inputSchema: (config.inputSchema ?? undefined) as AgentConfig["inputSchema"],
    outputFormat: (config.outputFormat as "text" | "json") ?? "text",
    provider: config.provider ?? undefined,
    model: config.model ?? undefined,
    temperature: config.temperature ?? undefined,
    maxTokens: config.maxTokens ?? undefined,
  });
  executor.registerAgent(agentDef);

  return json(config, { status: 201 });
};
