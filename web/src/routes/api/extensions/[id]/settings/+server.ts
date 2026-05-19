import { json } from "@sveltejs/kit";
import { getExtension } from "$server/db/queries/extensions";
import { requireAuth } from "$server/auth/middleware";
import {
  getDeclaredDefaults,
  getUserSettings,
  resolveExtensionSettings,
} from "$server/db/queries/extension-settings";
import { errorJson } from "$lib/server/http-errors";
import type { ExtensionManifestV2 } from "$server/extensions/types";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const user = requireAuth(locals);
  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  const manifest = ext.manifest as ExtensionManifestV2 | null;
  const schema = manifest?.settings;
  if (!schema) {
    return json({
      schema: null,
      declaredDefaults: {},
      userValues: {},
      resolved: {},
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
  });
};
