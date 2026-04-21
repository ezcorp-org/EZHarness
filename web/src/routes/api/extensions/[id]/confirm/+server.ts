import { json } from "@sveltejs/kit";
import { getExtension } from "$server/db/queries/extensions";
import { setSensitiveAlwaysAllow } from "$server/extensions/permissions";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const ext = await getExtension(params.id);
  if (!ext) return json({ error: "Not found" }, { status: 404 });

  const { operationType, action } = await request.json();

  if (!operationType || !["shell", "filesystem"].includes(operationType)) {
    return json({ error: "operationType must be 'shell' or 'filesystem'" }, { status: 400 });
  }

  if (!action || !["allow_once", "always_allow", "deny"].includes(action)) {
    return json({ error: "action must be 'allow_once', 'always_allow', or 'deny'" }, { status: 400 });
  }

  if (action === "always_allow") {
    await setSensitiveAlwaysAllow(params.id, operationType, true);
  }

  return json({ confirmed: action !== "deny" });
};
