import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { legacyExtensionEndpoint } from "$lib/server/extensions/legacy-endpoint";
import { extensionControlError } from "$lib/server/extensions/control-errors";
import type { RequestHandler } from "./$types";

const retired: RequestHandler = async ({ params, locals }) => {
  const denial = requireScope(locals, "extensions");
  if (denial) return denial;
  try { requireAuth(locals); } catch (error) { return extensionControlError(error); }
  return legacyExtensionEndpoint(params.id);
};

export const GET = retired;
export const POST = retired;
