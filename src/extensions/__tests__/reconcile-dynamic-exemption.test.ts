/**
 * C2 build-order step 2 — Hazard A, the reconcilers' `dynamic = false`
 * exemption.
 *
 * Both reconcilers treat "not in the manifest / grant" as "the author
 * deleted it" and soft-disable the row. That is exactly right for every row
 * that exists today, because every row that exists today is
 * manifest-declared. A DYNAMIC row is by construction absent from the
 * manifest and therefore from the clamped grant, so without an exemption it
 * reads as deleted on every pass.
 *
 * The failure is invisible, which is why it gets its own file: the row
 * survives, the secret survives, the delivery history survives, and the
 * trigger simply stops firing. Nothing errors and nothing is logged as
 * wrong.
 *
 * The empty-grant case is the one that matters most in production:
 * `activateExtension` calls `reconcileWebhooks` on EVERY enable with a
 * `?? []` fallback, so the disable-all branch is the common path for an
 * extension whose hooks are all dynamic — not a corner case.
 *
 * Each test asserts BOTH halves of the fix: the row stays enabled, AND the
 * reported `disabled` count excludes it. The count derives from a separate
 * pre-fetch snapshot, so it can lie even once the disable is correct.
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

import { reconcileSchedules } from "../schedule-reconcile";
import { reconcileWebhooks } from "../webhook-reconcile";
import { extensionSchedules, extensionWebhooks, extensions } from "../../db/schema";
import { eq, and } from "drizzle-orm";

let extId: string;
const EXT_NAME = "reconcile-dyn-ext";

/** A no-op secret minter — `reconcileWebhooks` takes this injected so the
 *  test never touches the AEAD secret store. */
const noSecret = async (): Promise<string | null> => null;

beforeAll(async () => {
  await setupTestDb();
  const [row] = await getTestDb().insert(extensions).values({
    name: EXT_NAME, version: "0.0.1", description: "",
    manifest: {
      schemaVersion: 2, name: EXT_NAME, version: "0.0.1", description: "",
      author: { name: "t" }, permissions: {},
    } as never,
    source: "test", enabled: true, grantedPermissions: {} as never,
  }).returning({ id: extensions.id });
  extId = row!.id;
});

