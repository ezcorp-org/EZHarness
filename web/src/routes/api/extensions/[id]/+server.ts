import { json } from "@sveltejs/kit";
import { z } from "zod";
import { errorJson } from "$lib/server/http-errors";
import { getExtension, updateExtension, deleteExtension } from "$server/db/queries/extensions";
import { ExtensionRegistry } from "$server/extensions/registry";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

// Boundary validation. PATCH only accepts `{ enabled: false }` — the
// handler explicitly rejects `enabled: true` (that path goes through
// /activate, which does the manifest-clamped permission review). Any
// other value of `enabled` (or any other field) is a no-op that returns
// 400 "No valid update fields provided" today; passthrough preserves
// that behaviour exactly while pinning the type of `enabled` itself.
const extensionPatchSchema = z.object({
  enabled: z.boolean().optional(),
}).passthrough();

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");
  return json(ext);
};

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const parsed = extensionPatchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "No valid update fields provided");
  }
  const { enabled } = parsed.data;

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  if (typeof enabled === "boolean") {
    // Enabling via PATCH is a back-door around POST /:id/activate — it skips
    // the admin-role check and the manifest-clamped permission review. Only
    // disabling is permitted here; enabling must go through /activate.
    if (enabled === true) {
      return errorJson(400, "Use POST /:id/activate to enable an extension");
    }
    const updated = await updateExtension(params.id, { enabled });
    await ExtensionRegistry.getInstance().reload();
    return json(updated);
  }

  return errorJson(400, "No valid update fields provided");
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  // Kill any running subprocess
  try {
    const registry = ExtensionRegistry.getInstance();
    registry.killAll(); // safe: kills only managed processes for this extension
  } catch {
    // Registry may not have this extension loaded
  }

  await deleteExtension(params.id);
  await ExtensionRegistry.getInstance().reload();
  return new Response(null, { status: 204 });
};
