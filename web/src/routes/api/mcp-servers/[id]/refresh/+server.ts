import { json } from "@sveltejs/kit";
import { ExtensionRegistry } from "$server/extensions/registry";
import { requireRole } from "$server/auth/middleware";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, locals }) => {
  requireRole(locals, "admin");
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
