import { requireAuth } from "$server/auth/middleware";
import { getListingById } from "$server/db/queries/marketplace";
import { getLatestVersion, getVersionById } from "$server/db/queries/marketplace-versions";
import { canonicalJson, validatePublishedRelease } from "@ezcorp/extension-contract";
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

  if (latestVersion.manifest.schemaVersion === 4) {
    const stored = await getVersionById(latestVersion.id);
    if (!stored?.release) return errorJson(409, "Marketplace version has no verified source release");
    const release = await validatePublishedRelease(stored.release);
    if (canonicalJson(stored.manifest) !== canonicalJson(release.build.manifest)) return errorJson(409, "Marketplace release metadata does not match");
    return new Response(JSON.stringify(release), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${listing.slug}-v${latestVersion.version}.release.json"` } });
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
