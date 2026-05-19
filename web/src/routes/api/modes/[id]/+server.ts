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
  if (existing.userId && existing.userId !== user.id) return errorJson(404, "Not found");

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
  if (existing.userId && existing.userId !== user.id) return errorJson(404, "Not found");

  await modeQueries.deleteMode(params.id);
  return json({ ok: true });
};
