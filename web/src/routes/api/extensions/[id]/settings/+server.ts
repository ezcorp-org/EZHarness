import { json } from "@sveltejs/kit";
import { getExtension } from "$server/db/queries/extensions";
import { requireAuth } from "$server/auth/middleware";
import {
  getDeclaredDefaults,
  getUserSettings,
  resolveExtensionSettings,
} from "$server/db/queries/extension-settings";
import {
  probeSecretSettings,
  secretFieldEntries,
} from "$server/extensions/secret-settings";
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
      secrets: {},
      capabilities,
    });
  }

  // Secret fields are write-only: the response carries a bare per-field
  // `{ isSet }` existence probe. The value itself never appears in any
  // byte of this payload — `resolved` excludes secret keys by construction
  // (clampSettings drops them), and `userValues` is filtered below.
  const [userValues, resolved, secrets] = await Promise.all([
    getUserSettings(user.id, params.id),
    resolveExtensionSettings(params.id, user.id),
    probeSecretSettings(params.id, user.id, schema),
  ]);

  // Defense-in-depth: `getUserSettings` returns the RAW persisted blob
  // (write-time clamping is the normal guard). If a field's type ever
  // migrates text→secret, a stale plaintext persisted under the old type
  // would otherwise flow back to its owner here (and prefill the masked
  // input) until their next save rewrites the row — so strip every
  // secret-typed key on read.
  const secretKeys = new Set(secretFieldEntries(schema).map(([key]) => key));
  const safeUserValues = Object.fromEntries(
    Object.entries(userValues).filter(([key]) => !secretKeys.has(key)),
  );

  return json({
    schema,
    declaredDefaults: getDeclaredDefaults(schema),
    userValues: safeUserValues,
    resolved,
    secrets,
    capabilities,
  });
};
