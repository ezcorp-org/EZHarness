import { json } from "@sveltejs/kit";
import { getConversation, getSubConversations } from "$server/db/queries/conversations";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  // sec-H3b-style ownership gate: fail-closed on unowned rows. Only the
  // caller who owns the parent conversation may enumerate sub-convs; an
  // admin can access any. Null-userId legacy rows are treated as owned
  // by nobody and thus are admin-only — matches the convention already
  // applied to tasks/team sub-routes (see
  // src/__tests__/security/h3b-conversation-subroutes-idor.test.ts).
  // Returns 404 (not 403) on mismatch to avoid leaking existence.
  const parent = await getConversation(params.id);
  if (!parent || (parent.userId !== user.id && user.role !== "admin")) {
    return errorJson(404, "Not found");
  }

  return json(await getSubConversations(params.id));
};
