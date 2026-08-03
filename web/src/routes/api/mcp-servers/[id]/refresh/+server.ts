import { json } from "@sveltejs/kit";
import { ExtensionRegistry } from "$server/extensions/registry";
import { requireAdmin } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, locals }) => {
  // requireAdmin RETURNS the 403 Response; requireRole THREW one, which
  // SvelteKit surfaces as a 500 from a route handler. Role-only, so the
  // route's "no API-key scope gate" contract is unchanged.
  const adminErr = requireAdmin(locals);
  if (adminErr) return adminErr;
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
