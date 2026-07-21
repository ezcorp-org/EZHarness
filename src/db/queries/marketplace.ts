import { eq, desc, sql, and } from "drizzle-orm";
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

  // UX-02 (Phase 57-04): length-gated trigram + FTS hybrid search.
  //
  // - Queries ≤ 2 chars short-circuit to alphabetical browse (no trigram
  //   nor FTS WHERE clause, no GIN hit) — single letters would match too
  //   broadly under ilike and offer no signal under trigram either.
  // - Queries ≥ 3 chars emit a hybrid WHERE:
  //     q <% (name||' '||description)
  //       (typo-tolerant recall — must-haves "iphne" → "iPhone" and "git"
  //        → "GitHub" both score ≥ 0.5 here; unrelated docs score 0)
  //     OR to_tsvector(...) @@ plainto_tsquery(...)
  //       (stem recall — rescues legitimate matches the trigram path
  //        under-scores, e.g. "github" vs a long marketing description)
  //   ORDER BY combines word_similarity (60%) + ts_rank_cd (40%) so the
  //   trigram path dominates short partial queries while FTS still
  //   contributes for stem-aligned matches.
  //
  // INDEX SHAPE (perf): the recall arm uses the `<%` OPERATOR, not the
  // `word_similarity(...) > 0.4` function-call form. pg_trgm's GIN index
  // (`idx_marketplace_listings_trgm` on `(name || ' ' || description)`)
  // only serves the operator forms (`%`, `<%`/`%>`); a `word_similarity()
  // > x` predicate is planned as a bare function call and forces a seq
  // scan + per-row trigram compute. `<%` compares against the session
  // `pg_trgm.word_similarity_threshold`, which we pin to 0.4 via `SET
  // LOCAL` inside the wrapping transaction below so the recall matches the
  // prior `> 0.4` contract. (The operator boundary is `>=`, so the
  // measure-zero ws==0.4 case now matches too — negligible.)
  //
  // Deviation from plan (RESEARCH option c → option d, see SUMMARY):
  // `similarity()` returns the trigram overlap of the FULL strings, so
  // a 3-letter query against a 60-char document scores ≤ 0.1 even for
  // an exact prefix match. `word_similarity()` measures the best-matching
  // substring window inside the document — the correct primitive for
  // "user typed a short query into a search box". The 0.4 threshold (below
  // the `<%` operator's 0.6 default) admits the typo recall must_haves
  // contract requires.
  const trigram = !!(opts.query && opts.query.length >= 3);
  if (trigram) {
    const q = opts.query!;
    conditions.push(sql`(
      ${q} <% (${marketplaceListings.name} || ' ' || ${marketplaceListings.description})
      OR to_tsvector('english',
           ${marketplaceListings.name} || ' ' || ${marketplaceListings.description}
         ) @@ plainto_tsquery('english', ${q})
    )`);
  }

  if (opts.tag) {
    conditions.push(sql`${marketplaceListings.tags} @> ${JSON.stringify([opts.tag])}::jsonb`);
  }

  let orderBy;
  if (trigram) {
    const q = opts.query!;
    orderBy = sql`
      0.6 * word_similarity(${q}, ${marketplaceListings.name} || ' ' || ${marketplaceListings.description})
      + 0.4 * ts_rank_cd(
          to_tsvector('english', ${marketplaceListings.name} || ' ' || ${marketplaceListings.description}),
          plainto_tsquery('english', ${q})
        ) DESC
    `;
  } else {
    switch (opts.sort) {
      case "popular":
        orderBy = desc(marketplaceListings.installCount);
        break;
      case "rating":
        orderBy = sql`(${marketplaceListings.ratingPositive} * 100) / (${marketplaceListings.ratingTotal} + 1) DESC`;
        break;
      default:
        orderBy = desc(marketplaceListings.createdAt);
        break;
    }
  }

  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const db = getDb();
  if (!trigram) {
    return db
      .select()
      .from(marketplaceListings)
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);
  }
  // `SET LOCAL` is transaction-scoped, so the lowered threshold applies to
  // ONLY this query and never leaks across a pooled Bun.sql connection.
  return db.transaction(async (tx: typeof db) => {
    await tx.execute(sql`SET LOCAL pg_trgm.word_similarity_threshold = 0.4`);
    return tx
      .select()
      .from(marketplaceListings)
      .where(and(...conditions))
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);
  });
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

export interface TagCount {
  tag: string;
  count: number;
}

/**
 * Phase 49.3 — aggregate active-listing tag counts for the marketplace
 * category sidebar. Results are sorted by descending count, then tag
 * name asc so the chip order is stable across requests.
 *
 * Uses Postgres' `jsonb_array_elements_text` to unnest the `tags`
 * array column. Cheaper than pulling every row's tags into the app
 * and counting in JS — the SQL engine groups + sorts in one pass and
 * we ship only the aggregate.
 *
 * Aggregation source: `marketplace_listings` ONLY. Installed-extension
 * `manifest.tags` are deliberately excluded — categories filter the
 * public marketplace, and installed extensions don't appear there.
 * Including installed-only tags would surface chips that match zero
 * listings (misleading UX). v1.5 may add a separate "My installed
 * extensions" tag filter on the Installed tab if user research
 * validates the need. Spec §49.3.1 mentioned aggregating both sources,
 * but that wording was loose — the implementation is intentionally
 * marketplace-only.
 */
export async function getMarketplaceTagCounts(): Promise<TagCount[]> {
  const rows = await getDb().execute(
    sql`
      SELECT tag, COUNT(*)::int AS count
      FROM ${marketplaceListings},
           jsonb_array_elements_text(${marketplaceListings.tags}) AS tag
      WHERE ${marketplaceListings.status} = 'active'
      GROUP BY tag
      ORDER BY count DESC, tag ASC
    `,
  );
  // PGlite occasionally returns COUNT as a string — coerce defensively.
  // Drizzle's `execute()` returns either an array (postgres-js) or
  // `{ rows: [...] }` (PGlite); normalise so the caller always gets a
  // flat array. Cast through `unknown` because the return type from
  // `execute()` varies by adapter.
  type Row = { tag: string; count: string | number };
  const result = rows as unknown as Row[] | { rows: Row[] };
  const list: Row[] = Array.isArray(result) ? result : (result.rows ?? []);
  return list.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}
