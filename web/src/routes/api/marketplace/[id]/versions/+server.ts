import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { listVersions } from "$server/db/queries/marketplace-versions";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const versions = await listVersions(params.id);
  return json(versions);
};
