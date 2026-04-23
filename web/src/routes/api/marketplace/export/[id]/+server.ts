import { requireAuth } from "$server/auth/middleware";
import { getListingById } from "$server/db/queries/marketplace";
import { getLatestVersion } from "$server/db/queries/marketplace-versions";
import type { ExtensionManifestV2 } from "$server/extensions/types";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  const listing = await getListingById(params.id);
  if (!listing) {
    return errorJson(404, "Not found");
  }

  const latestVersion = await getLatestVersion(listing.id);
  if (!latestVersion) {
    return errorJson(404, "No versions available");
  }

  const manifest = { ...(latestVersion.manifest as ExtensionManifestV2) } as ExtensionManifestV2 & { exportedAt?: string };
  manifest.exportedAt = new Date().toISOString();

  return new Response(JSON.stringify(manifest, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${listing.slug}-v${latestVersion.version}.json"`,
    },
  });
};
