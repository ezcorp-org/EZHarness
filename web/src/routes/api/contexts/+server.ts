import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { searchContexts } from "$server/db/queries/contexts";

/** Parse a query param to a non-negative int, or undefined when absent /
 *  non-numeric (the query layer then applies its own default + clamp). */
function intParam(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  // Saved contexts are per-user. A non-admin sees ONLY their own rows; an
  // admin gets the org-wide management view (mirrors /api/memories).
  const isAdmin = user.role === "admin";
  const projectId = url.searchParams.get("projectId") ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;
  const typeId = url.searchParams.get("typeId") ?? undefined;

  const { contexts, total } = await searchContexts({
    ...(isAdmin ? {} : { userId: user.id }),
    projectId,
    search,
    typeId,
    limit: intParam(url.searchParams.get("limit")),
    offset: intParam(url.searchParams.get("offset")),
  });

  return json({
    contexts: contexts.map((c) => ({
      id: c.id,
      topicLabel: c.topicLabel,
      typeId: c.typeId,
      title: c.title,
      content: c.content,
      conversationId: c.conversationId,
      model: c.model,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
    total,
  });
};
