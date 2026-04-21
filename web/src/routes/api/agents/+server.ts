import { getExecutor } from "$lib/server/context";
import { listAgentConfigs } from "$server/db/queries/agent-configs";
import { requireAuth } from "$server/auth/middleware";
import { cacheableResponse } from "$server/lib/cache-utils";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const executor = getExecutor();
  const fileAgents = executor.listAgents();

  const dbConfigs = await listAgentConfigs(user.id);
  const dbConfigMap = new Map(dbConfigs.map((c) => [c.name, c]));
  const fileAgentNames = new Set(fileAgents.map((a) => a.name));

  const agents = fileAgents.map((a) => {
    const config = dbConfigMap.get(a.name);
    return {
      name: a.name,
      description: a.description,
      capabilities: a.capabilities,
      inputSchema: a.inputSchema,
      source: config ? "config" : "file",
      id: config?.id ?? null,
      prompt: config?.prompt ?? null,
      category: config?.category ?? null,
      shared: (config as any)?.shared ?? false,
      sharedBy: (config as any)?.sharedBy ?? undefined,
      sharedByName: (config as any)?.sharedByName ?? undefined,
      permission: (config as any)?.permission ?? undefined,
    };
  });

  // Include DB-only agents (not from files) -- owned and shared
  for (const config of dbConfigs) {
    if (!fileAgentNames.has(config.name)) {
      agents.push({
        name: config.name,
        description: config.description,
        capabilities: config.capabilities as any,
        inputSchema: config.inputSchema as any,
        source: "config",
        id: config.id,
        prompt: config.prompt,
        category: config.category ?? null,
        shared: (config as any).shared ?? false,
        sharedBy: (config as any).sharedBy,
        sharedByName: (config as any).sharedByName,
        permission: (config as any).permission ?? undefined,
      });
    }
  }

  return cacheableResponse(request, agents, { maxAge: 60, staleWhileRevalidate: 300 });
};
