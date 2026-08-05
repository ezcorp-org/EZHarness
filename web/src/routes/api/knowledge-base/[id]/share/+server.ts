/**
 * Share a knowledge-base file with its project, and take it back.
 *
 * ## What this route exists for
 *
 * `user_id IS NULL` has always been the knowledge base's ONE sharing mechanism
 * — honoured by the list, by the detail route, and (since retrieval was scoped)
 * by `searchKBChunks` / `hasKBChunks` alike. Until this route there was no way
 * to *produce* such a row short of writing SQL. That was academic while
 * retrieval was project-wide; once it became per-user, a member's upload
 * reached nobody else unless it was ownerless, and nothing in the product could
 * make it ownerless. This is the missing verb.
 *
 * It adds NO new access signal. `POST` nulls `user_id`; `DELETE` puts it back.
 * Every predicate that decides who may read a KB row — including the ones in
 * `src/db/queries/knowledge-base.ts` that decide what the model is fed — is
 * untouched by this file and keeps working by construction.
 *
 * ## Who may do what
 *
 * The rule and its full rationale live in `src/memory/kb-sharing.ts`; this
 * route calls it rather than restating it, and so does the list route when it
 * tells the UI which buttons to draw. In summary:
 *
 * | verb                | who |
 * |---------------------|-----|
 * | `POST` (share)      | the file's CURRENT OWNER, who is a member of its project |
 * | `DELETE` (un-share) | the user who shared it, or an instance admin |
 *
 * Note there is deliberately **no admin override on `POST`**: an admin cannot
 * read another user's KB file (`GET [id]` 404s them), so they must not be able
 * to publish one to a project. `DELETE` admits them because un-sharing only
 * narrows exposure and restores the file to `sharedBy`, never to the actor.
 *
 * ## Why the refusals are shaped the way they are
 *
 * The sibling routes use 404 for "not yours" so a forbidden id is
 * indistinguishable from a missing one (sec-H3). That property is preserved
 * exactly where it still buys something:
 *
 *   - `POST` on someone else's OWNED file → **404**. The caller may not read
 *     that row, so the refusal must not confirm it exists.
 *   - `DELETE` on a SHARED file the caller may not un-share → **403** with a
 *     real message. A shared row is readable by every authenticated caller by
 *     definition, so there is no existence to protect and a 404 here would only
 *     lie to a user looking at a file in their own list.
 *   - `409` for the two "right file, wrong state" cases (already shared / not
 *     shared) — again only on rows the caller can already see.
 *
 * ## Deleting a file you have shared
 *
 * You cannot, directly: while `user_id` is NULL, `DELETE
 * /api/knowledge-base/[id]` is admin-only (sec-H3). That gate is intentionally
 * NOT relaxed here — "everyone may read it" must not become "anyone may destroy
 * it". Un-share first, then delete; both steps are authorized by `shared_by`.
 */
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";
import { getKBFile, shareKBFile, unshareKBFile } from "$server/db/queries/knowledge-base";
import { requireAuth, checkProjectRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { canUnshareKBFile, isKBFileShared } from "$server/memory/kb-sharing";

const NOT_FOUND = "Knowledge base file not found";

export const POST: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "write");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const file = await getKBFile(params.id);
  if (!file) return errorJson(404, NOT_FOUND);

  // Already ownerless. Safe to say so: a shared row is readable by everyone.
  if (isKBFileShared(file)) return errorJson(409, "File is already shared");

  // Owner only, and no admin bypass — see the header. Reached only for a row
  // with a non-null owner, so this 404 is the same one `GET [id]` gives.
  if (file.userId !== user.id) return errorJson(404, NOT_FOUND);

  // `project_id` is nullable in the schema. There is no project to share WITH.
  if (!file.projectId) return errorJson(409, "File is not attached to a project");

  // The membership model (PR #89). `checkProjectRole` lets instance admins
  // through, which is harmless here: the ownership test above already ran, so
  // the bypass can only help an admin share a file that is genuinely theirs.
  const gate = await checkProjectRole(locals, file.projectId, "member");
  if (gate instanceof Response) return gate;

  const shared = await shareKBFile(params.id, user.id);
  // Lost a race with a concurrent delete/share — the guarded UPDATE matched
  // nothing rather than publishing a row whose owner had changed.
  if (!shared) return errorJson(404, NOT_FOUND);
  return json(shared);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "write");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const file = await getKBFile(params.id);
  if (!file) return errorJson(404, NOT_FOUND);

  if (!isKBFileShared(file)) {
    // Your own file, just not shared → say so. Anyone else's → the standard
    // 404, because this route must not become an existence oracle for rows the
    // caller cannot read.
    return file.userId === user.id
      ? errorJson(409, "File is not shared")
      : errorJson(404, NOT_FOUND);
  }

  if (!canUnshareKBFile(file, user)) {
    // The row is shared, so the caller can already read it — 403 leaks nothing
    // and is the honest answer. Covers both "someone else shared it" and a
    // legacy ownerless row with no recorded sharer to restore.
    return errorJson(403, "Only the user who shared this file, or an admin, can un-share it");
  }

  // Back to the ORIGINAL owner, not to whoever asked. `canUnshareKBFile`
  // guarantees `sharedBy` is set, and the guarded UPDATE re-checks it.
  const restored = await unshareKBFile(params.id, file.sharedBy!);
  if (!restored) return errorJson(404, NOT_FOUND);
  return json(restored);
};
