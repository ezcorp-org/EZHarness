/**
 * Real-module coverage for `src/db/connection.ts`'s PGlite init path.
 *
 * `db-connection.test.ts` deliberately `mock.module("../db/connection", …)`
 * with a hand-rolled PGlite copy to test the *logic* deterministically, and the
 * common path (`test-pglite.ts`'s `mockDbConnection()`) hands tests an
 * in-memory PGlite — so NO suite executes the REAL module's `initPglite()`
 * (extension load, stale-lock sweep, pre-boot snapshot, `openPglite`, drizzle
 * wire, `migrate`, readiness). This file drives the REAL module so that init
 * path is covered on its own merits.
 *
 * The DB path is owned by `preload.ts`, which pins a throwaway per-process
 * `EZCORP_DB_PATH` BEFORE it snapshots (and thus freezes the const in)
 * connection.ts — so we read the resolved path back via `getDbPath()` rather
 * than trying to set it here (too late: the const is already captured).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { holderPidPath, readHolderPid } from "../db/live-holder-guard";

let conn: typeof import("../db/connection");

describe("connection.ts — real PGlite init path", () => {
  beforeAll(async () => {
    conn = await import("../db/connection");
    await conn.initDb();
  });

  afterAll(async () => {
    await conn.closeDb();
    // preload created the throwaway data dir; remove the whole temp tree.
    const p = conn.getDbPath();
    if (p && p !== ":memory:" && p !== "external") {
      rmSync(dirname(p), { recursive: true, force: true });
    }
  });

  test("initDb opens PGlite on disk and creates the data dir", () => {
    const p = conn.getDbPath();
    expect(p).not.toBe(":memory:");
    expect(p).not.toBe("external");
    expect(existsSync(p)).toBe(true);
    expect(conn.getPglite()).not.toBeNull();
  });

  test("getDb returns the same drizzle instance after init (singleton)", () => {
    expect(conn.getDb()).toBe(conn.getDb());
  });

  test("initDb is idempotent — a second call reuses the cached PGlite handle", async () => {
    const pgBefore = conn.getPglite();
    await conn.initDb();
    expect(conn.getPglite()).toBe(pgBefore);
  });

  test("rawQuery runs positional-param SQL against the live PGlite", async () => {
    const { rows } = await conn.rawQuery("SELECT $1::int AS n", ["7"]);
    expect((rows[0] as { n: number }).n).toBe(7);
  });

  test("migrate() created the schema (known tables present)", async () => {
    const pg = conn.getPglite()!;
    const result = await pg.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = (result.rows as Array<{ table_name: string }>).map((r) => r.table_name);
    expect(names).toContain("settings");
    expect(names).toContain("projects");
    expect(names).toContain("runs");
  });

  test("init claims the datadir via the sidecar pidfile (live-holder guard)", () => {
    const p = conn.getDbPath();
    expect(readHolderPid(p)).toBe(process.pid);
    expect(existsSync(holderPidPath(p))).toBe(true);
  });

  test("closeDb releases the sidecar claim; re-init re-claims (same process passes the guard)", async () => {
    const p = conn.getDbPath();
    await conn.closeDb();
    expect(readHolderPid(p)).toBeNull();
    // Re-init in the SAME process must pass the guard and re-claim.
    await conn.initDb();
    expect(readHolderPid(p)).toBe(process.pid);
  });
});
