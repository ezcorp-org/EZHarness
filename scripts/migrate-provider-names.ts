#!/usr/bin/env bun
/**
 * Migrates stored provider names from old (claude/gemini) to pi-ai canonical (anthropic/google).
 * Safe to run multiple times (idempotent).
 * Run: bun scripts/migrate-provider-names.ts
 */
import { initDb, getDb } from "../src/db/connection";
import { settings, agentConfigs } from "../src/db/schema";
import { eq, like, sql } from "drizzle-orm";

const RENAMES: Record<string, string> = {
  claude: "anthropic",
  gemini: "google",
};

async function migrate() {
  await initDb();
  const db = getDb();

  console.log("Migrating provider names...");

  // 1. Settings keys: provider:apiKey:{old} -> provider:apiKey:{new}
  //                    provider:oauth:{old} -> provider:oauth:{new}
  //                    provider:accessMode:{old} -> provider:accessMode:{new}
  for (const [old, newName] of Object.entries(RENAMES)) {
    for (const prefix of ["provider:apiKey:", "provider:oauth:", "provider:accessMode:"]) {
      const oldKey = `${prefix}${old}`;
      const newKey = `${prefix}${newName}`;

      const rows = await db.select().from(settings).where(eq(settings.key, oldKey));
      if (rows.length > 0) {
        // Upsert new key
        const existing = await db.select().from(settings).where(eq(settings.key, newKey));
        if (existing.length > 0) {
          await db.update(settings).set({ value: rows[0]!.value, updatedAt: new Date() }).where(eq(settings.key, newKey));
        } else {
          await db.insert(settings).values({ key: newKey, value: rows[0]!.value, updatedAt: new Date() });
        }
        await db.delete(settings).where(eq(settings.key, oldKey));
        console.log(`  Renamed setting: ${oldKey} -> ${newKey}`);
      }
    }

    // Conversation-level access modes: conversation:*:accessMode:{old}
    const convSettings = await db.select().from(settings).where(like(settings.key, `%:accessMode:${old}`));
    for (const row of convSettings) {
      const newKey = row.key.replace(`:accessMode:${old}`, `:accessMode:${newName}`);
      const existing = await db.select().from(settings).where(eq(settings.key, newKey));
      if (existing.length > 0) {
        await db.update(settings).set({ value: row.value, updatedAt: new Date() }).where(eq(settings.key, newKey));
      } else {
        await db.insert(settings).values({ key: newKey, value: row.value, updatedAt: new Date() });
      }
      await db.delete(settings).where(eq(settings.key, row.key));
      console.log(`  Renamed setting: ${row.key} -> ${newKey}`);
    }
  }

  // 2. Agent configs: provider column "claude" -> "anthropic", "gemini" -> "google"
  for (const [old, newName] of Object.entries(RENAMES)) {
    const updated = await db.update(agentConfigs)
      .set({ provider: newName })
      .where(eq(agentConfigs.provider, old))
      .returning({ id: agentConfigs.id });
    if (updated.length > 0) {
      console.log(`  Updated ${updated.length} agent configs: provider ${old} -> ${newName}`);
    }
  }

  // 3. Messages: provider column
  for (const [old, newName] of Object.entries(RENAMES)) {
    await db.execute(sql`UPDATE messages SET provider = ${newName} WHERE provider = ${old}`);
    console.log(`  Updated messages: provider ${old} -> ${newName}`);
  }

  // 4. Conversations: provider column
  for (const [old, newName] of Object.entries(RENAMES)) {
    await db.execute(sql`UPDATE conversations SET provider = ${newName} WHERE provider = ${old}`);
    console.log(`  Updated conversations: provider ${old} -> ${newName}`);
  }

  // 5. Preference order setting
  const prefRows = await db.select().from(settings).where(eq(settings.key, "provider:preferenceOrder"));
  if (prefRows.length > 0) {
    let order = prefRows[0]!.value;
    if (Array.isArray(order)) {
      order = order.map((p: string) => RENAMES[p] ?? p);
      await db.update(settings).set({ value: order, updatedAt: new Date() }).where(eq(settings.key, "provider:preferenceOrder"));
      console.log(`  Updated preferenceOrder: ${JSON.stringify(order)}`);
    }
  }

  // 6. Global provider setting
  const globalRows = await db.select().from(settings).where(eq(settings.key, "global:provider"));
  if (globalRows.length > 0) {
    const val = globalRows[0]!.value;
    if (typeof val === "string" && RENAMES[val]) {
      await db.update(settings).set({ value: RENAMES[val], updatedAt: new Date() }).where(eq(settings.key, "global:provider"));
      console.log(`  Updated global:provider: ${val} -> ${RENAMES[val]}`);
    }
  }

  console.log("Migration complete.");
  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
