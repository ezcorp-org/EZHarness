import { getExtensionByName, listExtensions, redactExtensionSecrets } from "$server/db/queries/extensions";
import { withListFlags, withListFlagsAll } from "$server/extensions/list-flags";
import { requireAuth } from "$server/auth/middleware";
import { cacheableResponse } from "$server/lib/cache-utils";
import { requireScope } from "$lib/server/security/api-keys";
import { legacyExtensionEndpoint } from "$lib/server/extensions/legacy-endpoint";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ request, url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  // `?name=<exact>` short-circuits the full list — used by the
  // browser-side resolved-settings store to look up an extension's id
  // by manifest name. Filtering server-side avoids shipping the full
  // list on every cold-start lookup.
  // Every row is served with its manifest — strip MCP transport secrets
  // (headers/env) so a read-scope member can never exfiltrate a bearer token /
  // API key. New installs already store a redacted manifest at rest; this also
  // scrubs any legacy row whose manifest still carries plaintext.
  const nameFilter = url.searchParams.get("name");
  if (nameFilter !== null) {
    const ext = await getExtensionByName(nameFilter);
    return cacheableResponse(request, ext ? [withListFlags(redactExtensionSecrets(ext))] : [], { maxAge: 60, staleWhileRevalidate: 300 });
  }

  const extensions = await listExtensions();
  return cacheableResponse(request, withListFlagsAll(extensions.map(redactExtensionSecrets)), { maxAge: 60, staleWhileRevalidate: 300 });
};

export const POST: RequestHandler = async ({ locals }) => {
  const denial = requireScope(locals, "extensions");
  if (denial) return denial;
  requireAuth(locals);
  return legacyExtensionEndpoint();
};
