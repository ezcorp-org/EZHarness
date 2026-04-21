import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getKBFile, deleteKBFile } from "$server/db/queries/knowledge-base";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const file = await getKBFile(params.id);
  if (!file) return json({ error: "Knowledge base file not found" }, { status: 404 });
  if (file.userId && file.userId !== user.id) return json({ error: "Knowledge base file not found" }, { status: 404 });
  return json(file);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const file = await getKBFile(params.id);
  if (!file) return json({ error: "Knowledge base file not found" }, { status: 404 });
  if (file.userId && file.userId !== user.id) return json({ error: "Knowledge base file not found" }, { status: 404 });

  const deleted = await deleteKBFile(params.id);
  if (!deleted) return json({ error: "Knowledge base file not found" }, { status: 404 });
  return new Response(null, { status: 204 });
};
