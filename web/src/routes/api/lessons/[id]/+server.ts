import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import {
	deleteLessonAsOwner,
	getLessonByIdForOwnerCheck,
	updateLessonVisibilityAsOwner,
} from "$server/db/queries/lessons";
import type { RequestHandler } from "./$types";

/**
 * DELETE /api/lessons/[id]
 *
 * Owner-gated hard delete. 204 on success, 404 when row not found OR
 * not owned by the requesting user (the two cases are intentionally
 * indistinguishable to prevent id enumeration).
 *
 * No soft-delete column (v1.5 contract). v2 may add one if usage data
 * shows users want restore.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	const user = requireAuth(locals);
	const id = params.id;
	if (!id) return errorJson(400, "Missing id");
	const deleted = await deleteLessonAsOwner(id, user.id);
	if (!deleted) return errorJson(404, "Lesson not found");
	return new Response(null, { status: 204 });
};

/**
 * PATCH /api/lessons/[id]
 * Body: `{ "visibility": "user" | "project" | "global" }`
 *
 * Owner-gated visibility promotion. Monotonic only:
 *   user → project | global
 *   project → global
 *
 * Status codes:
 *   - 200: promotion applied (or no-op same-visibility), returns row
 *   - 400: missing/invalid `visibility` field in body
 *   - 404: row not found OR not owned by caller (collapsed)
 *   - 409: backward transition attempted by the actual owner
 *
 * The 404-vs-409 disambiguation needs a second read. The query helper
 * `updateLessonVisibilityAsOwner` returns null in BOTH "not owned" and
 * "backward" cases (so it can't be used as a 409 signal alone), so we
 * re-fetch via `getLessonByIdForOwnerCheck` (read-only, ignores owner)
 * to decide between the two responses.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	const user = requireAuth(locals);
	const id = params.id;
	if (!id) return errorJson(400, "Missing id");

	const body = (await request.json().catch(() => null)) as { visibility?: unknown } | null;
	const next = body?.visibility;
	if (next !== "user" && next !== "project" && next !== "global") {
		return errorJson(400, "visibility must be 'user' | 'project' | 'global'");
	}

	const updated = await updateLessonVisibilityAsOwner(id, user.id, next);
	if (updated) return json(updated);

	// `updated === null` means: row missing, owner mismatch, OR backward
	// transition. Disambiguate by reading without the owner filter — if
	// the row exists AND belongs to this user, the only remaining cause
	// is the backward-transition guard (409). Otherwise it's 404 (we do
	// NOT 403 on owner mismatch — that would leak existence by id).
	const existing = await getLessonByIdForOwnerCheck(id);
	if (!existing) return errorJson(404, "Lesson not found");
	if (existing.ownerId !== user.id) return errorJson(404, "Lesson not found");
	return errorJson(409, "Visibility ladder is monotonic — cannot demote");
};
