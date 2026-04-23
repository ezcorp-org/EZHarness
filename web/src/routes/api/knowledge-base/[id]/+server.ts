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
  if (file.userId && file.userId !== user.id) return errorJson(404, "Knowledge base file not found");
  return json(file);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const file = await getKBFile(params.id);
  if (!file) return errorJson(404, "Knowledge base file not found");
  if (file.userId && file.userId !== user.id) return errorJson(404, "Knowledge base file not found");

  const deleted = await deleteKBFile(params.id);
  if (!deleted) return errorJson(404, "Knowledge base file not found");
  return new Response(null, { status: 204 });
};
