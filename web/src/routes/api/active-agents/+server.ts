import { json } from "@sveltejs/kit";
import { getExecutor } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getConversation } from "$server/db/queries/conversations";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  const executor = getExecutor();
  const projectId = url.searchParams.get("projectId") ?? undefined;
  const active = executor.listActiveAgentRuns(projectId);

  const rows = await Promise.all(
    active.map(async ({ run, conversationId }) => {
      const conv = await getConversation(conversationId);
      if (projectId && conv?.projectId !== projectId) return null;
      return {
        runId: run.id,
        agentName: run.agentName,
        conversationId,
        parentConversationId: conv?.parentConversationId ?? null,
        projectId: conv?.projectId ?? run.projectId ?? null,
        conversationTitle: conv?.title ?? null,
        startedAt: run.startedAt,
      };
    }),
  );

  return json(rows.filter((r) => r !== null));
};
