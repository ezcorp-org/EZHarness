import { json } from "@sveltejs/kit";
import { requireRole } from "$server/auth/middleware";
import { listFlags } from "$server/db/queries/marketplace-ratings";
import { getListingById } from "$server/db/queries/marketplace";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  requireRole(locals, "admin");

  const flags = await listFlags({ status: "pending" });

  // Enrich with listing info
  const enriched = await Promise.all(
    flags.map(async (flag) => {
      const listing = await getListingById(flag.listingId);
      return {
        ...flag,
        listing: listing ? { id: listing.id, name: listing.name, slug: listing.slug } : null,
      };
    }),
  );

  return json({ flags: enriched });
};
