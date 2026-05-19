import { mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
// Mirror production connection.ts — pg_trgm must register at construction.
// UX-02 (Phase 57-04 Task 1): SQL `CREATE EXTENSION pg_trgm` is no-op
// without this contrib import, so `similarity(...)` would 42883.
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../db/schema";
import { migrate } from "../../db/migrate";

// Use the pristine globals snapshot saved by preload.ts (captured before any test file loads).
// Falls back to current globals at import time if preload didn't run.
const _pristineFetch: typeof fetch = (globalThis as any).__pristineFetch ?? globalThis.fetch;
const _pristineWebSocket: typeof WebSocket = (globalThis as any).__pristineWebSocket ?? globalThis.WebSocket;

let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

export async function setupTestDb() {
  if (pglite) await pglite.close().catch(() => {});
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
  return { pglite, db };
}

export function getTestDb() {
  if (!db) throw new Error("Test DB not initialized — call setupTestDb() first");
  return db;
}

export function getTestPglite() {
  return pglite;
}

export async function closeTestDb() {
  if (pglite) await pglite.close().catch(() => {});
}

// Must be called at module level BEFORE importing any modules that use db/connection
export function mockDbConnection() {
  mock.module("../../db/connection", () => ({
    getDb: () => {
      if (!db) throw new Error("Test DB not initialized — call setupTestDb() first");
      return db;
    },
    getPglite: () => pglite,
    getDbPath: () => ":memory:",
    initDb: async () => {},
    closeDb: async () => {},
  }));
}

// Restore pristine globalThis.fetch and globalThis.WebSocket (guards against test
// files that replace them at module level and fail to clean up).
export function restoreFetch() {
  globalThis.fetch = _pristineFetch;
  globalThis.WebSocket = _pristineWebSocket;
}

// Re-establish real settings implementation backed by the test DB.
// Call at module level alongside mockDbConnection() to override any leaked
// settings mock from a previous test file (Bun mock.module leaks across files).
export function mockRealSettings() {
  mock.module("../../db/queries/settings", () => {
    const { eq } = require("drizzle-orm");
    const { settings: tbl } = require("../../db/schema");
    return {
      async getAllSettings() {
        const rows = await db.select().from(tbl);
        return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
      },
      async getSetting(key: string) {
        const rows = await db.select().from(tbl).where(eq(tbl.key, key));
        return rows[0]?.value;
      },
      async upsertSetting(key: string, value: unknown) {
        const rows = await db.select().from(tbl).where(eq(tbl.key, key));
        if (rows[0]) {
          await db.update(tbl).set({ value, updatedAt: new Date() }).where(eq(tbl.key, key));
        } else {
          await db.insert(tbl).values({ key, value, updatedAt: new Date() });
        }
      },
      async deleteSetting(key: string) {
        const rows = await db.select().from(tbl).where(eq(tbl.key, key));
        if (!rows[0]) return false;
        await db.delete(tbl).where(eq(tbl.key, key));
        return true;
      },
      async isListingInstalled() { return false; },
    };
  });
}
