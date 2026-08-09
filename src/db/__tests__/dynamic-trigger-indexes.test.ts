/**
 * C2 build-order step 1 — the `uniq_ext_schedule` / `uniq_ext_webhook`
 * widening, proven in isolation before any dynamic row can exist.
 *
 * The constraint this replaces was `(extension_id, cron)` UNIQUE, which
 * blocks two dynamic jobs from sharing a cron expression — the NORMAL case
 * (two users each wanting "0 9 * * 1"), not an edge case. One total index
 * becomes two partials:
 *   - manifest `(extension_id, cron) WHERE dynamic = FALSE`
 *   - dynamic  `(extension_id, key)  WHERE key IS NOT NULL`
 *
 * These tests pin BOTH halves: the manifest half must still reject exactly
 * what it rejected before (so no existing row loses its dedupe), and the
 * dynamic half must admit a shared cron while still rejecting a duplicate
 * key. Without the first assertion the widening could silently be a
 * removal.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestDb,
} from "../../__tests__/helpers/test-pglite";

mock.module("../../db/queries/settings", () => ({
  async getAllSettings() {
    return {};
  },
  async getSetting() {
    return undefined;
  },
  async upsertSetting() {},
  async deleteSetting() {
    return false;
  },
  async isListingInstalled() {
    return false;
  },
}));

mockDbConnection();

import { extensionSchedules, extensionWebhooks, extensions } from "../schema";
import { eq } from "drizzle-orm";

let extId: string;
let extName: string;
let extId2: string;
let extName2: string;

async function ensureExtension(name: string): Promise<string> {
  const [row] = await getTestDb()
    .insert(extensions)
    .values({
      name,
      version: "0.0.1",
      description: "",
      manifest: {
        schemaVersion: 2,
        name,
        version: "0.0.1",
        description: "",
        author: { name: "t" },
        permissions: {},
      } as never,
      source: "test",
      enabled: true,
      grantedPermissions: {} as never,
    })
    .returning({ id: extensions.id });
  return row!.id;
}

const SHARED_CRON = "0 9 * * 1";

/** Drizzle's insert builder is a THENABLE, not a `Promise`, and bun's
 *  `.rejects` matcher requires a real one. Awaiting it inside a plain async
 *  wrapper produces the rejected promise the matcher wants. */
async function insert(builder: PromiseLike<unknown>): Promise<void> {
  await builder;
}

beforeAll(async () => {
  await setupTestDb();
  extName = "idx-ext-1";
  extId = await ensureExtension(extName);
  extName2 = "idx-ext-2";
  extId2 = await ensureExtension(extName2);
});

