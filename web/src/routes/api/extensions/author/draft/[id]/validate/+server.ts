import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { legacyExtensionEndpoint } from "$lib/server/extensions/legacy-endpoint";
import { extensionControlError } from "$lib/server/extensions/control-errors";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals }) => {
  const denial = requireScope(locals, "chat");
  if (denial) return denial;
  try { requireAuth(locals); } catch (error) { return extensionControlError(error); }
  return legacyExtensionEndpoint();
};
