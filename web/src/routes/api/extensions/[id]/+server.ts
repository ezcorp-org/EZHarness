import { json } from "@sveltejs/kit";
import { getExtensionByRef } from "$server/db/queries/extensions";
import { redactExtensionSecrets } from "$server/extensions/mcp-secret-redaction";
import { requireAuth, checkRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { getExtensionLifecycle } from "$server/extensions/extension-lifecycle-service";
import { extensionControlError } from "$lib/server/extensions/control-errors";
import { legacyExtensionEndpoint } from "$lib/server/extensions/legacy-endpoint";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const ext = await getExtensionByRef(params.id);
  if (!ext) return errorJson(404, "Not found");
  // #205: `read` scope + any member role reaches this, and an MCP row's
  // manifest carries the connection. The list sibling has always scrubbed;
  // this single-row read had not, which made it the widest MCP credential
  // read in the app. `redactExtensionSecrets` is a no-op for non-MCP rows.
  return json(redactExtensionSecrets(ext));
};

async function mutate(event: Parameters<RequestHandler>[0], action: "disable" | "uninstall"): Promise<Response> {
  try {
    const denial = requireScope(event.locals, "extensions");
    if (denial) return denial;
    const user = checkRole(event.locals, "admin");
    if (user instanceof Response) return user;
    const lifecycle = await getExtensionLifecycle();
    const actor = { principalId: user.id, scope: "global", kind: event.locals.authMethod === "session" ? "human" as const : "agent" as const };
    try { await lifecycle.inspect(actor, event.params.id); }
    catch (error) {
      if (await getExtensionByRef(event.params.id)) return legacyExtensionEndpoint();
      throw error;
    }
    await lifecycle[action](actor, event.params.id);
    return action === "uninstall" ? new Response(null, { status: 204 }) : json(await getExtensionByRef(event.params.id));
  } catch (error) { return extensionControlError(error); }
}

export const PATCH: RequestHandler = async (event) => {
  const body: unknown = await event.request.json().catch(() => null);
  if (!body || typeof body !== "object" || !("enabled" in body)) return errorJson(400, "Provide enabled:false");
  if (body.enabled !== false) return legacyExtensionEndpoint();
  return mutate(event, "disable");
};

export const DELETE: RequestHandler = async (event) => {
  if (event.url.searchParams.get("purgeData") === "1") return errorJson(400, "Release uninstall preserves data; explicit data retention review is required");
  return mutate(event, "uninstall");
};
