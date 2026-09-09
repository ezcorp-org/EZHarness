import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { legacyExtensionEndpoint } from "$lib/server/extensions/legacy-endpoint";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals }) => {
  const denial = requireScope(locals, "extensions");
  if (denial) return denial;
  requireAuth(locals);
  return legacyExtensionEndpoint();
};
