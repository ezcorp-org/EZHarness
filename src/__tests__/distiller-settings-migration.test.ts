/**
 * Phase 53 Stage 1 — settings migration test.
 *
 * Covers the three input shapes in
 * `src/extensions/migrations/distiller-enabled.ts`:
 *
 *   1. Fresh install (no `global:lessonDistillerEnabled` set)
 *      → no per-user write, defaults preserved.
 *   2. Pre-existing `global:lessonDistillerEnabled = false`
 *      → migrates each user's `extension_settings_user.values.enabled`
 *        to `false`.
 *   3. Rerun with the sentinel already present
 *      → no-op (skip path).
 *
 * Also validates the sentinel write timestamp is parseable.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { migrateDistillerEnabledSetting } = await import(
  "../extensions/migrations/distiller-enabled"
);
const { createUser } = await import("../db/queries/users");
const { upsertSetting, deleteSetting, getSetting } = await import(
  "../db/queries/settings"
);
const {
  getUserSettings,
  setUserSettings,
} = await import("../db/queries/extension-settings");
const { createExtension } = await import("../db/queries/extensions");

let extensionId: string;
let userIdA: string;
let userIdB: string;

beforeAll(async () => {
  await setupTestDb();
  const a = await createUser({ email: "a@test.com", passwordHash: "h", name: "A" });
  const b = await createUser({ email: "b@test.com", passwordHash: "h", name: "B" });
  userIdA = a.id;
  userIdB = b.id;
  // Seed a "lessons-distiller" extension row so per-user writes have a
  // foreign-key target. The manifest carries the settings schema the
  // setUserSettings helper clamps against.
  const ext = await createExtension({
    name: "lessons-distiller",
    version: "1.0.0",
    source: "test",
    manifest: {
      schemaVersion: 2,
      name: "lessons-distiller",
      version: "1.0.0",
      description: "test",
      author: { name: "t" },
      entrypoint: "x",
      tools: [],
      permissions: {},
      settings: {
        enabled: { type: "boolean", label: "Enabled", default: true },
      },
    } as never,
  });
  extensionId = ext.id;
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  // Fresh slate per test: clear sentinel, legacy setting, and per-user
  // values for the extension. setUserSettings clamps against the schema
  // which would drop our test keys, so use the underlying helper to
  // reset by writing an empty value blob.
  await deleteSetting("global:lessonDistillerEnabled");
  await deleteSetting("global:lessonDistillerEnabled.migrated_at");
  for (const u of [userIdA, userIdB]) {
    await setUserSettings(u, extensionId, {});
  }
});

describe("migrateDistillerEnabledSetting — fresh install", () => {
  test("no legacy setting → no per-user write; sentinel still writes", async () => {
    await migrateDistillerEnabledSetting(extensionId);

    // Both users have empty per-extension settings (default branch).
    const a = await getUserSettings(userIdA, extensionId);
    const b = await getUserSettings(userIdB, extensionId);
    expect(a.enabled).toBeUndefined();
    expect(b.enabled).toBeUndefined();

    // Sentinel got stamped so the next run is a no-op.
    const sentinel = await getSetting("global:lessonDistillerEnabled.migrated_at");
    expect(typeof sentinel).toBe("string");
    expect(Number.isNaN(Date.parse(sentinel as string))).toBe(false);
  });
});

describe("migrateDistillerEnabledSetting — disable pre-existing", () => {
  test("legacy=false → every user gets enabled=false written", async () => {
    await upsertSetting("global:lessonDistillerEnabled", false);

    await migrateDistillerEnabledSetting(extensionId);

    const a = await getUserSettings(userIdA, extensionId);
    const b = await getUserSettings(userIdB, extensionId);
    expect(a.enabled).toBe(false);
    expect(b.enabled).toBe(false);

    // Sentinel stamped.
    const sentinel = await getSetting("global:lessonDistillerEnabled.migrated_at");
    expect(typeof sentinel).toBe("string");
  });

  test("legacy=true → no per-user write (schema default already true)", async () => {
    await upsertSetting("global:lessonDistillerEnabled", true);

    await migrateDistillerEnabledSetting(extensionId);

    const a = await getUserSettings(userIdA, extensionId);
    expect(a.enabled).toBeUndefined();

    // Sentinel still written so subsequent boots skip.
    const sentinel = await getSetting("global:lessonDistillerEnabled.migrated_at");
    expect(typeof sentinel).toBe("string");
  });
});

describe("migrateDistillerEnabledSetting — idempotency", () => {
  test("rerun with sentinel present is a no-op", async () => {
    await upsertSetting("global:lessonDistillerEnabled", false);
    await migrateDistillerEnabledSetting(extensionId);

    const a1 = await getUserSettings(userIdA, extensionId);
    expect(a1.enabled).toBe(false);

    // Manually flip user A back to enabled=true. A second migration run
    // MUST NOT clobber that value (sentinel skip).
    await setUserSettings(userIdA, extensionId, { enabled: true });
    await migrateDistillerEnabledSetting(extensionId);

    const a2 = await getUserSettings(userIdA, extensionId);
    expect(a2.enabled).toBe(true);
  });
});
