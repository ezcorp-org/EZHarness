/**
 * Phase 53 Stage 1 settings migration: `global:lessonDistillerEnabled`
 * → bundled `lessons-distiller` extension's per-extension `enabled`
 * setting.
 *
 * Idempotent via the `global:lessonDistillerEnabled.migrated_at`
 * sentinel setting. Run once per bundled-install boot from
 * `ensureBundledExtensions` after the lessons-distiller row exists.
 *
 * Migration table:
 *   global:lessonDistillerEnabled  → extensionSettings.values.enabled
 *     - undefined (never set) → defaults preserved (no DB write)
 *     - true                  → write enabled=true (preserves intent)
 *     - false                 → write enabled=false (preserves intent)
 *   global:lessonDistillerEnabled.migrated_at = ISO timestamp once done.
 *
 * The migration NEVER deletes the legacy setting — Stage 2 of the
 * deletion commit handles cleanup once the legacy listener is gone.
 * Today's behavior keeps both readers in sync: the legacy listener at
 * `web/src/lib/server/context.ts` continues to read the global setting
 * directly; the bundled extension reads its own per-extension value via
 * `runtime.settings.getMine`. Both should agree post-migration.
 *
 * Failure mode: errors are caught and logged. The legacy listener is
 * still wired during Stage 1, so a migration failure means the bundled
 * extension uses its declared default (`enabled: true`) until the next
 * boot retries — no user-visible regression.
 */

import { getDb } from "../../db/connection";
import { getSetting, upsertSetting } from "../../db/queries/settings";
import {
  setUserSettings,
  getUserSettings,
} from "../../db/queries/extension-settings";
import { users } from "../../db/schema";
import { logger } from "../../logger";

const log = logger.child("distiller-settings-migration");

const LEGACY_KEY = "global:lessonDistillerEnabled";
const SENTINEL_KEY = "global:lessonDistillerEnabled.migrated_at";

export async function migrateDistillerEnabledSetting(
  lessonsDistillerExtensionId: string,
): Promise<void> {
  try {
    // Sentinel check — short-circuit fast path on every boot after the
    // first migration run.
    const sentinel = await getSetting(SENTINEL_KEY);
    if (sentinel != null) return;

    const legacy = await getSetting(LEGACY_KEY);

    // Migrate per-user. The `extension_settings_user` table is keyed on
    // (userId, extensionId); the legacy `global:lessonDistillerEnabled`
    // is a server-wide flag, so we apply the same value to every user.
    // This preserves the legacy semantics (one knob disables the
    // pipeline for everyone) while moving the storage into the
    // per-extension settings model that the SchemaForm UI expects.
    if (legacy === false) {
      const allUsers = await getDb().select({ id: users.id }).from(users);
      let migrated = 0;
      for (const u of allUsers) {
        // Merge with any existing per-user values so we don't clobber
        // future migrations that touch other keys on the same row.
        const existing = await getUserSettings(u.id, lessonsDistillerExtensionId);
        if (existing.enabled === false) continue; // already migrated by hand
        await setUserSettings(u.id, lessonsDistillerExtensionId, {
          ...existing,
          enabled: false,
        });
        migrated += 1;
      }
      log.info("Migrated lessonDistillerEnabled=false to per-user extension settings", {
        userCount: allUsers.length,
        migratedCount: migrated,
        extensionId: lessonsDistillerExtensionId,
      });
    } else if (legacy === true) {
      // Explicit enabled=true preserves the manifest default; nothing
      // to write per-user since the schema's `default: true` already
      // covers it.
      log.info("Skipping migration write — legacy enabled=true matches manifest default", {
        extensionId: lessonsDistillerExtensionId,
      });
    } else {
      log.info("Skipping migration write — legacy setting never set; defaults preserved", {
        extensionId: lessonsDistillerExtensionId,
      });
    }

    // Sentinel write — makes step 1 fast on subsequent boots.
    await upsertSetting(SENTINEL_KEY, new Date().toISOString());
  } catch (err) {
    // Non-fatal: legacy listener still works during Stage 1, so a
    // failed migration just means the bundled extension's default
    // (`enabled: true`) takes effect. Next boot retries.
    log.error("Distiller settings migration failed", {
      extensionId: lessonsDistillerExtensionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
