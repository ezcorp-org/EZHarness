import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import * as modeQueries from "$server/db/queries/modes";
import { requireAuth } from "$server/auth/middleware";
import { updateModeSchema } from "../schema";
import { validationError } from "$lib/server/security/validation";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const mode = await modeQueries.getMode(params.id);
  if (!mode) return errorJson(404, "Not found");
  return json(mode);
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const existing = await modeQueries.getMode(params.id);
  if (!existing) return errorJson(404, "Not found");
  if (existing.builtin) return errorJson(403, "Cannot edit built-in modes");
  // sec-H3: fail-closed — unowned rows (null userId) are admin-only. The
  // `builtin` guard above does NOT cover this: `builtin` and `userId` are
  // independent columns (src/db/schema.ts:1459+) and `createMode` writes
  // `builtin: false, userId: data.userId ?? null` (src/db/queries/modes.ts:74-75),
  // so a non-builtin null-owner mode is representable — and was editable by
  // any authenticated user through the old `existing.userId &&` short-circuit.
  if (existing.userId !== user.id && user.role !== "admin") return errorJson(404, "Not found");

  const result = updateModeSchema.safeParse(await request.json());
  if (!result.success) return validationError(result.error);

  const updated = await modeQueries.updateMode(params.id, result.data);
  if (!updated) return errorJson(404, "Not found");
  return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const existing = await modeQueries.getMode(params.id);
  if (!existing) return errorJson(404, "Not found");
  if (existing.builtin) return errorJson(403, "Cannot delete built-in modes");
  // sec-H3: fail-closed — unowned rows (null userId) are admin-only (see PUT).
  if (existing.userId !== user.id && user.role !== "admin") return errorJson(404, "Not found");

  await modeQueries.deleteMode(params.id);
  return json({ ok: true });
};
