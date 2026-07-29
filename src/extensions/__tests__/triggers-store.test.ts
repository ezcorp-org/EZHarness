/**
 * `triggers-store.ts` — row CRUD, host slug minting, per-key quota (C2
 * build-order step 3). Pure persistence; the permission ladder is tested
 * separately against `triggers-handler.ts`.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb, closeTestDb, mockDbConnection, getTestDb,
} from "../../__tests__/helpers/test-pglite";

mock.module("../../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import {
  mintWebhookSlug, defaultPerKeyCap, isMintableSlug,
  TRIGGER_KEY_RE, WEBHOOK_PREFIX_RE,
  listDynamicCrons, listDynamicWebhooks,
  getDynamicCron, getDynamicWebhook,
  upsertDynamicCron, upsertDynamicWebhook,
  deleteDynamicCron, softDeleteDynamicWebhook,
  disableDynamicCrons, disableDynamicWebhooks,
  manifestSlugExists, todaysFireCountForSchedule,
} from "../triggers-store";
import {
  extensionSchedules, extensionScheduleFires, extensionWebhooks, extensions,
} from "../../db/schema";
import { eq } from "drizzle-orm";

const EXT_A = "store-ext-a";
const EXT_B = "store-ext-b";
let extIdA: string;
let extIdB: string;

const NOW = new Date("2026-07-29T12:00:00.000Z");
const NEXT = new Date("2026-07-30T09:00:00.000Z");

async function ensureExtension(name: string): Promise<string> {
  const [row] = await getTestDb().insert(extensions).values({
    name, version: "0.0.1", description: "",
    manifest: {
      schemaVersion: 2, name, version: "0.0.1", description: "",
      author: { name: "t" }, permissions: {},
    } as never,
    source: "test", enabled: true, grantedPermissions: {} as never,
  }).returning({ id: extensions.id });
  return row!.id;
}

beforeAll(async () => {
  await setupTestDb();
  extIdA = await ensureExtension(EXT_A);
  extIdB = await ensureExtension(EXT_B);
});

beforeEach(async () => {
  await getTestDb().delete(extensionScheduleFires);
  await getTestDb().delete(extensionSchedules);
  await getTestDb().delete(extensionWebhooks);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

function cron(key: string, expr = "0 9 * * 1") {
  return {
    extensionId: extIdA, key, cron: expr, timezone: null,
    nextFireAt: NEXT, maxRunsPerDay: 10, now: NOW,
  };
}

describe("mintWebhookSlug", () => {
  test("is deterministic for the same (extension, key)", () => {
    const a = mintWebhookSlug("factory-", EXT_A, "job:1");
    const b = mintWebhookSlug("factory-", EXT_A, "job:1");
    expect(a).toBe(b);
  });

  test("diverges across extensions for an IDENTICAL key", () => {
    // The digest covers the registry-resolved extension name, so a shared
    // key cannot produce a shared slug — cross-extension collision is
    // inexpressible rather than merely denied.
    const a = mintWebhookSlug("factory-", EXT_A, "job:1");
    const b = mintWebhookSlug("factory-", EXT_B, "job:1");
    expect(a).not.toBe(b);
  });

  test("diverges across keys under one extension", () => {
    expect(mintWebhookSlug("factory-", EXT_A, "job:1"))
      .not.toBe(mintWebhookSlug("factory-", EXT_A, "job:2"));
  });

  test("always satisfies WEBHOOK_SLUG_RE, including at the longest prefix", () => {
    const longest = "abcdefghijklmnop-"; // 17 chars, the WEBHOOK_PREFIX_RE max
    expect(WEBHOOK_PREFIX_RE.test(longest)).toBe(true);
    for (const key of ["a", "job:1", "j".repeat(64), "job_with-all:chars"]) {
      expect(isMintableSlug(mintWebhookSlug(longest, EXT_A, key))).toBe(true);
      expect(isMintableSlug(mintWebhookSlug("f-", EXT_A, key))).toBe(true);
    }
  });

  test("carries the declared prefix verbatim", () => {
    expect(mintWebhookSlug("factory-", EXT_A, "job:1")).toStartWith("factory-");
  });

  test("the digest tail is 12 lowercase hex chars", () => {
    const slug = mintWebhookSlug("factory-", EXT_A, "job:1");
    expect(slug.slice("factory-".length)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("key + prefix shapes", () => {
  test("TRIGGER_KEY_RE accepts the documented vocabulary", () => {
    for (const ok of ["a", "job:42", "job_x", "job-x", "a".repeat(64)]) {
      expect(TRIGGER_KEY_RE.test(ok)).toBe(true);
    }
  });

  test("TRIGGER_KEY_RE rejects empties, leading punctuation, caps, overlength", () => {
    for (const bad of ["", ":job", "-job", "_job", "Job", "job 1", "job/1", "a".repeat(65)]) {
      expect(TRIGGER_KEY_RE.test(bad)).toBe(false);
    }
  });

  test("WEBHOOK_PREFIX_RE requires a trailing hyphen and bounds length", () => {
    expect(WEBHOOK_PREFIX_RE.test("factory-")).toBe(true);
    expect(WEBHOOK_PREFIX_RE.test("f-")).toBe(true);
    expect(WEBHOOK_PREFIX_RE.test("factory")).toBe(false);   // no trailing -
    expect(WEBHOOK_PREFIX_RE.test("-factory-")).toBe(false); // leading -
    expect(WEBHOOK_PREFIX_RE.test("Factory-")).toBe(false);  // caps
    // 17 is the ceiling: 1 head + 15 body + the trailing hyphen.
    expect(WEBHOOK_PREFIX_RE.test("abcdefghijklmnop-")).toBe(true);  // 17
    expect(WEBHOOK_PREFIX_RE.test("abcdefghijklmnopq-")).toBe(false); // 18
  });

  test("isMintableSlug rejects a malformed slug", () => {
    expect(isMintableSlug("Factory-abc")).toBe(false);
    expect(isMintableSlug("-leading")).toBe(false);
    expect(isMintableSlug("ok-slug")).toBe(true);
  });
});

describe("defaultPerKeyCap", () => {
  test("splits the envelope evenly across the cron cap", () => {
    expect(defaultPerKeyCap(500, 25)).toBe(20);
    expect(defaultPerKeyCap(100, 4)).toBe(25);
  });

  test("floors at 1 rather than disabling a just-created job", () => {
    expect(defaultPerKeyCap(10, 25)).toBe(1);
    expect(defaultPerKeyCap(1, 50)).toBe(1);
  });

  test("a zero cron cap yields the whole envelope", () => {
    // No cron registrations are permitted at all, so there is nothing to
    // divide by; the value is unused but must not be NaN/Infinity.
    expect(defaultPerKeyCap(100, 0)).toBe(100);
  });

  test("rounds down, never up", () => {
    expect(defaultPerKeyCap(10, 3)).toBe(3);
  });
});

describe("cron rows", () => {
  test("register inserts a dynamic row and list returns it", async () => {
    const row = await upsertDynamicCron(cron("job:1"));
    expect(row.dynamic).toBe(true);
    expect(row.key).toBe("job:1");
    expect(row.enabled).toBe(true);
    expect(row.maxRunsPerDay).toBe(10);

    const listed = await listDynamicCrons(extIdA);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(row.id);
  });

  test("list excludes MANIFEST rows", async () => {
    await getTestDb().insert(extensionSchedules).values({
      extensionId: extIdA, cron: "0 3 * * *", nextFireAt: NEXT,
    });
    await upsertDynamicCron(cron("job:1"));
    const listed = await listDynamicCrons(extIdA);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.key).toBe("job:1");
  });

  test("list is scoped to ONE extension", async () => {
    await upsertDynamicCron(cron("job:1"));
    await upsertDynamicCron({ ...cron("job:1"), extensionId: extIdB });
    expect(await listDynamicCrons(extIdA)).toHaveLength(1);
    expect(await listDynamicCrons(extIdB)).toHaveLength(1);
  });

  test("re-register UPDATES IN PLACE (same row id) — T4 idempotency", async () => {
    const first = await upsertDynamicCron(cron("job:1", "0 9 * * 1"));
    const second = await upsertDynamicCron({
      ...cron("job:1", "0 10 * * 2"), maxRunsPerDay: 7,
    });
    expect(second.id).toBe(first.id);
    expect(second.cron).toBe("0 10 * * 2");
    expect(second.maxRunsPerDay).toBe(7);
    expect(await listDynamicCrons(extIdA)).toHaveLength(1);
  });

  test("re-register re-enables and clears consecutive errors", async () => {
    // A job auto-disabled after 5 handler throws must come back when the
    // user saves it again, or "save" silently does nothing.
    const first = await upsertDynamicCron(cron("job:1"));
    await getTestDb().update(extensionSchedules)
      .set({ enabled: false, consecutiveErrors: 5 })
      .where(eq(extensionSchedules.id, first.id));

    const again = await upsertDynamicCron(cron("job:1"));
    expect(again.enabled).toBe(true);
    expect(again.consecutiveErrors).toBe(0);
  });

  test("two keys may share one cron expression", async () => {
    await upsertDynamicCron(cron("job:a", "0 9 * * 1"));
    await upsertDynamicCron(cron("job:b", "0 9 * * 1"));
    const listed = await listDynamicCrons(extIdA);
    expect(listed).toHaveLength(2);
    expect(new Set(listed.map((r) => r.cron))).toEqual(new Set(["0 9 * * 1"]));
  });

  test("timezone round-trips", async () => {
    const row = await upsertDynamicCron({
      ...cron("job:tz"), timezone: "America/New_York",
    });
    expect(row.timezone).toBe("America/New_York");
  });

  test("getDynamicCron finds by key and misses cleanly", async () => {
    await upsertDynamicCron(cron("job:1"));
    expect((await getDynamicCron(extIdA, "job:1"))?.key).toBe("job:1");
    expect(await getDynamicCron(extIdA, "job:absent")).toBeUndefined();
    // Cross-extension lookup must miss even for an existing key.
    expect(await getDynamicCron(extIdB, "job:1")).toBeUndefined();
  });

  test("getDynamicCron never returns a manifest row", async () => {
    await getTestDb().insert(extensionSchedules).values({
      extensionId: extIdA, cron: "0 3 * * *", nextFireAt: NEXT,
    });
    expect(await getDynamicCron(extIdA, "job:1")).toBeUndefined();
  });

  test("delete removes the row and reports whether it did", async () => {
    await upsertDynamicCron(cron("job:1"));
    expect(await deleteDynamicCron(extIdA, "job:1")).toBe(true);
    expect(await listDynamicCrons(extIdA)).toHaveLength(0);
    expect(await deleteDynamicCron(extIdA, "job:1")).toBe(false);
  });
});

describe("webhook rows", () => {
  const slug1 = mintWebhookSlug("factory-", EXT_A, "job:1");

  test("register inserts a dynamic row with the minted slug", async () => {
    const row = await upsertDynamicWebhook({
      extensionName: EXT_A, key: "job:1", slug: slug1, now: NOW,
    });
    expect(row.dynamic).toBe(true);
    expect(row.slug).toBe(slug1);
    expect(row.enabled).toBe(true);
    expect(await listDynamicWebhooks(EXT_A)).toHaveLength(1);
  });

  test("re-register keeps the SAME row and slug — T4 idempotency", async () => {
    const first = await upsertDynamicWebhook({
      extensionName: EXT_A, key: "job:1", slug: slug1, now: NOW,
    });
    const second = await upsertDynamicWebhook({
      extensionName: EXT_A, key: "job:1", slug: slug1, now: NOW,
    });
    expect(second.id).toBe(first.id);
    expect(second.slug).toBe(first.slug);
    expect(await listDynamicWebhooks(EXT_A)).toHaveLength(1);
  });

  test("re-register re-enables a disabled row", async () => {
    const first = await upsertDynamicWebhook({
      extensionName: EXT_A, key: "job:1", slug: slug1, now: NOW,
    });
    await getTestDb().update(extensionWebhooks)
      .set({ enabled: false }).where(eq(extensionWebhooks.id, first.id));
    const again = await upsertDynamicWebhook({
      extensionName: EXT_A, key: "job:1", slug: slug1, now: NOW,
    });
    expect(again.enabled).toBe(true);
  });

  test("list excludes manifest rows and soft-deleted tombstones", async () => {
    await getTestDb().insert(extensionWebhooks).values({
      extensionId: EXT_A, slug: "tickets",
    });
    await upsertDynamicWebhook({
      extensionName: EXT_A, key: "job:1", slug: slug1, now: NOW,
    });
    await upsertDynamicWebhook({
      extensionName: EXT_A, key: "job:2",
      slug: mintWebhookSlug("factory-", EXT_A, "job:2"), now: NOW,
    });
    await softDeleteDynamicWebhook(EXT_A, "job:2", NOW);

    const listed = await listDynamicWebhooks(EXT_A);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.key).toBe("job:1");
  });

  test("getDynamicWebhook finds, misses, and is extension-scoped", async () => {
    await upsertDynamicWebhook({
      extensionName: EXT_A, key: "job:1", slug: slug1, now: NOW,
    });
    expect((await getDynamicWebhook(EXT_A, "job:1"))?.slug).toBe(slug1);
    expect(await getDynamicWebhook(EXT_A, "job:absent")).toBeUndefined();
    expect(await getDynamicWebhook(EXT_B, "job:1")).toBeUndefined();
  });

  test("soft delete preserves the row + delivery history and frees the key", async () => {
    const row = await upsertDynamicWebhook({
      extensionName: EXT_A, key: "job:1", slug: slug1, now: NOW,
    });
    const freed = await softDeleteDynamicWebhook(EXT_A, "job:1", NOW);
    expect(freed).toBe(slug1);

    const after = await getTestDb().select().from(extensionWebhooks)
      .where(eq(extensionWebhooks.id, row.id));
    // Row survives (its `webhook_deliveries` would CASCADE on a hard delete).
    expect(after).toHaveLength(1);
    expect(after[0]!.enabled).toBe(false);
    expect(after[0]!.key).toBeNull();
  });

  test("soft delete of an absent key returns null", async () => {
    expect(await softDeleteDynamicWebhook(EXT_A, "job:absent", NOW)).toBeNull();
  });

  test("a freed key can be registered again", async () => {
    await upsertDynamicWebhook({
      extensionName: EXT_A, key: "job:1", slug: slug1, now: NOW,
    });
    await softDeleteDynamicWebhook(EXT_A, "job:1", NOW);
    const again = await upsertDynamicWebhook({
      extensionName: EXT_A, key: "job:1", slug: slug1, now: NOW,
    });
    expect(again.key).toBe("job:1");
    expect(again.enabled).toBe(true);
    // The tombstone is still there, holding its history.
    const all = await getTestDb().select().from(extensionWebhooks)
      .where(eq(extensionWebhooks.extensionId, EXT_A));
    expect(all).toHaveLength(2);
  });

  test("manifestSlugExists detects a colliding author-declared slug", async () => {
    expect(await manifestSlugExists(EXT_A, slug1)).toBe(false);
    await getTestDb().insert(extensionWebhooks).values({
      extensionId: EXT_A, slug: slug1,
    });
    expect(await manifestSlugExists(EXT_A, slug1)).toBe(true);
    // A DYNAMIC row holding the slug is not a manifest collision.
    expect(await manifestSlugExists(EXT_B, slug1)).toBe(false);
  });
});

describe("disable sweeps", () => {
  test("disableDynamicCrons disables only the named keys and counts them", async () => {
    await upsertDynamicCron(cron("job:1"));
    await upsertDynamicCron(cron("job:2"));
    await upsertDynamicCron(cron("job:3"));

    expect(await disableDynamicCrons(extIdA, ["job:1", "job:3"], NOW)).toBe(2);

    expect((await getDynamicCron(extIdA, "job:1"))!.enabled).toBe(false);
    expect((await getDynamicCron(extIdA, "job:2"))!.enabled).toBe(true);
    expect((await getDynamicCron(extIdA, "job:3"))!.enabled).toBe(false);
  });

  test("disableDynamicCrons skips already-disabled and unknown keys", async () => {
    await upsertDynamicCron(cron("job:1"));
    await disableDynamicCrons(extIdA, ["job:1"], NOW);
    // Second pass: already disabled ⇒ not re-counted. Unknown ⇒ ignored.
    expect(await disableDynamicCrons(extIdA, ["job:1", "job:ghost"], NOW)).toBe(0);
  });

  test("disableDynamicCrons with no keys is a no-op", async () => {
    await upsertDynamicCron(cron("job:1"));
    expect(await disableDynamicCrons(extIdA, [], NOW)).toBe(0);
    expect((await getDynamicCron(extIdA, "job:1"))!.enabled).toBe(true);
  });

  test("disableDynamicWebhooks disables only the named keys and counts them", async () => {
    for (const k of ["job:1", "job:2"]) {
      await upsertDynamicWebhook({
        extensionName: EXT_A, key: k,
        slug: mintWebhookSlug("factory-", EXT_A, k), now: NOW,
      });
    }
    expect(await disableDynamicWebhooks(EXT_A, ["job:1"], NOW)).toBe(1);
    expect((await getDynamicWebhook(EXT_A, "job:1"))!.enabled).toBe(false);
    expect((await getDynamicWebhook(EXT_A, "job:2"))!.enabled).toBe(true);
  });

  test("disableDynamicWebhooks skips already-disabled and unknown keys", async () => {
    await upsertDynamicWebhook({
      extensionName: EXT_A, key: "job:1",
      slug: mintWebhookSlug("factory-", EXT_A, "job:1"), now: NOW,
    });
    await disableDynamicWebhooks(EXT_A, ["job:1"], NOW);
    expect(await disableDynamicWebhooks(EXT_A, ["job:1", "job:ghost"], NOW)).toBe(0);
  });

  test("disableDynamicWebhooks with no keys is a no-op", async () => {
    expect(await disableDynamicWebhooks(EXT_A, [], NOW)).toBe(0);
  });
});

describe("todaysFireCountForSchedule", () => {
  async function seedFire(scheduleId: string, firedAt: Date) {
    await getTestDb().insert(extensionScheduleFires).values({
      scheduleId, scheduledAt: firedAt, firedAt, status: "ok",
    });
  }

  test("counts only THIS key's fires — the fairness bound", async () => {
    const a = await upsertDynamicCron(cron("job:a"));
    const b = await upsertDynamicCron(cron("job:b"));
    await seedFire(a.id, new Date("2026-07-29T01:00:00.000Z"));
    await seedFire(a.id, new Date("2026-07-29T02:00:00.000Z"));
    await seedFire(b.id, new Date("2026-07-29T03:00:00.000Z"));

    expect(await todaysFireCountForSchedule(a.id, NOW)).toBe(2);
    expect(await todaysFireCountForSchedule(b.id, NOW)).toBe(1);
  });

  test("excludes fires from a previous UTC day", async () => {
    const a = await upsertDynamicCron(cron("job:a"));
    await seedFire(a.id, new Date("2026-07-28T23:59:59.000Z"));
    await seedFire(a.id, new Date("2026-07-29T00:00:00.000Z"));
    expect(await todaysFireCountForSchedule(a.id, NOW)).toBe(1);
  });

  test("uses the INJECTED clock, not the wall clock", async () => {
    // Determinism seam: counting against a far-past `now` must see the
    // 2026-07-29 fires as future, i.e. not today.
    const a = await upsertDynamicCron(cron("job:a"));
    await seedFire(a.id, new Date("2026-07-29T01:00:00.000Z"));
    expect(await todaysFireCountForSchedule(a.id, new Date("2026-07-30T00:00:00.000Z"))).toBe(0);
    expect(await todaysFireCountForSchedule(a.id, NOW)).toBe(1);
  });

  test("is zero for a schedule with no fires", async () => {
    const a = await upsertDynamicCron(cron("job:a"));
    expect(await todaysFireCountForSchedule(a.id, NOW)).toBe(0);
  });
});