beforeEach(async () => {
  await getTestDb().delete(extensionSchedules);
  await getTestDb().delete(extensionWebhooks);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("uniq_ext_schedule partials", () => {
  test("two DYNAMIC jobs may share one cron expression (the C2 unblock)", async () => {
    const db = getTestDb();
    await db.insert(extensionSchedules).values({
      extensionId: extId,
      cron: SHARED_CRON,
      nextFireAt: new Date(),
      dynamic: true,
      key: "job:alpha",
    });
    await db.insert(extensionSchedules).values({
      extensionId: extId,
      cron: SHARED_CRON,
      nextFireAt: new Date(),
      dynamic: true,
      key: "job:beta",
    });

    const rows = await db
      .select()
      .from(extensionSchedules)
      .where(eq(extensionSchedules.extensionId, extId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.key).sort()).toEqual(["job:alpha", "job:beta"]);
    // Both carry the SAME cron — the whole point.
    expect(new Set(rows.map((r) => r.cron))).toEqual(new Set([SHARED_CRON]));
  });

  test("the MANIFEST partial still rejects a duplicate (extension, cron)", async () => {
    const db = getTestDb();
    await db.insert(extensionSchedules).values({
      extensionId: extId,
      cron: SHARED_CRON,
      nextFireAt: new Date(),
    });
    // dynamic defaults to FALSE, so this row falls under the manifest
    // partial and must collide exactly as it did before C2.
    await expect(
      insert(
        db.insert(extensionSchedules).values({
          extensionId: extId,
          cron: SHARED_CRON,
          nextFireAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  test("a manifest row and a dynamic row may share a cron", async () => {
    const db = getTestDb();
    await db.insert(extensionSchedules).values({
      extensionId: extId,
      cron: SHARED_CRON,
      nextFireAt: new Date(),
    });
    await db.insert(extensionSchedules).values({
      extensionId: extId,
      cron: SHARED_CRON,
      nextFireAt: new Date(),
      dynamic: true,
      key: "job:gamma",
    });
    const rows = await db
      .select()
      .from(extensionSchedules)
      .where(eq(extensionSchedules.extensionId, extId));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.dynamic)).toHaveLength(1);
  });

  test("the DYNAMIC partial rejects a duplicate key for one extension", async () => {
    const db = getTestDb();
    await db.insert(extensionSchedules).values({
      extensionId: extId,
      cron: "0 9 * * 1",
      nextFireAt: new Date(),
      dynamic: true,
      key: "job:dup",
    });
    await expect(
      insert(
        db.insert(extensionSchedules).values({
          // Different cron — key alone is the dynamic identity.
          extensionId: extId,
          cron: "0 10 * * 1",
          nextFireAt: new Date(),
          dynamic: true,
          key: "job:dup",
        }),
      ),
    ).rejects.toThrow();
  });

  test("the same key under a DIFFERENT extension is allowed", async () => {
    const db = getTestDb();
    await db.insert(extensionSchedules).values({
      extensionId: extId,
      cron: SHARED_CRON,
      nextFireAt: new Date(),
      dynamic: true,
      key: "job:shared-name",
    });
    await db.insert(extensionSchedules).values({
      extensionId: extId2,
      cron: SHARED_CRON,
      nextFireAt: new Date(),
      dynamic: true,
      key: "job:shared-name",
    });
    const rows = await db.select().from(extensionSchedules);
    expect(rows).toHaveLength(2);
  });

  test("many manifest rows with NULL key do not collide on the dynamic partial", async () => {
    // `WHERE key IS NOT NULL` is what keeps the dynamic partial off every
    // manifest row; without it the second NULL-key row would collide and
    // the migration would break every existing install.
    const db = getTestDb();
    await db.insert(extensionSchedules).values({
      extensionId: extId,
      cron: "0 1 * * *",
      nextFireAt: new Date(),
    });
    await db.insert(extensionSchedules).values({
      extensionId: extId,
      cron: "0 2 * * *",
      nextFireAt: new Date(),
    });
    const rows = await db
      .select()
      .from(extensionSchedules)
      .where(eq(extensionSchedules.extensionId, extId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.key === null)).toBe(true);
    expect(rows.every((r) => r.dynamic === false)).toBe(true);
  });
});

describe("uniq_ext_webhook — total slug index + dynamic key partial", () => {
  // Deliberately NOT symmetric with the schedule twin. The slug index stays
  // TOTAL, so a manifest row and a dynamic row can never share a slug —
  // `getEnabledWebhook` is `rows[0] ?? null` with no ORDER BY, so two matching
  // rows would let a public inbound route resolve non-deterministically.
  test("a DYNAMIC row cannot take a slug a MANIFEST row already holds", async () => {
    const db = getTestDb();
    await db
      .insert(extensionWebhooks)
      .values({ extensionId: extName, slug: "factory-eeeeeeeeeeee" });
    await expect(
      insert(
        db.insert(extensionWebhooks).values({
          extensionId: extName,
          slug: "factory-eeeeeeeeeeee",
          dynamic: true,
          key: "job:collide",
        }),
      ),
    ).rejects.toThrow();
  });

  test("a MANIFEST row cannot take a slug a DYNAMIC row already holds", async () => {
    const db = getTestDb();
    await db.insert(extensionWebhooks).values({
      extensionId: extName,
      slug: "factory-ffffffffffff",
      dynamic: true,
      key: "job:first",
    });
    await expect(
      insert(
        db.insert(extensionWebhooks).values({ extensionId: extName, slug: "factory-ffffffffffff" }),
      ),
    ).rejects.toThrow();
  });

  test("the total slug index still rejects a duplicate (extension, slug)", async () => {
    const db = getTestDb();
    await db.insert(extensionWebhooks).values({ extensionId: extName, slug: "tickets" });
    await expect(
      insert(db.insert(extensionWebhooks).values({ extensionId: extName, slug: "tickets" })),
    ).rejects.toThrow();
  });

  test("the DYNAMIC partial rejects a duplicate key and admits distinct ones", async () => {
    const db = getTestDb();
    await db.insert(extensionWebhooks).values({
      extensionId: extName,
      slug: "factory-aaaaaaaaaaaa",
      dynamic: true,
      key: "job:alpha",
    });
    await db.insert(extensionWebhooks).values({
      extensionId: extName,
      slug: "factory-bbbbbbbbbbbb",
      dynamic: true,
      key: "job:beta",
    });
    expect(await db.select().from(extensionWebhooks)).toHaveLength(2);

    await expect(
      insert(
        db.insert(extensionWebhooks).values({
          extensionId: extName,
          slug: "factory-cccccccccccc",
          dynamic: true,
          key: "job:alpha",
        }),
      ),
    ).rejects.toThrow();
  });

  test("unregister frees the key so the same key can be re-registered", async () => {
    // Soft-delete sets `key = NULL`, which drops the row out of the
    // dynamic partial. Without that, a re-register after an unregister
    // would collide with the tombstone forever.
    const db = getTestDb();
    const [row] = await db
      .insert(extensionWebhooks)
      .values({
        extensionId: extName,
        slug: "factory-dddddddddddd",
        dynamic: true,
        key: "job:recycle",
      })
      .returning();
    await db
      .update(extensionWebhooks)
      .set({ enabled: false, key: null })
      .where(eq(extensionWebhooks.id, row!.id));

    await db.insert(extensionWebhooks).values({
      extensionId: extName,
      slug: "factory-eeeeeeeeeeee",
      dynamic: true,
      key: "job:recycle",
    });
    const rows = await db
      .select()
      .from(extensionWebhooks)
      .where(eq(extensionWebhooks.extensionId, extName));
    expect(rows).toHaveLength(2);
    // The tombstone survives with its delivery history intact.
    expect(rows.filter((r) => r.key === null && !r.enabled)).toHaveLength(1);
  });
});
