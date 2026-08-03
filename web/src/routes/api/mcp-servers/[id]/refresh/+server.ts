import { json } from "@sveltejs/kit";
import { ExtensionRegistry } from "$server/extensions/registry";
import { requireAdmin, requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, locals }) => {
  // F2: admin ROLE *and* (for key principals) the `admin` SCOPE — see the
  // install route. Refresh re-connects to the configured MCP server, so it
  // is an instance-state action, not a read.
  const adminErr = requireAdmin(locals);
  if (adminErr) return adminErr;
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  const id = params.id;
  if (!id) return errorJson(400, "id required");

  try {
    const tools = await ExtensionRegistry.getInstance().refreshMcpTools(id);
    return json({ id, tools });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Refresh failed";
    return errorJson(502, message);
  }
};
