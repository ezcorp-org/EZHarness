import { getExecutor } from "$lib/server/context";
import { listAgentConfigs } from "$server/db/queries/agent-configs";
import { requireAuth } from "$server/auth/middleware";
import { cacheableResponse } from "$server/lib/cache-utils";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

/** Handler-local view of a row returned by `listAgentConfigs`. That
 *  query returns owned rows (`DbAgentConfig`) spliced with shared rows
 *  from `getSharedAgentsForUser` (which attach `sharedBy/sharedByName/
 *  permission`). The query's declared return type is narrower than
 *  what actually comes back from the shared branch; we accept the full
 *  shape here so the response can surface the share metadata without
 *  a blanket `as any`. */
type ListedAgentConfig = Awaited<ReturnType<typeof listAgentConfigs>>[number] & {
  permission?: "read" | "edit";
};

export const GET: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const executor = getExecutor();
  const fileAgents = executor.listAgents();

  const dbConfigs: ListedAgentConfig[] = await listAgentConfigs(user.id);
  const dbConfigMap = new Map<string, ListedAgentConfig>(
    dbConfigs.map((c) => [c.name, c]),
  );
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
      shared: config?.shared ?? false,
      sharedBy: config?.sharedBy ?? undefined,
      sharedByName: config?.sharedByName ?? undefined,
      permission: config?.permission ?? undefined,
    };
  });

  // Include DB-only agents (not from files) -- owned and shared
  for (const config of dbConfigs) {
    if (!fileAgentNames.has(config.name)) {
      agents.push({
        name: config.name,
        description: config.description,
        // DB JSONB columns are declared as string[] / Record<string, unknown>;
        // the response shape inherits whatever `fileAgents.map` produced
        // (AgentCapability[] / InputSchema). These are structurally compatible
        // (string[] ⊇ AgentCapability[]) so the cast is a widen-back.
        capabilities: config.capabilities as typeof agents[number]["capabilities"],
        inputSchema: config.inputSchema as typeof agents[number]["inputSchema"],
        source: "config",
        id: config.id,
        prompt: config.prompt,
        category: config.category ?? null,
        shared: config.shared ?? false,
        sharedBy: config.sharedBy,
        sharedByName: config.sharedByName,
        permission: config.permission ?? undefined,
      });
    }
  }

  return cacheableResponse(request, agents, { maxAge: 60, staleWhileRevalidate: 300 });
};
