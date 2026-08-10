import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";
import { getKBFile, deleteKBFile } from "$server/db/queries/knowledge-base";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const file = await getKBFile(params.id);
  if (!file) return errorJson(404, "Knowledge base file not found");
  // ── KB-SHARED-NULL-OWNER — the detail half of a two-sided read contract ──
  // Deliberately permissive on `userId IS NULL`: ownerless rows are SHARED, and
  // this check must stay semantically identical to the list filter in
  // `../+server.ts` (GET), which is where the full rationale lives. Tightening
  // only this side produces a list-but-404 — a file the user can see and cannot
  // open. Both sides are pinned as ONE invariant by
  // `src/__tests__/security/kb-ownerless-rows-are-shared.test.ts`; that suite
  // fails if either side moves without the other.
  //
  // Note the asymmetry with DELETE below and treat it as intentional: sharing
  // is read-only. A null owner grants READ to everyone, never destruction.
  if (file.userId && file.userId !== user.id)
    return errorJson(404, "Knowledge base file not found");
  return json(file);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "write");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const file = await getKBFile(params.id);
  if (!file) return errorJson(404, "Knowledge base file not found");
  // sec-H3: fail-closed — unowned rows (null userId) are admin-only. The
  // previous `file.userId && …` short-circuited on a null owner, so ANY
  // authenticated user could delete an unowned file. 404 (not 403) is
  // deliberate and matches /api/memories/[id]: a forbidden id must be
  // indistinguishable from a missing one so the route is not an existence
  // oracle. `POST /api/knowledge-base` always stamps `userId` (../+server.ts:80),
  // so null-owner rows are legacy/system rows only.
  if (file.userId !== user.id && user.role !== "admin") {
    return errorJson(404, "Knowledge base file not found");
  }

  const deleted = await deleteKBFile(params.id);
  if (!deleted) return errorJson(404, "Knowledge base file not found");
  return new Response(null, { status: 204 });
};
