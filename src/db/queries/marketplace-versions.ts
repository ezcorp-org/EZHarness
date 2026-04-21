import { eq, desc, and } from "drizzle-orm";
import { getDb } from "../connection";
import { marketplaceVersions, marketplaceListings } from "../schema";
import type { MarketplaceVersion } from "../schema";
import type { ExtensionManifestV2 } from "../../extensions/types";

export type { MarketplaceVersion };

export async function createVersion(
  listingId: string,
  version: string,
  manifest: ExtensionManifestV2,
  changelog?: string,
): Promise<MarketplaceVersion> {
  const [row] = await getDb()
    .insert(marketplaceVersions)
    .values({
      listingId,
      version,
      manifest,
      changelog: changelog ?? null,
    })
    .returning();

  // Update listing's latestVersion
  await getDb()
    .update(marketplaceListings)
    .set({ latestVersion: version, updatedAt: new Date() })
    .where(eq(marketplaceListings.id, listingId));

  return row!;
}

export async function getVersion(
  listingId: string,
  version: string,
): Promise<MarketplaceVersion | undefined> {
  const [row] = await getDb()
    .select()
    .from(marketplaceVersions)
    .where(
      and(
        eq(marketplaceVersions.listingId, listingId),
        eq(marketplaceVersions.version, version),
      ),
    );
  return row;
}

export async function getLatestVersion(listingId: string): Promise<MarketplaceVersion | undefined> {
  const [row] = await getDb()
    .select()
    .from(marketplaceVersions)
    .where(eq(marketplaceVersions.listingId, listingId))
    .orderBy(desc(marketplaceVersions.createdAt))
    .limit(1);
  return row;
}

export async function listVersions(listingId: string): Promise<MarketplaceVersion[]> {
  return getDb()
    .select()
    .from(marketplaceVersions)
    .where(eq(marketplaceVersions.listingId, listingId))
    .orderBy(desc(marketplaceVersions.createdAt));
}
