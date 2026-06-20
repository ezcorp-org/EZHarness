import { json } from "@sveltejs/kit";
import { getExecutor } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getConversation } from "$server/db/queries/conversations";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const isAdmin = user.role === "admin";

  const executor = getExecutor();
  const projectId = url.searchParams.get("projectId") ?? undefined;
  const active = executor.listActiveAgentRuns(projectId);

  const rows = await Promise.all(
    active.map(async ({ run, conversationId }) => {
      const conv = await getConversation(conversationId);
      if (projectId && conv?.projectId !== projectId) return null;
      // Per-user ownership: non-admins only see active runs in conversations
      // they own. Without this any read-scoped user enumerates every tenant's
      // active runIds / agent names / conversation titles (cross-tenant IDOR).
      if (!isAdmin && !(await resolveRootConversationForOwnership(conversationId, user))) {
        return null;
      }
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
