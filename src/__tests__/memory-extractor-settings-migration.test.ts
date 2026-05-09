/**
 * Phase 53.4 Stage 1 — memory-extractor settings migration test.
 *
 * Covers the three input shapes in
 * `src/extensions/migrations/memory-extractor-enabled.ts`:
 *
 *   1. Fresh install (no `global:memoryEnabled` set)
 *      → no per-user write, defaults preserved.
 *   2. Pre-existing `global:memoryEnabled = false`
 *      → migrates each user's `extension_settings_user.values.enabled`
 *        to `false`.
 *   3. Rerun with the sentinel already present
 *      → no-op (skip path).
 *
 * Plus the v1.3-deferred branch:
 *   4. Pre-existing `global:compactionIntervalHours != 6`
 *      → no-op on the cron, warning logged. (We only assert the
 *        migration completes without throwing — the log is not
 *        easily asserted from inside the test, but the code path is
 *        exercised.)
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { migrateMemoryExtractorEnabledSetting } = await import(
  "../extensions/migrations/memory-extractor-enabled"
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
  // Seed a "memory-extractor" extension row so per-user writes have a
  // foreign-key target. The manifest carries the settings schema the
  // setUserSettings helper clamps against.
  const ext = await createExtension({
    name: "memory-extractor",
    version: "1.0.0",
    source: "test",
    manifest: {
      schemaVersion: 2,
      name: "memory-extractor",
      version: "1.0.0",
      description: "test",
      author: { name: "t" },
      entrypoint: "x",
      tools: [],
      permissions: {},
      settings: {
        enabled: { type: "boolean", label: "Enabled", default: true },
        compaction_enabled: {
          type: "boolean",
          label: "Run periodic compaction sweep",
          default: true,
        },
        compaction_interval_hours: {
          type: "select",
          label: "Compaction interval (hours)",
          options: [
            { value: "1", label: "Every hour" },
            { value: "3", label: "Every 3 hours" },
            { value: "6", label: "Every 6 hours" },
            { value: "12", label: "Every 12 hours" },
            { value: "24", label: "Daily" },
          ],
          default: "6",
        },
      },
    } as never,
  });
  extensionId = ext.id;
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  // Fresh slate per test: clear sentinel, legacy settings, and per-user
  // values for the extension.
  await deleteSetting("global:memoryEnabled");
  await deleteSetting("global:memoryEnabled.migrated_at");
  await deleteSetting("global:compactionIntervalHours");
  for (const u of [userIdA, userIdB]) {
    await setUserSettings(u, extensionId, {});
  }
});

describe("migrateMemoryExtractorEnabledSetting — fresh install", () => {
  test("no legacy setting → no per-user write; sentinel still writes", async () => {
    await migrateMemoryExtractorEnabledSetting(extensionId);

    // Both users have empty per-extension settings (default branch).
    const a = await getUserSettings(userIdA, extensionId);
    const b = await getUserSettings(userIdB, extensionId);
    expect(a.enabled).toBeUndefined();
    expect(b.enabled).toBeUndefined();

    // Sentinel got stamped so the next run is a no-op.
    const sentinel = await getSetting("global:memoryEnabled.migrated_at");
    expect(typeof sentinel).toBe("string");
    expect(Number.isNaN(Date.parse(sentinel as string))).toBe(false);
  });
});

describe("migrateMemoryExtractorEnabledSetting — disable pre-existing", () => {
  test("legacy=false → every user gets enabled=false written", async () => {
    await upsertSetting("global:memoryEnabled", false);

    await migrateMemoryExtractorEnabledSetting(extensionId);

    const a = await getUserSettings(userIdA, extensionId);
    const b = await getUserSettings(userIdB, extensionId);
    expect(a.enabled).toBe(false);
    expect(b.enabled).toBe(false);

    // Sentinel stamped.
    const sentinel = await getSetting("global:memoryEnabled.migrated_at");
    expect(typeof sentinel).toBe("string");
  });

  test("legacy=true → no per-user write (schema default already true)", async () => {
    await upsertSetting("global:memoryEnabled", true);

    await migrateMemoryExtractorEnabledSetting(extensionId);

    const a = await getUserSettings(userIdA, extensionId);
    expect(a.enabled).toBeUndefined();

    // Sentinel still written so subsequent boots skip.
    const sentinel = await getSetting("global:memoryEnabled.migrated_at");
    expect(typeof sentinel).toBe("string");
  });
});

describe("migrateMemoryExtractorEnabledSetting — idempotency", () => {
  test("rerun with sentinel present is a no-op", async () => {
    await upsertSetting("global:memoryEnabled", false);
    await migrateMemoryExtractorEnabledSetting(extensionId);

    const a1 = await getUserSettings(userIdA, extensionId);
    expect(a1.enabled).toBe(false);

    // Manually flip user A back to enabled=true. A second migration run
    // MUST NOT clobber that value (sentinel skip).
    await setUserSettings(userIdA, extensionId, { enabled: true });
    await migrateMemoryExtractorEnabledSetting(extensionId);

    const a2 = await getUserSettings(userIdA, extensionId);
    expect(a2.enabled).toBe(true);
  });
});

describe("migrateMemoryExtractorEnabledSetting — v1.4 compaction_interval_hours migration", () => {
  test("legacy=12 (supported) → writes per-user compaction_interval_hours='12'", async () => {
    // v1.4 inversion of the v1.3 deferred-warning: 12 is in the
    // supported set {1, 3, 6, 12, 24} so the migration writes it
    // verbatim per-user.
    await upsertSetting("global:compactionIntervalHours", 12);

    await migrateMemoryExtractorEnabledSetting(extensionId);

    const a = await getUserSettings(userIdA, extensionId);
    const b = await getUserSettings(userIdB, extensionId);
    expect(a.compaction_interval_hours).toBe("12");
    expect(b.compaction_interval_hours).toBe("12");

    const sentinel = await getSetting("global:memoryEnabled.migrated_at");
    expect(typeof sentinel).toBe("string");
  });

  test("legacy=6 (matches default) → no per-user write (schema default covers it)", async () => {
    await upsertSetting("global:compactionIntervalHours", 6);
    await upsertSetting("global:memoryEnabled", true);

    await migrateMemoryExtractorEnabledSetting(extensionId);

    const a = await getUserSettings(userIdA, extensionId);
    expect(a.compaction_interval_hours).toBeUndefined();

    const sentinel = await getSetting("global:memoryEnabled.migrated_at");
    expect(typeof sentinel).toBe("string");
  });

  test("legacy=4 (unsupported) → clamps to nearest supported value (3)", async () => {
    // 4 is between 3 and 6; the clamp picks the nearest cadence,
    // and on ties the smaller (more conservative) wins.
    await upsertSetting("global:compactionIntervalHours", 4);

    await migrateMemoryExtractorEnabledSetting(extensionId);

    const a = await getUserSettings(userIdA, extensionId);
    expect(a.compaction_interval_hours).toBe("3");
  });

  test("legacy=48 (unsupported) → clamps to nearest supported value (24)", async () => {
    // 48 is well above the supported max (24); clamp to the closest.
    await upsertSetting("global:compactionIntervalHours", 48);

    await migrateMemoryExtractorEnabledSetting(extensionId);

    const a = await getUserSettings(userIdA, extensionId);
    expect(a.compaction_interval_hours).toBe("24");
  });

  test("legacy=0 / negative / non-numeric → no per-user write, no throw", async () => {
    // The migration must not crash on garbage; it logs and skips the
    // write so downstream boots stay healthy.
    await upsertSetting("global:compactionIntervalHours", "garbage" as never);

    await migrateMemoryExtractorEnabledSetting(extensionId);

    const a = await getUserSettings(userIdA, extensionId);
    expect(a.compaction_interval_hours).toBeUndefined();

    const sentinel = await getSetting("global:memoryEnabled.migrated_at");
    expect(typeof sentinel).toBe("string");
  });

  test("idempotency — rerun with sentinel does NOT clobber a hand-edited per-user value", async () => {
    await upsertSetting("global:compactionIntervalHours", 12);
    await migrateMemoryExtractorEnabledSetting(extensionId);

    // Hand-edit user A back to 24 (operator changed their mind).
    await setUserSettings(userIdA, extensionId, { compaction_interval_hours: "24" });

    // Second migration run is a sentinel-skip — must not re-clobber.
    await migrateMemoryExtractorEnabledSetting(extensionId);

    const a = await getUserSettings(userIdA, extensionId);
    expect(a.compaction_interval_hours).toBe("24");
  });

  test("does not clobber a pre-existing per-user compaction_interval_hours during first run", async () => {
    // User had already set their own value (via SchemaForm) before the
    // migration runs. The migration must respect that — write only
    // when the slot is empty.
    await upsertSetting("global:compactionIntervalHours", 12);
    await setUserSettings(userIdA, extensionId, { compaction_interval_hours: "24" });

    await migrateMemoryExtractorEnabledSetting(extensionId);

    const a = await getUserSettings(userIdA, extensionId);
    const b = await getUserSettings(userIdB, extensionId);
    expect(a.compaction_interval_hours).toBe("24"); // preserved
    expect(b.compaction_interval_hours).toBe("12"); // migrated
  });
});

describe("clampToSupportedCompactionHours — pure helper", () => {
  test("supported values pass through unchanged", async () => {
    const { clampToSupportedCompactionHours } = await import(
      "../extensions/migrations/memory-extractor-enabled"
    );
    expect(clampToSupportedCompactionHours(1)).toBe(1);
    expect(clampToSupportedCompactionHours(3)).toBe(3);
    expect(clampToSupportedCompactionHours(6)).toBe(6);
    expect(clampToSupportedCompactionHours(12)).toBe(12);
    expect(clampToSupportedCompactionHours(24)).toBe(24);
  });

  test("unsupported values clamp to nearest, ties prefer smaller cadence", async () => {
    const { clampToSupportedCompactionHours } = await import(
      "../extensions/migrations/memory-extractor-enabled"
    );
    // Tie at 2 (between 1 and 3): smaller cadence (1) wins on equidistant.
    expect(clampToSupportedCompactionHours(2)).toBe(1);
    // 4 → 3 (closer than 6).
    expect(clampToSupportedCompactionHours(4)).toBe(3);
    // 9 → 6 (equidistant from 6 and 12, smaller wins).
    expect(clampToSupportedCompactionHours(9)).toBe(6);
    // 10 → 12 (closer to 12 than 6 — strictly nearer).
    expect(clampToSupportedCompactionHours(10)).toBe(12);
    // 18 → 12 (equidistant from 12 and 24, smaller wins).
    expect(clampToSupportedCompactionHours(18)).toBe(12);
    // 19 → 24 (closer to 24 than 12).
    expect(clampToSupportedCompactionHours(19)).toBe(24);
    // 48 → 24 (max).
    expect(clampToSupportedCompactionHours(48)).toBe(24);
  });
});
