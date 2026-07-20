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
  // One transaction so the rating write and the denormalized-count recompute
  // commit together. Previously the select-then-insert/update raced the
  // UNIQUE(listing_id, user_id) index (two concurrent first ratings from the
  // same user — a double-click — made the loser throw an unhandled unique
  // violation → 500), and the recompute+write-back was non-atomic so an
  // interleave could persist a stale count. The insert now upserts against
  // the real conflict target, and the recount runs on the same tx snapshot.
  await getDb().transaction(async (tx: any) => {
    await tx
      .insert(marketplaceRatings)
      .values({ listingId, userId, thumbsUp })
      .onConflictDoUpdate({
        target: [marketplaceRatings.listingId, marketplaceRatings.userId],
        set: { thumbsUp, updatedAt: new Date() },
      });

    const [counts] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        positive: sql<number>`count(*) filter (where ${marketplaceRatings.thumbsUp} = true)::int`,
      })
      .from(marketplaceRatings)
      .where(eq(marketplaceRatings.listingId, listingId));

    await tx
      .update(marketplaceListings)
      .set({
        ratingTotal: counts.total,
        ratingPositive: counts.positive,
        updatedAt: new Date(),
      })
      .where(eq(marketplaceListings.id, listingId));
  });
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
  // One transaction so the flag insert and the denormalized flagCount / status
  // recompute commit together — otherwise an interleave with a concurrent
  // flag/resolve could persist a stale count (same non-atomic recompute hazard
  // fixed in upsertRating).
  return getDb().transaction(async (tx: any) => {
    const [flag] = await tx
      .insert(marketplaceFlags)
      .values({ listingId, userId, reason, category })
      .returning();

    // Count distinct pending flaggers for this listing
    const [{ count }] = await tx
      .select({ count: sql<number>`count(distinct ${marketplaceFlags.userId})::int` })
      .from(marketplaceFlags)
      .where(
        and(
          eq(marketplaceFlags.listingId, listingId),
          eq(marketplaceFlags.status, "pending"),
        ),
      );

    // Update flagCount; auto-flag when ANY flag is pending
    await tx
      .update(marketplaceListings)
      .set({
        flagCount: count,
        ...(count >= 1 ? { status: "flagged" } : {}),
        updatedAt: new Date(),
      })
      .where(eq(marketplaceListings.id, listingId));

    return flag;
  });
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
  // One transaction: the flag-status update, the listing status transition,
  // and the flagCount recompute are a single all-or-nothing unit so a crash
  // or concurrent resolve can't leave the denormalized count / status stale
  // relative to the flags (same non-atomic recompute hazard fixed in
  // upsertRating / createFlag).
  await getDb().transaction(async (tx: any) => {
    const [flag] = await tx
      .select()
      .from(marketplaceFlags)
      .where(eq(marketplaceFlags.id, flagId));

    if (!flag) return;

    await tx
      .update(marketplaceFlags)
      .set({ status: action, reviewedBy, reviewedAt: new Date() })
      .where(eq(marketplaceFlags.id, flagId));

    if (action === "removed") {
      await tx
        .update(marketplaceListings)
        .set({ status: "removed", updatedAt: new Date() })
        .where(eq(marketplaceListings.id, flag.listingId));
    } else {
      // Only restore to active if listing is currently "flagged" (not "removed")
      const [listing] = await tx
        .select()
        .from(marketplaceListings)
        .where(eq(marketplaceListings.id, flag.listingId));

      if (listing && listing.status === "flagged") {
        // Check if other pending flags exist before restoring
        const [pending] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(marketplaceFlags)
          .where(
            and(
              eq(marketplaceFlags.listingId, flag.listingId),
              eq(marketplaceFlags.status, "pending"),
            ),
          );

        if (pending.count === 0) {
          await tx
            .update(marketplaceListings)
            .set({ status: "active", updatedAt: new Date() })
            .where(eq(marketplaceListings.id, flag.listingId));
        }
      }
    }

    // Recalculate flagCount
    const [{ count }] = await tx
      .select({ count: sql<number>`count(distinct ${marketplaceFlags.userId})::int` })
      .from(marketplaceFlags)
      .where(
        and(
          eq(marketplaceFlags.listingId, flag.listingId),
          eq(marketplaceFlags.status, "pending"),
        ),
      );

    await tx
      .update(marketplaceListings)
      .set({ flagCount: count, updatedAt: new Date() })
      .where(eq(marketplaceListings.id, flag.listingId));
  });
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
