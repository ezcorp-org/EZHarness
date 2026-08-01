/**
 * WS3b: `modes.preferred_tier` — the mode → routing-TIER task binding.
 *
 * Schema delta (one column, idempotent, additive — no destructive changes):
 *   - modes.preferred_tier (TEXT, NULL) — 'fast' | 'balanced' | 'powerful'
 *
 * Why a tier and not just the existing `preferred_model`: a mode is
 * long-lived config ("code review is careful work"), while the model catalog
 * turns over constantly. A mode that names `preferred_tier = 'powerful'`
 * keeps expressing that intent as the tier ladder (`provider:tierModels`)
 * changes underneath it, and keeps working on a deployment that has never
 * heard of the model the author happened to be using. `preferred_model` stays
 * the escape hatch for "this exact model, nothing else".
 *
 * ── The default for existing rows is NULL, deliberately ──
 * NULL means "no tier preference", which routes exactly as it did before this
 * column existed: the turn falls through to the heuristic classifier. Picking
 * any non-NULL default would silently re-route every existing mode's traffic
 * — the opposite of the additive contract. The built-in Plan / Code Review /
 * Ez modes are seeded with no tier for the same reason.
 *
 * ── Plain TEXT, no CHECK constraint ──
 * Same convention as `modes.instruction_position`, `modes.tool_restriction`
 * and `message_attachments.kind`: the union narrows at the TypeScript layer
 * (`schema.ts` `$type<RoutingTier>()`) so adding a tier is a zero-DDL change,
 * and `src/runtime/routing/mode-binding.ts` re-validates the stored value at
 * read time — an unrecognized tier degrades to "no preference" rather than
 * routing on garbage.
 *
 * This migration is applied automatically via src/db/migrate.ts (which
 * inlines the same DDL). This file exists for documentation and focused
 * tests, and parallels add-ez-mode-and-kind.ts / add-fork-tracking.ts — it is
 * NOT boot-sequenced.
 */
import { sql } from "drizzle-orm";

export async function up(db: any): Promise<void> {
  await db.execute(sql`ALTER TABLE modes ADD COLUMN IF NOT EXISTS preferred_tier TEXT`);
}
