import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { getSetting } from "$server/db/queries/settings";
import { getListingById } from "$server/db/queries/marketplace";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

interface InstalledInfo {
  listingId: string;
  version: string;
  installedAt: string;
}

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  const idsParam = url.searchParams.get("ids");
  if (!idsParam) {
    return json({});
  }

  const ids = idsParam.split(",").filter(Boolean);
  const result: Record<string, { hasUpdate: boolean; currentVersion: string; latestVersion: string; listingId: string }> = {};

  await Promise.all(
    ids.map(async (agentConfigId) => {
      const installed = (await getSetting(`marketplace:installed:${agentConfigId}`)) as InstalledInfo | undefined;
      if (!installed?.listingId) return;

      const listing = await getListingById(installed.listingId);
      if (!listing) return;

      result[agentConfigId] = {
        hasUpdate: listing.latestVersion !== installed.version,
        currentVersion: installed.version,
        latestVersion: listing.latestVersion,
        listingId: listing.id,
      };
    }),
  );

  return json(result);
};
