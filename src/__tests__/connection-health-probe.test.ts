/**
 * Regression for "/api/health reports the database as down on every
 * external-Postgres deployment".
 *
 * buildHealthResponse() used to probe DB liveness ONLY via getPglite() +
 * pg.query("SELECT 1"). Under Bun.sql (DATABASE_URL set), initPostgres() sets
 * the PGlite handle to null forever, so getPglite() returns null and the probe
 * was skipped entirely — the Bun.sql pool was NEVER checked, health stayed
 * permanently "degraded / db down" even on a perfectly healthy Postgres, and a
 * genuine outage was indistinguishable from that false alarm.
 *
 * These tests drive the REAL buildHealthResponse against the REAL connection
 * module, simulating external-Postgres mode with `__test.setState(db, null)`
 * so getPglite() returns null and the driver-agnostic getDb().execute() branch
 * is the one under test.
 */
import { test, expect, describe, afterAll, afterEach } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

restoreModuleMocks();
const conn = await import("../db/connection");
const { buildHealthResponse } = await import("../health");

const openPgs: PGlite[] = [];
async function realExternalDb() {
  // A live drizzle handle whose execute() works, standing in for the Bun.sql
  // pool. getPglite() stays null → the fallback branch runs.
  const pg = new PGlite();
  await pg.waitReady;
  openPgs.push(pg);
  return drizzle(pg);
}

afterEach(() => {
  conn.__test.setState(null, null);
});

afterAll(async () => {
  for (const pg of openPgs.splice(0)) await pg.close().catch(() => {});
  restoreModuleMocks();
});

describe("buildHealthResponse — external Postgres DB probe", () => {
  test("healthy when the Bun.sql handle answers SELECT 1 (PGlite null)", async () => {
    conn.__test.setState(await realExternalDb(), null);
    const result = await buildHealthResponse(false);
    expect(result.status).toBe("healthy");
  });

  test("detail mode reports db up via the driver-agnostic probe", async () => {
    conn.__test.setState(await realExternalDb(), null);
    const result = await buildHealthResponse(true);
    expect(result.db!.status).toBe("up");
  });

  test("degraded when the external handle's execute() rejects", async () => {
    const brokenDb = { execute: () => Promise.reject(new Error("connection refused")) };
    conn.__test.setState(brokenDb, null);
    const result = await buildHealthResponse(false);
    expect(result.status).toBe("degraded");
  });

  test("degraded when neither driver is initialized", async () => {
    conn.__test.setState(null, null);
    const result = await buildHealthResponse(false);
    expect(result.status).toBe("degraded");
  });

  test("still probes PGlite directly when the embedded handle is present", async () => {
    const pg = new PGlite();
    await pg.waitReady;
    openPgs.push(pg);
    // pglite set → the getPglite() fast-path is used (not the fallback).
    conn.__test.setState(drizzle(pg), pg);
    const result = await buildHealthResponse(false);
    expect(result.status).toBe("healthy");
  });
});
