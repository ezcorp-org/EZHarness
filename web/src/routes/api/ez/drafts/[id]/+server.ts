/**
 * Phase 48 Wave 2 — GET /api/ez/drafts/[id], POST /api/ez/drafts/[id] (consume).
 *
 * Drafts are produced by the propose_* Ez tools and redeemed when the
 * user opens the prefilled form (e.g. /new-project?prefill=<id>). This
 * endpoint lets the destination page hydrate form state from the draft
 * row and stamp `consumedAt` on submit.
 *
 * Authorization is double-keyed: the auth middleware gates the request
 * by user, and `getDraft(id, userId)` enforces ownership at the query
 * layer — a different user's draft id always returns undefined. Same
 * for expired or non-existent drafts.
 *
 * GET returns the draft's payload + status. POST is the consume action
 * (POST /api/ez/drafts/[id] with body `{ action: "consume" }` for MVP
 * symmetry — a /consume sub-route is omitted because we have just one
 * write verb).
 *
 * The plan calls out POST /api/ez/drafts/[id]/consume; we expose BOTH
 * shapes — the body-action shape AND the dedicated /consume sub-route
 * (separate file) — so existing form-submit handlers can pick whichever
 * is more convenient.
 */
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getDraft, consumeDraft } from "$server/db/queries/ez-drafts";
import type { RequestHandler } from "./$types";

function shapeDraft(row: { id: string; kind: string; payload: Record<string, unknown>; createdAt: Date; expiresAt: Date; consumedAt: Date | null }) {
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    consumed: row.consumedAt != null,
  };
}

export const GET: RequestHandler = async ({ params, locals }) => {
  try {
    const scopeErr = requireScope(locals, "read");
    if (scopeErr) return scopeErr;
    const user = requireAuth(locals);

    const draftId = params.id;
    if (!draftId) return errorJson(400, "Draft id is required");

    const row = await getDraft(draftId, user.id);
    if (!row) return errorJson(404, "Draft not found, expired, or not owned by the requesting user");
    return json(shapeDraft(row));
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
  try {
    const scopeErr = requireScope(locals, "chat");
    if (scopeErr) return scopeErr;
    const user = requireAuth(locals);

    const draftId = params.id;
    if (!draftId) return errorJson(400, "Draft id is required");

    // Body-action shape: `{ action: "consume" }`. Default action is consume
    // (the only write op this endpoint supports), so an empty body works
    // too — keeps form-submit handlers simple.
    let action = "consume";
    try {
      const text = await request.text();
      if (text.trim().length > 0) {
        const parsed = JSON.parse(text);
        if (typeof parsed?.action === "string") action = parsed.action;
      }
    } catch {
      return errorJson(400, "Invalid JSON body");
    }

    if (action !== "consume") {
      return errorJson(400, `Unknown action '${action}' — only 'consume' is supported`);
    }

    const updated = await consumeDraft(draftId, user.id);
    if (!updated) return errorJson(404, "Draft not found, expired, or not owned by the requesting user");
    return json(shapeDraft(updated));
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
