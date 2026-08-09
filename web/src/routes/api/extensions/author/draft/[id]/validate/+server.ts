/**
 * `/api/extensions/author/draft/[id]/validate` — run the host's FULL
 * acceptance gate against a draft.
 *
 * This endpoint used to run manifest validation only, while install
 * hard-gated on `verifyExtension` (manifest + a sandboxed `smokeTest`
 * round-trip). Break the smokeTest in the editor and you got a green
 * "Manifest valid. Ready to install." followed by a 422 on Install —
 * the button lied about the only question it answers. It now calls the
 * SAME `runAuthorAcceptanceGate` the install pipeline calls, and
 * returns the same `{ ok, pass, steps, errors }` shape the in-chat
 * `validate_extension` tool returns, so all three surfaces agree.
 *
 * Status codes are unchanged: 200 on success OR validation failure,
 * 4xx only on auth/lookup errors.
 */
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getDraft, getExtensionAuthorDraftDir } from "$server/db/queries/ez-drafts";
import { runAuthorAcceptanceGate } from "$server/extensions/author-gate";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, locals }) => {
  try {
    const scopeErr = requireScope(locals, "chat");
    if (scopeErr) return scopeErr;
    const user = requireAuth(locals);

    const draftId = params.id;
    if (!draftId) return errorJson(400, "Draft id is required");
    if (!/^[a-zA-Z0-9_-]+$/.test(draftId)) return errorJson(400, "Invalid draftId");

    const row = await getDraft(draftId, user.id);
    if (!row)
      return errorJson(404, "Draft not found, expired, or not owned by the requesting user");
    if (row.kind !== "extension") return errorJson(400, "Draft is not an extension draft");

    // The scaffold type on the draft row selects whether the sandboxed
    // round-trip is required — exactly the selector install uses, read
    // from the same place (`payload.type`).
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const draftType = typeof payload.type === "string" ? payload.type : "";

    const dir = getExtensionAuthorDraftDir(draftId, user.id);
    const result = await runAuthorAcceptanceGate({ draftDir: dir, draftType });

    return json({
      ok: result.ok,
      // `pass` mirrors `ok` for parity with the in-chat tool's result
      // shape (`{ ok, pass, steps }`); both are the same verdict.
      pass: result.ok,
      steps: result.steps,
      errors: result.errors,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    return errorJson(500, e instanceof Error ? e.message : "Validate failed");
  }
};
