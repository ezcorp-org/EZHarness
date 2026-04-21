import { json } from "@sveltejs/kit";
import { getExtension, updateExtension, deleteExtension } from "$server/db/queries/extensions";
import { ExtensionRegistry } from "$server/extensions/registry";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const ext = await getExtension(params.id);
  if (!ext) return json({ error: "Not found" }, { status: 404 });
  return json(ext);
};

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const body = await request.json();
  const { enabled } = body;

  const ext = await getExtension(params.id);
  if (!ext) return json({ error: "Not found" }, { status: 404 });

  if (typeof enabled === "boolean") {
    // Enabling via PATCH is a back-door around POST /:id/activate — it skips
    // the admin-role check and the manifest-clamped permission review. Only
    // disabling is permitted here; enabling must go through /activate.
    if (enabled === true) {
      return json(
        { error: "Use POST /:id/activate to enable an extension" },
        { status: 400 },
      );
    }
    const updated = await updateExtension(params.id, { enabled });
    await ExtensionRegistry.getInstance().reload();
    return json(updated);
  }

  return json({ error: "No valid update fields provided" }, { status: 400 });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const ext = await getExtension(params.id);
  if (!ext) return json({ error: "Not found" }, { status: 404 });

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
