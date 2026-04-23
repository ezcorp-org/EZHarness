import { json } from "@sveltejs/kit";
import { requireRole } from "$server/auth/middleware";
import { getListingById, updateListingStatus } from "$server/db/queries/marketplace";
import { getLatestVersion, listVersions } from "$server/db/queries/marketplace-versions";
import { getUserRating } from "$server/db/queries/marketplace-ratings";
import { isListingInstalled } from "$server/db/queries/settings";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const listing = await getListingById(params.id);
  if (!listing) {
    return errorJson(404, "Not found");
  }

  const latestVersion = await getLatestVersion(listing.id);
  const versions = await listVersions(listing.id);

  // User rating is only available when authenticated
  const user = locals.user;
  const userRating = user ? await getUserRating(listing.id, user.id) : null;
  const installed = await isListingInstalled(listing.id);

  return json({
    listing: {
      ...listing,
      ratingPercent: listing.ratingTotal > 0 ? Math.round((listing.ratingPositive / listing.ratingTotal) * 100) : 0,
    },
    latestVersion,
    versions,
    userRating: userRating ?? null,
    installed,
  });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  const user = requireRole(locals, "admin");

  await updateListingStatus(params.id, "removed");
  await insertAuditEntry(user.id, "marketplace:remove", params.id);

  return json({ ok: true });
};
