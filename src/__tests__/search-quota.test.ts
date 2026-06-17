/**
 * `src/search/search-quota.ts` — the per-extension/day call counter.
 *
 * Covers: in-process consume + durable upsert to
 * `extension_search_calls_daily`; over-limit deny with `retryAfterMs`;
 * `hydrateSearchQuota` seeding today's counter from the durable row so a
 * restart can't reset the budget; and the test-reset helper.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock, spyOn } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";
import * as connection from "../db/connection";

mock.module("../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import { consumeSearchQuota, hydrateSearchQuota, _resetSearchQuotaForTests } from "../search/search-quota";
import { extensions, extensionSearchCallsDaily } from "../db/schema";
import { eq } from "drizzle-orm";

let extA: string;
let extB: string;

async function ensureExtension(name: string): Promise<string> {
  const [row] = await getTestDb().insert(extensions).values({
    name, version: "0.0.1", description: "",
    manifest: { schemaVersion: 2, name, version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as never,
    source: "test", enabled: true, grantedPermissions: {} as never,
  }).returning({ id: extensions.id });
  return row!.id;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

beforeAll(async () => {
  await setupTestDb();
  extA = await ensureExtension("quota-ext-a");
  extB = await ensureExtension("quota-ext-b");
}, 30_000);

beforeEach(async () => {
  _resetSearchQuotaForTests();
  await getTestDb().delete(extensionSearchCallsDaily);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("consumeSearchQuota", () => {
  test("consumes up to the limit, then denies with retryAfterMs", () => {
    expect(consumeSearchQuota(extA, 2).ok).toBe(true);
    expect(consumeSearchQuota(extA, 2).ok).toBe(true);
    const denied = consumeSearchQuota(extA, 2);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  test("accounting is per-extension (B unaffected by A's spend)", () => {
    consumeSearchQuota(extA, 1);
    expect(consumeSearchQuota(extA, 1).ok).toBe(false); // A exhausted
    expect(consumeSearchQuota(extB, 1).ok).toBe(true); // B fresh
  });

  test("durable upsert lands in extension_search_calls_daily", async () => {
    consumeSearchQuota(extA, 5);
    consumeSearchQuota(extA, 5);
    consumeSearchQuota(extA, 5);
    await new Promise((r) => setTimeout(r, 30));
    const rows = await getTestDb().select().from(extensionSearchCallsDaily).where(eq(extensionSearchCallsDaily.extensionId, extA));
    expect(rows.length).toBe(1);
    expect(rows[0]!.calls).toBe(3);
    expect(rows[0]!.day).toBe(today());
  });
});

describe("hydrateSearchQuota", () => {
  test("seeds today's in-process counter from the durable row (restart resilience)", async () => {
    // Simulate a prior process that recorded 4 calls today.
    await getTestDb().insert(extensionSearchCallsDaily).values({ extensionId: extA, day: today(), calls: 4 });
    // Fresh process: no in-memory counter yet.
    _resetSearchQuotaForTests();
    await hydrateSearchQuota(extA);
    // With a quota of 5, only ONE call should remain before deny.
    expect(consumeSearchQuota(extA, 5).ok).toBe(true); // 5th
    expect(consumeSearchQuota(extA, 5).ok).toBe(false); // 6th over
  });

  test("hydrate with no durable row → counter starts at zero", async () => {
    await hydrateSearchQuota(extB);
    expect(consumeSearchQuota(extB, 1).ok).toBe(true);
  });

  test("a DB error during hydrate is swallowed (warns, doesn't throw)", async () => {
    const spy = spyOn(connection, "getDb").mockImplementation(() => {
      throw new Error("connection lost");
    });
    try {
      // Must not reject — hydrate degrades gracefully on a DB hiccup.
      await expect(hydrateSearchQuota(extA)).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  test("a DB error during the consume upsert is swallowed (fire-and-forget warn)", async () => {
    const spy = spyOn(connection, "getDb").mockImplementation(() => {
      throw new Error("upsert exploded");
    });
    try {
      // The sync consume still succeeds (in-process counter authoritative);
      // the async durable upsert throws and is swallowed.
      expect(consumeSearchQuota(extB, 10).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      spy.mockRestore();
    }
  });

  test("hydrate is idempotent — won't clobber a populated today-counter", async () => {
    consumeSearchQuota(extA, 10); // in-process count = 1
    await new Promise((r) => setTimeout(r, 20)); // let the durable upsert land
    // A stale durable row claims 9 — but the live counter is authoritative.
    await getTestDb().update(extensionSearchCallsDaily).set({ calls: 9 }).where(eq(extensionSearchCallsDaily.extensionId, extA));
    await hydrateSearchQuota(extA);
    // Still only 1 consumed in-process → 9 remain.
    for (let i = 0; i < 9; i++) expect(consumeSearchQuota(extA, 10).ok).toBe(true);
    expect(consumeSearchQuota(extA, 10).ok).toBe(false);
  });
});
