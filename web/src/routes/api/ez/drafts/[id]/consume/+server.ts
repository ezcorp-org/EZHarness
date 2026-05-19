/**
 * Phase 48 Wave 2 — POST /api/ez/drafts/[id]/consume.
 *
 * Dedicated consume sub-route for callers who prefer URL-shaped intent
 * over body-shaped action. Same semantics as POST /api/ez/drafts/[id]
 * with `{ action: "consume" }`: marks the draft as consumed if the
 * caller owns it and it hasn't expired. Idempotent — a second consume
 * returns the existing consumedAt timestamp (does not advance it).
 */
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { consumeDraft } from "$server/db/queries/ez-drafts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, locals }) => {
  try {
    const scopeErr = requireScope(locals, "chat");
    if (scopeErr) return scopeErr;
    const user = requireAuth(locals);

    const draftId = params.id;
    if (!draftId) return errorJson(400, "Draft id is required");

    const updated = await consumeDraft(draftId, user.id);
    if (!updated) return errorJson(404, "Draft not found, expired, or not owned by the requesting user");
    return json({
      id: updated.id,
      kind: updated.kind,
      consumedAt: updated.consumedAt,
      consumed: updated.consumedAt != null,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
