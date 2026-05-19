#!/usr/bin/env bun
/**
 * Diagnostic for the mode-extensions wire bug.
 *
 *   bun run scripts/debug-mode-extensions.ts [mode-slug-or-id]
 *
 * Inspects:
 *  - Mode rows: extensionIds, toolRestriction, allowedTools.
 *  - Extension rows referenced by extensionIds: enabled, name, manifest tool list.
 *
 * IMPORTANT: PGlite is single-writer. If your dev server is running, this
 * script will fail with a lock error. Stop `bun run dev` before running this,
 * then restart it afterwards.
 */
import { sql } from "drizzle-orm";
import { getDb, closeDb } from "../src/db/connection";

const arg = process.argv[2];

const db = getDb();

const modeRows = arg
  ? await db.execute(sql`SELECT id, name, slug, builtin, tool_restriction, allowed_tools, extension_ids FROM modes WHERE slug = ${arg} OR id = ${arg}`)
  : await db.execute(sql`SELECT id, name, slug, builtin, tool_restriction, allowed_tools, extension_ids FROM modes ORDER BY name`);

const rows = (modeRows as { rows?: any[] }).rows ?? (modeRows as any);
console.log(`\n=== Modes (${rows.length}) ===`);
for (const m of rows) {
  console.log(`\n• ${m.name} [${m.slug}] (builtin=${m.builtin})`);
  console.log(`  id=${m.id}`);
  console.log(`  tool_restriction=${m.tool_restriction}`);
  console.log(`  allowed_tools=${JSON.stringify(m.allowed_tools)}`);
  console.log(`  extension_ids=${JSON.stringify(m.extension_ids)}`);

  if (Array.isArray(m.extension_ids) && m.extension_ids.length > 0) {
    for (const extId of m.extension_ids) {
      const extRes = await db.execute(sql`SELECT id, name, enabled, manifest FROM extensions WHERE id = ${extId}`);
      const extRows = (extRes as { rows?: any[] }).rows ?? (extRes as any);
      const ext = extRows[0];
      if (!ext) {
        console.log(`    ↳ ext ${extId}: NOT FOUND in extensions table — likely deleted/uninstalled`);
        continue;
      }
      const manifest = typeof ext.manifest === "string" ? JSON.parse(ext.manifest) : ext.manifest;
      const toolNames = (manifest?.tools ?? []).map((t: any) => `${manifest.name}__${t.name}`);
      console.log(`    ↳ ext ${ext.name} (${extId})`);
      console.log(`        enabled=${ext.enabled}`);
      console.log(`        exposes tools: ${JSON.stringify(toolNames)}`);
      if (!ext.enabled) {
        console.log(`        ⚠️  DISABLED — registry.loadFromDb() skips it. Mode-attached`);
        console.log(`            tools will not wire at runtime. Enable the extension or`);
        console.log(`            attach a different one.`);
      }
    }
  }
}

await closeDb();
