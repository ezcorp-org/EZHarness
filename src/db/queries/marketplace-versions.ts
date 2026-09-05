import { eq, desc, and, getTableColumns } from "drizzle-orm";
import { getDb, type DbTransaction } from "../connection";
import { marketplaceVersions, marketplaceListings } from "../schema";
import type { MarketplaceVersion as StoredMarketplaceVersion } from "../schema";
import type { ExtensionManifestV2 } from "../../extensions/types";
import type { PublishedExtensionRelease } from "@ezcorp/extension-contract";
import { canonicalJson, validatePublishedRelease } from "@ezcorp/extension-contract";

export type MarketplaceVersion = Omit<StoredMarketplaceVersion, "release">;
const { release: _release, ...metadataColumns } = getTableColumns(marketplaceVersions);

export async function createVersion(
  listingId: string,
  version: string,
  manifest: ExtensionManifestV2,
  changelog?: string,
  release?: PublishedExtensionRelease,
): Promise<MarketplaceVersion> {
  const sealed = release ? await validatePublishedRelease(structuredClone(release)) : undefined;
  if (sealed && (canonicalJson(sealed.build.manifest) !== canonicalJson(manifest) || sealed.build.manifest?.version !== version)) throw new Error("Marketplace metadata does not match the immutable release");
  return getDb().transaction(async (transaction: DbTransaction) => {
    const [row] = await transaction
      .insert(marketplaceVersions)
      .values({ listingId, version, manifest, changelog: changelog ?? null, release: sealed ?? null })
      .returning(metadataColumns);
    await transaction
      .update(marketplaceListings)
      .set({ latestVersion: version, updatedAt: new Date() })
      .where(eq(marketplaceListings.id, listingId));
    return row!;
  });
}

export async function getVersion(
  listingId: string,
  version: string,
): Promise<MarketplaceVersion | undefined> {
  const [row] = await getDb()
    .select(metadataColumns)
    .from(marketplaceVersions)
    .where(
      and(
        eq(marketplaceVersions.listingId, listingId),
        eq(marketplaceVersions.version, version),
      ),
    );
  return row;
}

export async function getVersionById(id: string): Promise<StoredMarketplaceVersion | undefined> {
  const [row] = await getDb().select().from(marketplaceVersions).where(eq(marketplaceVersions.id, id)).limit(1);
  return row;
}

export async function getLatestVersion(listingId: string): Promise<MarketplaceVersion | undefined> {
  const [row] = await getDb()
    .select(metadataColumns)
    .from(marketplaceVersions)
    .where(eq(marketplaceVersions.listingId, listingId))
    .orderBy(desc(marketplaceVersions.createdAt))
    .limit(1);
  return row;
}

export async function listVersions(listingId: string): Promise<MarketplaceVersion[]> {
  return getDb()
    .select(metadataColumns)
    .from(marketplaceVersions)
    .where(eq(marketplaceVersions.listingId, listingId))
    .orderBy(desc(marketplaceVersions.createdAt));
}
