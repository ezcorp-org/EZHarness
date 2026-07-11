import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { setupTestDb, closeTestDb } from "./helpers/test-pglite";
import {
  seedSelfProject,
  SELF_PROJECT_ID,
  SELF_PROJECT_DEFAULT_NAME,
  SELF_PROJECT_ICON,
  SELF_PROJECT_SYSTEM_PROMPT,
} from "../db/seed-self-project";
import { migrate } from "../db/migrate";

// A real, existing directory for the happy paths (existsSync gate).
const repoDir = mkdtempSync(join(tmpdir(), "ezcorp-self-project-"));
const movedDir = mkdtempSync(join(tmpdir(), "ezcorp-self-project-moved-"));

let db: Awaited<ReturnType<typeof setupTestDb>>["db"];

beforeEach(async () => {
  ({ db } = await setupTestDb());
});

afterAll(async () => {
  await closeTestDb();
});

async function selfRow() {
  const result = await db.execute(
    sql`SELECT id, name, path, icon FROM projects WHERE id = ${SELF_PROJECT_ID}`,
  );
  return result.rows as Array<{ id: string; name: string; path: string; icon: string | null }>;
}

async function promptSetting() {
  const result = await db.execute(
    sql`SELECT value FROM settings WHERE key = ${`project:${SELF_PROJECT_ID}:systemPrompt`}`,
  );
  return result.rows as Array<{ value: unknown }>;
}

describe("seedSelfProject", () => {
  test("no-op when EZCORP_SELF_PROJECT_PATH is unset", async () => {
    await seedSelfProject(db, {});
    expect(await selfRow()).toHaveLength(0);
    expect(await promptSetting()).toHaveLength(0);
  });

  test("warns and skips when the path does not exist", async () => {
    await seedSelfProject(db, { EZCORP_SELF_PROJECT_PATH: join(repoDir, "does-not-exist") });
    expect(await selfRow()).toHaveLength(0);
  });

  test("seeds the project with the default name, icon, and the guidance prompt", async () => {
    await seedSelfProject(db, { EZCORP_SELF_PROJECT_PATH: repoDir });
    const rows = await selfRow();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: SELF_PROJECT_ID,
      name: SELF_PROJECT_DEFAULT_NAME,
      path: repoDir,
      icon: SELF_PROJECT_ICON,
    });
    const prompt = await promptSetting();
    expect(prompt).toHaveLength(1);
    // Stored as a JSON string scalar (resolveSystemPrompt casts value → string).
    expect(prompt[0]?.value).toBe(SELF_PROJECT_SYSTEM_PROMPT);
  });

  test("honors EZCORP_SELF_PROJECT_NAME on first insert", async () => {
    await seedSelfProject(db, {
      EZCORP_SELF_PROJECT_PATH: repoDir,
      EZCORP_SELF_PROJECT_NAME: "My EZCorp",
    });
    const rows = await selfRow();
    expect(rows[0]?.name).toBe("My EZCorp");
  });

  test("re-run with the same path is a no-op (single row, prompt not duplicated)", async () => {
    const env = { EZCORP_SELF_PROJECT_PATH: repoDir };
    await seedSelfProject(db, env);
    await seedSelfProject(db, env);
    expect(await selfRow()).toHaveLength(1);
    expect(await promptSetting()).toHaveLength(1);
  });

  test("path drift updates path but preserves a user-renamed name", async () => {
    await seedSelfProject(db, { EZCORP_SELF_PROJECT_PATH: repoDir });
    await db.execute(sql`UPDATE projects SET name = 'Renamed' WHERE id = ${SELF_PROJECT_ID}`);
    await seedSelfProject(db, { EZCORP_SELF_PROJECT_PATH: movedDir });
    const rows = await selfRow();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Renamed", path: movedDir });
  });

  test("backfills a NULL icon on pre-existing rows; never overwrites a user-chosen icon", async () => {
    // Row seeded before the icon existed (icon NULL).
    await db.execute(
      sql`INSERT INTO projects (id, name, path) VALUES (${SELF_PROJECT_ID}, 'EZCorp (this app)', ${repoDir})`,
    );
    await seedSelfProject(db, { EZCORP_SELF_PROJECT_PATH: repoDir });
    expect((await selfRow())[0]?.icon).toBe(SELF_PROJECT_ICON);
    // A user-chosen icon survives later re-seeds, even through a path change.
    await db.execute(sql`UPDATE projects SET icon = 'custom-icon' WHERE id = ${SELF_PROJECT_ID}`);
    await seedSelfProject(db, { EZCORP_SELF_PROJECT_PATH: movedDir });
    const rows = await selfRow();
    expect(rows[0]).toMatchObject({ path: movedDir, icon: "custom-icon" });
  });

  test("a deleted guidance prompt is never re-seeded", async () => {
    await seedSelfProject(db, { EZCORP_SELF_PROJECT_PATH: repoDir });
    await db.execute(sql`DELETE FROM settings WHERE key = ${`project:${SELF_PROJECT_ID}:systemPrompt`}`);
    // Same path (full no-op) and changed path (UPDATE branch) both leave it deleted.
    await seedSelfProject(db, { EZCORP_SELF_PROJECT_PATH: repoDir });
    await seedSelfProject(db, { EZCORP_SELF_PROJECT_PATH: movedDir });
    expect(await promptSetting()).toHaveLength(0);
  });

  test("migrate() runs the seed when EZCORP_SELF_PROJECT_PATH is set", async () => {
    // preload.ts scrubs this var before suites run; set it here to cover the
    // seeded branch of migrate()'s call line, then restore for later suites.
    const prev = process.env.EZCORP_SELF_PROJECT_PATH;
    process.env.EZCORP_SELF_PROJECT_PATH = repoDir;
    try {
      await migrate(db);
      const rows = await selfRow();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.path).toBe(repoDir);
    } finally {
      if (prev === undefined) delete process.env.EZCORP_SELF_PROJECT_PATH;
      else process.env.EZCORP_SELF_PROJECT_PATH = prev;
    }
  });
});
