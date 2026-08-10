// User "Modify" action: re-open an installed extension the requesting
// user CREATED (and an admin has flagged `modifiable`) as an editable
// author draft, then redirect the client to the existing editable
// preview at `/extensions/author?prefill=<draftId>`.
//
// Owner-scoped via the SHARED `reopenInstalledAsDraft` helper — the
// SAME authorization path the in-chat `ezcorp/drafts.reopen` RPC uses
// (creator + modifiable + not-bundled, opaque). There is intentionally
// NO admin-override edit path here: an admin's power is flipping the
// `modifiable` flag (POST [id]/modifiable), not editing others' code.

import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { reopenInstalledAsDraft, ReopenError } from "$server/extensions/reopen-extension";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;

  let user: ReturnType<typeof requireAuth>;
  try {
    user = requireAuth(locals);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  try {
    const { draftId, name } = await reopenInstalledAsDraft(params.id, user.id);
    return json({ draftId, name });
  } catch (err) {
    if (err instanceof ReopenError) {
      // Opaque: not-found / not-owned / flag-off / bundled all map
      // to 404 so a caller can never probe another user's
      // extensions. The other codes are genuine server-side
      // failures of an authorized request.
      if (err.code === "NOT_FOUND_OR_NOT_MODIFIABLE") {
        return errorJson(404, "Not found or not modifiable");
      }
      return errorJson(409, err.message);
    }
    return errorJson(500, "Failed to re-open extension");
  }
};
