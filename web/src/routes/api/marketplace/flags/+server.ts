import { json } from "@sveltejs/kit";
import { checkRole } from "$server/auth/middleware";
import { listFlags } from "$server/db/queries/marketplace-ratings";
import { getListingById } from "$server/db/queries/marketplace";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  // checkRole RETURNS the 401/403 Response so non-admin callers see the
  // intended status (a thrown Response would 500 via SvelteKit).
  const admin = checkRole(locals, "admin");
  if (admin instanceof Response) return admin;

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
