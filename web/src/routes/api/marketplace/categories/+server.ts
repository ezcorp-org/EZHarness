/**
 * GET /api/marketplace/categories — Phase 49.3
 *
 * Returns the marketplace's tag taxonomy aggregated over active
 * listings: `{ categories: [{ tag, count }] }`. Used by the
 * marketplace page's category sidebar to render filter chips with
 * live counts. Public — same auth posture as `GET /api/marketplace`
 * (browse is open).
 *
 * Tags come from `marketplace_listings.tags` (jsonb array set when a
 * listing is published — see `POST /api/marketplace`). Source of
 * truth is `manifest.tags` (`src/extensions/types.ts:428`).
 *
 * Aggregation source is marketplace listings only; installed
 * extensions are deliberately excluded. See `getMarketplaceTagCounts`
 * in `src/db/queries/marketplace.ts` for the rationale.
 */

import { json } from "@sveltejs/kit";
import { getMarketplaceTagCounts } from "$server/db/queries/marketplace";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  const tagCounts = await getMarketplaceTagCounts();
  return json({ categories: tagCounts });
};
