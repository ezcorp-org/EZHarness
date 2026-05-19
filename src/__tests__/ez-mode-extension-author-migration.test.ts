// Tests for the Phase 5 Ez `allowed_tools` migration.
//
// The migration appends `extension-author/create_extension` to the
// builtin Ez mode's `allowed_tools` array. Idempotent: re-running is
// a no-op.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mockDbConnection();

const { sql } = await import("drizzle-orm");

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("Ez mode allowed_tools migration", () => {
  test("ez mode includes extension-author/create_extension", async () => {
    const rows = await getTestDb().execute(sql`SELECT allowed_tools FROM modes WHERE slug = 'ez'`);
    // PGlite returns an array of objects keyed by column name.
    const r = (rows as unknown as { rows?: Array<{ allowed_tools: string[] }> }).rows
      ?? (rows as unknown as Array<{ allowed_tools: string[] }>);
    const allowedTools = r[0]?.allowed_tools ?? [];
    expect(allowedTools).toContain("extension-author/create_extension");
  });

  test("ez mode preserves the original seven tools", async () => {
    const rows = await getTestDb().execute(sql`SELECT allowed_tools FROM modes WHERE slug = 'ez'`);
    const r = (rows as unknown as { rows?: Array<{ allowed_tools: string[] }> }).rows
      ?? (rows as unknown as Array<{ allowed_tools: string[] }>);
    const allowedTools = r[0]?.allowed_tools ?? [];
    for (const expected of [
      "propose_create_project",
      "propose_create_agent",
      "propose_install_extension",
      "summarize_conversation",
      "find_agents",
      "fill_form",
      "navigate_to",
    ]) {
      expect(allowedTools).toContain(expected);
    }
  });

  test("migration is idempotent: re-running does not duplicate the entry", async () => {
    // Re-run the same UPDATE statement the migration emitted.
    await getTestDb().execute(sql`
      UPDATE modes
      SET allowed_tools = array_append(allowed_tools, 'extension-author/create_extension')
      WHERE slug = 'ez'
        AND NOT ('extension-author/create_extension' = ANY(allowed_tools))
    `);
    const rows = await getTestDb().execute(sql`SELECT allowed_tools FROM modes WHERE slug = 'ez'`);
    const r = (rows as unknown as { rows?: Array<{ allowed_tools: string[] }> }).rows
      ?? (rows as unknown as Array<{ allowed_tools: string[] }>);
    const allowedTools = r[0]?.allowed_tools ?? [];
    const occurrences = allowedTools.filter((t) => t === "extension-author/create_extension").length;
    expect(occurrences).toBe(1);
  });
});
