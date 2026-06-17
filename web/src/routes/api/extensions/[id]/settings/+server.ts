import { json } from "@sveltejs/kit";
import { getExtension } from "$server/db/queries/extensions";
import { requireAuth } from "$server/auth/middleware";
import {
  getDeclaredDefaults,
  getUserSettings,
  resolveExtensionSettings,
} from "$server/db/queries/extension-settings";
import { getHeldCapabilities } from "$server/search/policy";
import { errorJson } from "$lib/server/http-errors";
import type { ExtensionManifestV2, ExtensionPermissions } from "$server/extensions/types";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const user = requireAuth(locals);
  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  // §5.2 — host-capability schemas + resolved effective policy for every
  // capability the extension HOLDS (v1: search). Instance-wide (not
  // per-user), so safe to return to any authed viewer; the override WRITE
  // is admin-gated via the permissions route. `[]` when none held.
  const capabilities = await getHeldCapabilities(
    ext.grantedPermissions as ExtensionPermissions | null,
  );

  const manifest = ext.manifest as ExtensionManifestV2 | null;
  const schema = manifest?.settings;
  if (!schema) {
    // An extension with no per-user settings can still hold a capability
    // — return the capabilities payload alongside the empty schema.
    return json({
      schema: null,
      declaredDefaults: {},
      userValues: {},
      resolved: {},
      capabilities,
    });
  }

  const [userValues, resolved] = await Promise.all([
    getUserSettings(user.id, params.id),
    resolveExtensionSettings(params.id, user.id),
  ]);

  return json({
    schema,
    declaredDefaults: getDeclaredDefaults(schema),
    userValues,
    resolved,
    capabilities,
  });
};
