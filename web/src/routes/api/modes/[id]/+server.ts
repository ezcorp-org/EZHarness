import { json } from "@sveltejs/kit";
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
  if (!mode) return json({ error: "Not found" }, { status: 404 });
  return json(mode);
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const existing = await modeQueries.getMode(params.id);
  if (!existing) return json({ error: "Not found" }, { status: 404 });
  if (existing.builtin) return json({ error: "Cannot edit built-in modes" }, { status: 403 });
  if (existing.userId && existing.userId !== user.id) return json({ error: "Not found" }, { status: 404 });

  const result = updateModeSchema.safeParse(await request.json());
  if (!result.success) return validationError(result.error);

  const updated = await modeQueries.updateMode(params.id, result.data);
  if (!updated) return json({ error: "Not found" }, { status: 404 });
  return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const existing = await modeQueries.getMode(params.id);
  if (!existing) return json({ error: "Not found" }, { status: 404 });
  if (existing.builtin) return json({ error: "Cannot delete built-in modes" }, { status: 403 });
  if (existing.userId && existing.userId !== user.id) return json({ error: "Not found" }, { status: 404 });

  await modeQueries.deleteMode(params.id);
  return json({ ok: true });
};
