// Tests for the Ez `allowed_tools` migration.
//
// The migration ensures the builtin Ez mode's `allowed_tools` array
// references the bundled extension-author tool under its RUNTIME
// namespaced name `extension-author__create_extension` (double
// underscore). A prior migration seeded the wrong `/` separator, which
// never matched the runtime tool name; the restore migration fixes stale
// rows in place (array_replace) and appends the correct name when missing.
// Idempotent: re-running is a no-op.

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
  test("ez mode references the runtime-namespaced extension-author__create_extension", async () => {
    const rows = await getTestDb().execute(sql`SELECT allowed_tools FROM modes WHERE slug = 'ez'`);
    // PGlite returns an array of objects keyed by column name.
    const r = (rows as unknown as { rows?: Array<{ allowed_tools: string[] }> }).rows
      ?? (rows as unknown as Array<{ allowed_tools: string[] }>);
    const allowedTools = r[0]?.allowed_tools ?? [];
    expect(allowedTools).toContain("extension-author__create_extension");
    // The stale slash-separator form must NOT survive — it never matched
    // the runtime tool name, so the tool was neither listed nor callable.
    expect(allowedTools).not.toContain("extension-author/create_extension");
  });

  test("ez mode preserves the nine native Ez tools", async () => {
    const rows = await getTestDb().execute(sql`SELECT allowed_tools FROM modes WHERE slug = 'ez'`);
    const r = (rows as unknown as { rows?: Array<{ allowed_tools: string[] }> }).rows
      ?? (rows as unknown as Array<{ allowed_tools: string[] }>);
    const allowedTools = r[0]?.allowed_tools ?? [];
    for (const expected of [
      "propose_create_project",
      "propose_create_agent",
      "propose_install_extension",
      "summarize_conversation",
      "search_conversation",
      "find_agents",
      "fill_form",
      "navigate_to",
      "read_page",
    ]) {
      expect(allowedTools).toContain(expected);
    }
  });

  test("search_conversation append (step 9e) is idempotent and heals a missing row", async () => {
    // Fresh installs seed search_conversation, so re-running 9e's append is a
    // no-op; simulate a pre-9e install by removing it, then run the exact
    // append the migration emits and confirm it lands back exactly once.
    await getTestDb().execute(sql`
      UPDATE modes
      SET allowed_tools = array_remove(allowed_tools, 'search_conversation')
      WHERE slug = 'ez'
    `);
    const appendStep = sql`
      UPDATE modes
      SET allowed_tools = array_append(allowed_tools, 'search_conversation')
      WHERE slug = 'ez'
        AND NOT ('search_conversation' = ANY(allowed_tools))
    `;
    await getTestDb().execute(appendStep);
    await getTestDb().execute(appendStep); // re-run — must not duplicate
    const rows = await getTestDb().execute(sql`SELECT allowed_tools FROM modes WHERE slug = 'ez'`);
    const r = (rows as unknown as { rows?: Array<{ allowed_tools: string[] }> }).rows
      ?? (rows as unknown as Array<{ allowed_tools: string[] }>);
    const allowedTools = r[0]?.allowed_tools ?? [];
    expect(allowedTools.filter((t) => t === "search_conversation").length).toBe(1);
  });

  test("migration is idempotent: re-running append does not duplicate the entry", async () => {
    // Re-run the same append UPDATE the migration emitted (correct name).
    await getTestDb().execute(sql`
      UPDATE modes
      SET allowed_tools = array_append(allowed_tools, 'extension-author__create_extension')
      WHERE slug = 'ez'
        AND NOT ('extension-author__create_extension' = ANY(allowed_tools))
    `);
    const rows = await getTestDb().execute(sql`SELECT allowed_tools FROM modes WHERE slug = 'ez'`);
    const r = (rows as unknown as { rows?: Array<{ allowed_tools: string[] }> }).rows
      ?? (rows as unknown as Array<{ allowed_tools: string[] }>);
    const allowedTools = r[0]?.allowed_tools ?? [];
    const occurrences = allowedTools.filter((t) => t === "extension-author__create_extension").length;
    expect(occurrences).toBe(1);
  });

  test("the replace→append sequence heals a stale slash-form row without duplicating", async () => {
    // Simulate a pre-restore row: force the wrong separator back in, then
    // re-run the migration's two steps (9a replace, 9b append) in order.
    await getTestDb().execute(sql`
      UPDATE modes
      SET allowed_tools = array_append(
        array_remove(allowed_tools, 'extension-author__create_extension'),
        'extension-author/create_extension'
      )
      WHERE slug = 'ez'
    `);
    await getTestDb().execute(sql`
      UPDATE modes
      SET allowed_tools = array_replace(allowed_tools, 'extension-author/create_extension', 'extension-author__create_extension')
      WHERE slug = 'ez'
        AND 'extension-author/create_extension' = ANY(allowed_tools)
    `);
    await getTestDb().execute(sql`
      UPDATE modes
      SET allowed_tools = array_append(allowed_tools, 'extension-author__create_extension')
      WHERE slug = 'ez'
        AND NOT ('extension-author__create_extension' = ANY(allowed_tools))
    `);
    const rows = await getTestDb().execute(sql`SELECT allowed_tools FROM modes WHERE slug = 'ez'`);
    const r = (rows as unknown as { rows?: Array<{ allowed_tools: string[] }> }).rows
      ?? (rows as unknown as Array<{ allowed_tools: string[] }>);
    const allowedTools = r[0]?.allowed_tools ?? [];
    expect(allowedTools.filter((t) => t === "extension-author__create_extension").length).toBe(1);
    expect(allowedTools).not.toContain("extension-author/create_extension");
  });
});
