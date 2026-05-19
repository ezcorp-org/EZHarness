import { eq, and, sql, desc } from "drizzle-orm";
import { getDb } from "../connection";
import { marketplaceRatings, marketplaceFlags, marketplaceListings } from "../schema";
import type { MarketplaceRating, MarketplaceFlag } from "../schema";

export type { MarketplaceRating, MarketplaceFlag };

export async function upsertRating(
  listingId: string,
  userId: string,
  thumbsUp: boolean,
): Promise<void> {
  const db = getDb();

  // Check if rating exists
  const [existing] = await db
    .select()
    .from(marketplaceRatings)
    .where(
      and(
        eq(marketplaceRatings.listingId, listingId),
        eq(marketplaceRatings.userId, userId),
      ),
    );

  if (existing) {
    // Update existing rating
    await db
      .update(marketplaceRatings)
      .set({ thumbsUp, updatedAt: new Date() })
      .where(eq(marketplaceRatings.id, existing.id));
  } else {
    // Insert new rating
    await db.insert(marketplaceRatings).values({ listingId, userId, thumbsUp });
  }

  // Recalculate denormalized counts on listing
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      positive: sql<number>`count(*) filter (where ${marketplaceRatings.thumbsUp} = true)::int`,
    })
    .from(marketplaceRatings)
    .where(eq(marketplaceRatings.listingId, listingId));

  await db
    .update(marketplaceListings)
    .set({
      ratingTotal: counts.total,
      ratingPositive: counts.positive,
      updatedAt: new Date(),
    })
    .where(eq(marketplaceListings.id, listingId));
}

export async function getUserRating(
  listingId: string,
  userId: string,
): Promise<MarketplaceRating | undefined> {
  const [row] = await getDb()
    .select()
    .from(marketplaceRatings)
    .where(
      and(
        eq(marketplaceRatings.listingId, listingId),
        eq(marketplaceRatings.userId, userId),
      ),
    );
  return row;
}

export async function createFlag(
  listingId: string,
  userId: string,
  reason: string,
  category: "spam" | "malicious" | "misleading" | "inappropriate" | "other" = "other",
): Promise<MarketplaceFlag> {
  const db = getDb();

  const [flag] = await db
    .insert(marketplaceFlags)
    .values({ listingId, userId, reason, category })
    .returning();

  // Count distinct pending flaggers for this listing
  const [{ count }] = await db
    .select({ count: sql<number>`count(distinct ${marketplaceFlags.userId})::int` })
    .from(marketplaceFlags)
    .where(
      and(
        eq(marketplaceFlags.listingId, listingId),
        eq(marketplaceFlags.status, "pending"),
      ),
    );

  // Update flagCount; auto-flag when ANY flag is pending
  await db
    .update(marketplaceListings)
    .set({
      flagCount: count,
      ...(count >= 1 ? { status: "flagged" } : {}),
      updatedAt: new Date(),
    })
    .where(eq(marketplaceListings.id, listingId));

  return flag;
}

export async function countPendingFlagsByUser(userId: string): Promise<number> {
  const db = getDb();
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(marketplaceFlags)
    .where(
      and(
        eq(marketplaceFlags.userId, userId),
        sql`${marketplaceFlags.createdAt} > now() - interval '1 hour'`,
      ),
    );
  return count;
}

export async function getFlagHistory(listingId: string): Promise<MarketplaceFlag[]> {
  return getDb()
    .select()
    .from(marketplaceFlags)
    .where(eq(marketplaceFlags.listingId, listingId))
    .orderBy(desc(marketplaceFlags.createdAt));
}

export async function resolveFlag(
  flagId: string,
  reviewedBy: string,
  action: "dismissed" | "removed",
): Promise<void> {
  const db = getDb();

  const [flag] = await db
    .select()
    .from(marketplaceFlags)
    .where(eq(marketplaceFlags.id, flagId));

  if (!flag) return;

  await db
    .update(marketplaceFlags)
    .set({ status: action, reviewedBy, reviewedAt: new Date() })
    .where(eq(marketplaceFlags.id, flagId));

  if (action === "removed") {
    await db
      .update(marketplaceListings)
      .set({ status: "removed", updatedAt: new Date() })
      .where(eq(marketplaceListings.id, flag.listingId));
  } else {
    // Only restore to active if listing is currently "flagged" (not "removed")
    const [listing] = await db
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, flag.listingId));

    if (listing && listing.status === "flagged") {
      // Check if other pending flags exist before restoring
      const [pending] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(marketplaceFlags)
        .where(
          and(
            eq(marketplaceFlags.listingId, flag.listingId),
            eq(marketplaceFlags.status, "pending"),
          ),
        );

      if (pending.count === 0) {
        await db
          .update(marketplaceListings)
          .set({ status: "active", updatedAt: new Date() })
          .where(eq(marketplaceListings.id, flag.listingId));
      }
    }
  }

  // Recalculate flagCount
  const [{ count }] = await db
    .select({ count: sql<number>`count(distinct ${marketplaceFlags.userId})::int` })
    .from(marketplaceFlags)
    .where(
      and(
        eq(marketplaceFlags.listingId, flag.listingId),
        eq(marketplaceFlags.status, "pending"),
      ),
    );

  await db
    .update(marketplaceListings)
    .set({ flagCount: count, updatedAt: new Date() })
    .where(eq(marketplaceListings.id, flag.listingId));
}

export async function listFlags(opts?: {
  status?: string;
  listingId?: string;
}): Promise<MarketplaceFlag[]> {
  const conditions = [];

  if (opts?.status) {
    conditions.push(eq(marketplaceFlags.status, opts.status as any));
  }
  if (opts?.listingId) {
    conditions.push(eq(marketplaceFlags.listingId, opts.listingId));
  }

  const query = getDb().select().from(marketplaceFlags);
  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }
  return query;
}
