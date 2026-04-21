import { eq, desc, sql, and, ilike, or } from "drizzle-orm";
import { getDb } from "../connection";
import { marketplaceListings } from "../schema";
import type { MarketplaceListing } from "../schema";
import { generateSlug } from "../../extensions/manifest";

export type { MarketplaceListing };

export interface CreateListingData {
  authorId: string;
  agentConfigId?: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  latestVersion: string;
}

export async function createListing(data: CreateListingData): Promise<MarketplaceListing> {
  const slug = generateSlug(data.name);
  const row = {
    authorId: data.authorId,
    agentConfigId: data.agentConfigId ?? null,
    name: data.name,
    description: data.description,
    slug,
    category: data.category,
    tags: data.tags,
    latestVersion: data.latestVersion,
  };

  const [listing] = await getDb().insert(marketplaceListings).values(row).returning();
  return listing!;
}

export async function getListingById(id: string): Promise<MarketplaceListing | undefined> {
  const [listing] = await getDb()
    .select()
    .from(marketplaceListings)
    .where(and(eq(marketplaceListings.id, id), sql`${marketplaceListings.status} != 'removed'`));
  return listing;
}

export async function getListingBySlug(slug: string): Promise<MarketplaceListing | undefined> {
  const [listing] = await getDb()
    .select()
    .from(marketplaceListings)
    .where(and(eq(marketplaceListings.slug, slug), sql`${marketplaceListings.status} != 'removed'`));
  return listing;
}

export interface BrowseOptions {
  query?: string;
  category?: string;
  tag?: string;
  sort?: "rating" | "popular" | "newest";
  limit?: number;
  offset?: number;
}

export async function browseMarketplace(opts: BrowseOptions): Promise<MarketplaceListing[]> {
  const conditions = [eq(marketplaceListings.status, "active")];

  if (opts.category) {
    conditions.push(eq(marketplaceListings.category, opts.category));
  }

  if (opts.query) {
    const pattern = `%${opts.query}%`;
    conditions.push(
      or(
        ilike(marketplaceListings.name, pattern),
        ilike(marketplaceListings.description, pattern),
      )!,
    );
  }

  if (opts.tag) {
    conditions.push(sql`${marketplaceListings.tags} @> ${JSON.stringify([opts.tag])}::jsonb`);
  }

  let orderBy;
  switch (opts.sort) {
    case "popular":
      orderBy = desc(marketplaceListings.installCount);
      break;
    case "rating":
      orderBy = sql`(${marketplaceListings.ratingPositive} * 100) / (${marketplaceListings.ratingTotal} + 1) DESC`;
      break;
    case "newest":
    default:
      orderBy = desc(marketplaceListings.createdAt);
      break;
  }

  return getDb()
    .select()
    .from(marketplaceListings)
    .where(and(...conditions))
    .orderBy(orderBy)
    .limit(opts.limit ?? 20)
    .offset(opts.offset ?? 0);
}

export async function deleteListing(id: string): Promise<boolean> {
  const result = await getDb()
    .delete(marketplaceListings)
    .where(eq(marketplaceListings.id, id))
    .returning({ id: marketplaceListings.id });
  return result.length > 0;
}

export async function updateListingStatus(id: string, status: "active" | "flagged" | "removed"): Promise<void> {
  await getDb()
    .update(marketplaceListings)
    .set({ status, updatedAt: new Date() })
    .where(eq(marketplaceListings.id, id));
}

export async function incrementInstallCount(id: string): Promise<void> {
  await getDb()
    .update(marketplaceListings)
    .set({
      installCount: sql`${marketplaceListings.installCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(marketplaceListings.id, id));
}

export async function getListingsByAuthor(authorId: string): Promise<MarketplaceListing[]> {
  return getDb()
    .select()
    .from(marketplaceListings)
    .where(eq(marketplaceListings.authorId, authorId))
    .orderBy(desc(marketplaceListings.createdAt));
}

export async function getFeaturedListings(limit = 6): Promise<MarketplaceListing[]> {
  return getDb()
    .select()
    .from(marketplaceListings)
    .where(and(eq(marketplaceListings.status, "active")))
    .orderBy(desc(marketplaceListings.featured), desc(marketplaceListings.installCount))
    .limit(limit);
}
