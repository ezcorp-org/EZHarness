import { json } from "@sveltejs/kit";
import { getExtension } from "$server/db/queries/extensions";
import { setSensitiveAlwaysAllow } from "$server/extensions/permissions";
import { requireAdmin, requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  // requireAdmin RETURNS the 403 Response; requireRole THREW one, which
  // SvelteKit surfaces as a 500 from a route handler. Role-only, so the
  // route's existing `extensions`-scope gate is unchanged.
  const adminErr = requireAdmin(locals);
  if (adminErr) return adminErr;
  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  const { operationType, action } = await request.json();

  if (!operationType || !["shell", "filesystem"].includes(operationType)) {
    return errorJson(400, "operationType must be 'shell' or 'filesystem'");
  }

  if (!action || !["allow_once", "always_allow", "deny"].includes(action)) {
    return errorJson(400, "action must be 'allow_once', 'always_allow', or 'deny'");
  }

  if (action === "always_allow") {
    await setSensitiveAlwaysAllow(params.id, operationType, true);
  }

  return json({ confirmed: action !== "deny" });
};
