#!/usr/bin/env bun
/**
 * Report every stored model pin the installed pi-ai catalog no longer lists.
 *
 * WHY: a pi-ai upgrade can retire model ids (0.80.6 → 0.83.0 retired 18 across
 * the four providers EZCorp ships). A retired pin does NOT fail loudly — it
 * resolves to a synthesized model with a guessed 128k context window and an
 * all-zero rate table, so long threads get compacted harder and spend reports
 * as unmeasured. `src/runtime/routing/dropped-models.ts` documents the
 * measurements.
 *
 * This script answers the operator question that decides what to do about it:
 * *how many stored rows actually pin a retired id, and which ones?* Run it
 * against the database you care about — it is READ-ONLY and rewrites nothing.
 *
 *   bun scripts/scan-catalog-gaps.ts                 # embedded PGlite
 *   DATABASE_URL=postgres://… bun scripts/scan-catalog-gaps.ts
 *
 * Exit code is 0 whether or not gaps are found: this is a report, not a gate.
 * A non-zero exit is reserved for "the scan itself could not run".
 */

import { sql } from "drizzle-orm";
import { getDb, initDb } from "../src/db/connection";
import { isKnownCatalogModel } from "../src/providers/registry";
import { findCatalogGaps, isCatalogGap, type PinnedModelRef } from "../src/runtime/routing/dropped-models";

/**
 * Every column that pins a provider+model pair. `conversations` is the one the
 * question is usually about, but a retired pin on an agent config or a mode
 * degrades exactly the same way, so the report covers all of them.
 *
 * Each entry names the table, the model column, and the provider column (or a
 * literal when the table stores only a model id).
 */
const PIN_SOURCES: ReadonlyArray<{ table: string; modelCol: string; providerCol: string }> = [
  { table: "conversations", modelCol: "model", providerCol: "provider" },
  { table: "agent_configs", modelCol: "model", providerCol: "provider" },
  { table: "modes", modelCol: "preferred_model", providerCol: "preferred_provider" },
  { table: "briefing_configs", modelCol: "model", providerCol: "provider" },
];

export interface PinRow extends PinnedModelRef {
  rows: number;
}

export async function collectPins(): Promise<PinRow[]> {
  const db = getDb();
  const out: PinRow[] = [];
  for (const src of PIN_SOURCES) {
    let rows: Array<Record<string, unknown>>;
    try {
      // Grouped so one row per distinct pin, with its population count — the
      // number that decides whether a re-point migration is worth writing.
      //
      // `sql.raw` for the identifiers because the table/column vary per
      // source. They come from the const list above, never from input.
      const result = await db.execute(sql`
        SELECT ${sql.raw(src.providerCol)} AS provider,
               ${sql.raw(src.modelCol)} AS model,
               COUNT(*)::int AS rows
          FROM ${sql.raw(src.table)}
         WHERE ${sql.raw(src.modelCol)} IS NOT NULL AND ${sql.raw(src.modelCol)} <> ''
         GROUP BY 1, 2
      `);
      // PGlite returns `{rows: [...]}`; Bun.sql returns the array directly.
      rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? [])) as Array<
        Record<string, unknown>
      >;
    } catch (err) {
      // A column this deployment's schema does not have (older install, or a
      // table added since). Skip it rather than failing the whole report.
      console.warn(`  ! skipped ${src.table}.${src.modelCol}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const row of rows ?? []) {
      const provider = typeof row.provider === "string" ? row.provider : "";
      const modelId = typeof row.model === "string" ? row.model : "";
      if (!provider || !modelId) continue;
      out.push({
        provider,
        modelId,
        source: `${src.table}.${src.modelCol}`,
        rows: Number(row.rows ?? 0),
      });
    }
  }
  return out;
}

export async function main(): Promise<void> {
  // Opens PGlite (or connects to DATABASE_URL) and runs the idempotent boot
  // migrate, exactly as the app does. Read-only from here on.
  await initDb();
  const pins = await collectPins();
  const gaps = findCatalogGaps(pins, isKnownCatalogModel);

  // findCatalogGaps collapses duplicates to one row per (provider, model);
  // re-walk the raw pins for the population totals.
  const affectedRows = pins
    .filter((p) => isCatalogGap(p, isKnownCatalogModel))
    .reduce((sum, p) => sum + p.rows, 0);

  console.log(`Scanned ${pins.length} distinct model pin(s) across ${PIN_SOURCES.length} table(s).`);
  if (gaps.length === 0) {
    console.log("No catalog gaps: every pinned model is listed by the installed pi-ai catalog.");
    return;
  }

  console.log(`\n${gaps.length} retired model id(s) still pinned, covering ${affectedRows} row(s):\n`);
  for (const gap of gaps) {
    const rows = pins
      .filter((p) => p.provider === gap.provider && p.modelId === gap.modelId)
      .reduce((sum, p) => sum + p.rows, 0);
    const where = [...new Set(pins.filter((p) => p.provider === gap.provider && p.modelId === gap.modelId).map((p) => p.source))];
    console.log(`  ${gap.provider}/${gap.modelId} — ${rows} row(s) in ${where.join(", ")}`);
  }
  console.log(
    "\nThese still REACH the provider; what is lost is an accurate context window " +
    "and pricing. Re-pin them to a listed model, or run refresh-models if the " +
    "provider still serves the id.",
  );
}

// Only self-execute when run directly (`bun scripts/scan-catalog-gaps.ts`).
// Without this guard, importing anything from this module — which is how its
// SQL is tested against a real migrated PGlite — would run the whole report.
if (import.meta.main) await main();
