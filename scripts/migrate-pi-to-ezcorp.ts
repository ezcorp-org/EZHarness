#!/usr/bin/env bun
/**
 * Migrates stored settings keys from old pi-prefixed names to ezcorp equivalents.
 * Safe to run multiple times (idempotent).
 * Run: bun scripts/migrate-pi-to-ezcorp.ts
 * Dry run: bun scripts/migrate-pi-to-ezcorp.ts --dry-run
 */
import { initDb, getDb } from "../src/db/connection";
import { settings } from "../src/db/schema";
import { like, eq } from "drizzle-orm";

const DRY_RUN = process.argv.includes("--dry-run");

// Patterns to find and rename in settings keys
const KEY_RENAMES: Array<{ pattern: string; replace: (key: string) => string }> = [
  // pi-oauth:* -> ezcorp-oauth:*
  { pattern: "pi-oauth:%", replace: (k) => k.replace("pi-oauth:", "ezcorp-oauth:") },
  // pi-ext:* -> ezcorp-ext:*
  { pattern: "pi-ext:%", replace: (k) => k.replace("pi-ext:", "ezcorp-ext:") },
  // pi-theme:* -> ezcorp-theme:*
  { pattern: "pi-theme:%", replace: (k) => k.replace("pi-theme:", "ezcorp-theme:") },
  // Any other pi: prefixed keys
  { pattern: "pi:%", replace: (k) => k.replace("pi:", "ezcorp:") },
];

async function migrate() {
  await initDb();
  const db = getDb();

  console.log(DRY_RUN ? "DRY RUN - no changes will be made" : "Migrating pi-prefixed settings keys...");

  let totalRenamed = 0;

  for (const { pattern, replace } of KEY_RENAMES) {
    const rows = await db.select().from(settings).where(like(settings.key, pattern));

    for (const row of rows) {
      const newKey = replace(row.key);
      if (newKey === row.key) continue;

      if (DRY_RUN) {
        console.log(`  Would rename: ${row.key} -> ${newKey}`);
      } else {
        // Upsert: if new key exists, update its value; otherwise insert
        const existing = await db.select().from(settings).where(eq(settings.key, newKey));
        if (existing.length > 0) {
          await db.update(settings).set({ value: row.value, updatedAt: new Date() }).where(eq(settings.key, newKey));
        } else {
          await db.insert(settings).values({ key: newKey, value: row.value, updatedAt: new Date() });
        }
        await db.delete(settings).where(eq(settings.key, row.key));
        console.log(`  Renamed: ${row.key} -> ${newKey}`);
      }
      totalRenamed++;
    }
  }

  if (totalRenamed === 0) {
    console.log("  No pi-prefixed keys found. Nothing to migrate.");
  } else {
    console.log(`\n${DRY_RUN ? "Would rename" : "Renamed"} ${totalRenamed} key(s).`);
  }

  console.log("Migration complete.");
  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
