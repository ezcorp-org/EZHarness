import { json } from "@sveltejs/kit";
import { ExtensionRegistry } from "$server/extensions/registry";
import { checkRole } from "$server/auth/middleware";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, locals }) => {
  // F2: admin ROLE *and* (for key principals) the `admin` SCOPE — see the
  // install route. Refresh re-connects to the configured MCP server, so it
  // is an instance-state action, not a read. Returns its denial like #84's
  // `requireAdmin`; the added scope axis is the deliberate difference.
  const admin = checkRole(locals, "admin");
  if (admin instanceof Response) return admin;
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