beforeEach(async () => {
  await getTestDb().delete(extensionSchedules);
  await getTestDb().delete(extensionWebhooks);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

/** Insert one dynamic cron row, as `ctx.triggers.register` would. */
async function seedDynamicSchedule(key: string, cron = "0 9 * * 1"): Promise<string> {
  const [row] = await getTestDb().insert(extensionSchedules).values({
    extensionId: extId, cron, nextFireAt: new Date(),
    enabled: true, dynamic: true, key,
  }).returning({ id: extensionSchedules.id });
  return row!.id;
}

/** Insert one dynamic webhook row, as `ctx.triggers.register` would. */
async function seedDynamicWebhook(key: string, slug: string): Promise<string> {
  const [row] = await getTestDb().insert(extensionWebhooks).values({
    extensionId: EXT_NAME, slug, enabled: true, dynamic: true, key,
  }).returning({ id: extensionWebhooks.id });
  return row!.id;
}

describe("reconcileSchedules leaves dynamic rows alone", () => {
  test("EMPTY manifest + a dynamic row ⇒ row stays enabled, count excludes it", async () => {
    const dynId = await seedDynamicSchedule("job:survives");
    // A manifest cron that WILL legitimately be disabled, so the test also
    // proves the sweep still works rather than that it stopped running.
    await reconcileSchedules(extId, ["0 3 * * *"]);

    const result = await reconcileSchedules(extId, []);

    const dyn = await getTestDb().select().from(extensionSchedules)
      .where(eq(extensionSchedules.id, dynId));
    expect(dyn[0]!.enabled).toBe(true);
    // The manifest row was disabled; the dynamic one was not counted.
    expect(result.disabled).toBe(1);

    const manifestRows = await getTestDb().select().from(extensionSchedules)
      .where(and(
        eq(extensionSchedules.extensionId, extId),
        eq(extensionSchedules.dynamic, false),
      ));
    expect(manifestRows.every((r) => !r.enabled)).toBe(true);
  });

  test("a dynamic row is the ONLY row ⇒ disable-all branch reports zero", async () => {
    // Exercises the `existing.length > 0` disable-all branch specifically:
    // with the filter in place there are no manifest rows at all, so the
    // branch must not run and must not claim a disable.
    const dynId = await seedDynamicSchedule("job:only");

    const result = await reconcileSchedules(extId, []);

    const dyn = await getTestDb().select().from(extensionSchedules)
      .where(eq(extensionSchedules.id, dynId));
    expect(dyn[0]!.enabled).toBe(true);
    expect(result.disabled).toBe(0);
  });

  test("a NARROWED manifest does not touch a dynamic row sharing its cron", async () => {
    // The sweep is `cron NOT IN (valid)`. A dynamic row whose cron is also
    // absent from the narrowed manifest is the exact row the sweep would
    // have caught.
    await reconcileSchedules(extId, ["0 3 * * *", "0 4 * * *"]);
    const dynId = await seedDynamicSchedule("job:shares", "0 4 * * *");

    const result = await reconcileSchedules(extId, ["0 3 * * *"]);

    const dyn = await getTestDb().select().from(extensionSchedules)
      .where(eq(extensionSchedules.id, dynId));
    expect(dyn[0]!.enabled).toBe(true);
    expect(dyn[0]!.key).toBe("job:shares");
    expect(result.disabled).toBe(1); // only the manifest "0 4 * * *"
  });

  test("dynamic rows do not inflate `preserved` either", async () => {
    await seedDynamicSchedule("job:noise", "0 3 * * *");
    const result = await reconcileSchedules(extId, ["0 3 * * *"]);
    // The manifest cron is ADDED (the dynamic row sharing that expression
    // is not a manifest row and must not be mistaken for one).
    expect(result.added).toBe(1);
    expect(result.preserved).toBe(0);
  });
});

describe("reconcileWebhooks leaves dynamic rows alone", () => {
  test("EMPTY grant + a dynamic row ⇒ row stays enabled, count excludes it", async () => {
    const dynId = await seedDynamicWebhook("job:survives", "factory-aaaaaaaaaaaa");
    await reconcileWebhooks(EXT_NAME, ["tickets"], () => new Date(), noSecret);

    const result = await reconcileWebhooks(EXT_NAME, [], () => new Date(), noSecret);

    const dyn = await getTestDb().select().from(extensionWebhooks)
      .where(eq(extensionWebhooks.id, dynId));
    expect(dyn[0]!.enabled).toBe(true);
    expect(result.disabled).toBe(1); // the manifest "tickets" only
  });

  test("a dynamic row is the ONLY row ⇒ disable-all branch reports zero", async () => {
    // This is the production path: activateExtension calls reconcileWebhooks
    // with `?? []` on every enable, so an all-dynamic extension hits the
    // disable-all branch every single time it is enabled.
    const dynId = await seedDynamicWebhook("job:only", "factory-bbbbbbbbbbbb");

    const result = await reconcileWebhooks(EXT_NAME, [], () => new Date(), noSecret);

    const dyn = await getTestDb().select().from(extensionWebhooks)
      .where(eq(extensionWebhooks.id, dynId));
    expect(dyn[0]!.enabled).toBe(true);
    expect(result.disabled).toBe(0);
  });

  test("a NARROWED grant does not touch dynamic rows", async () => {
    await reconcileWebhooks(EXT_NAME, ["tickets", "alerts"], () => new Date(), noSecret);
    const dynId = await seedDynamicWebhook("job:keep", "factory-cccccccccccc");

    const result = await reconcileWebhooks(EXT_NAME, ["tickets"], () => new Date(), noSecret);

    const dyn = await getTestDb().select().from(extensionWebhooks)
      .where(eq(extensionWebhooks.id, dynId));
    expect(dyn[0]!.enabled).toBe(true);
    expect(result.disabled).toBe(1); // only "alerts"
    expect(result.preserved).toBe(1); // only "tickets"
  });

  test("a re-enable pass does not resurrect a deliberately-disabled dynamic row", async () => {
    // Unregister soft-disables a dynamic row. Reconciliation must not undo
    // that — the re-enable loop keys on the GRANT, which a dynamic slug is
    // never in, but assert it so a future refactor cannot regress it.
    const dynId = await seedDynamicWebhook("job:off", "factory-dddddddddddd");
    await getTestDb().update(extensionWebhooks)
      .set({ enabled: false })
      .where(eq(extensionWebhooks.id, dynId));

    await reconcileWebhooks(EXT_NAME, ["tickets"], () => new Date(), noSecret);

    const dyn = await getTestDb().select().from(extensionWebhooks)
      .where(eq(extensionWebhooks.id, dynId));
    expect(dyn[0]!.enabled).toBe(false);
  });
});
