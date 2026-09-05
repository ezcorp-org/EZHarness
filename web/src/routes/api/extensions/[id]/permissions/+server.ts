import { json } from "@sveltejs/kit";
import { getExtensionByRef } from "$server/db/queries/extensions";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { legacyExtensionEndpoint } from "$lib/server/extensions/legacy-endpoint";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const denial = requireScope(locals, "read");
  if (denial) return denial;
  requireAuth(locals);
  const extension = await getExtensionByRef(params.id);
  if (!extension) return errorJson(404, "Not found");
  return json(extension.grantedPermissions);
};

export const PUT: RequestHandler = async ({ params, locals }) => {
  const denial = requireScope(locals, "extensions");
  if (denial) return denial;
  requireAuth(locals);
  return legacyExtensionEndpoint(params.id);
};
