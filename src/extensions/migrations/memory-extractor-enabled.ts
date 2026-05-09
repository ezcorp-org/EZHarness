/**
 * Phase 53.4 Stage 1 settings migration:
 * `global:memoryEnabled` → bundled `memory-extractor` extension's
 * per-extension `enabled` setting.
 *
 * Idempotent via the `global:memoryEnabled.migrated_at` sentinel
 * setting. Run once per bundled-install boot from
 * `ensureBundledExtensions` after the memory-extractor row exists.
 *
 * Migration table:
 *   global:memoryEnabled  → extensionSettings.values.enabled
 *     - undefined (never set) → defaults preserved (no DB write)
 *     - true                  → no DB write (matches schema default)
 *     - false                 → write enabled=false per user
 *   global:memoryEnabled.migrated_at = ISO timestamp once done.
 *
 * v1.4 — `global:compactionIntervalHours` ALSO migrates now. The
 * bundled `memory-extractor` extension exposes a per-extension
 * `compaction_interval_hours` setting (select with options 1, 3, 6, 12,
 * 24 hours). If the legacy global was set to one of these values, the
 * migration writes the per-user setting; non-supported legacy values
 * (e.g. 4 or 48) are clamped to the closest supported cadence with a
 * log line for traceability. The legacy host-side timer at
 * `src/startup/background-timers.ts:90` keeps reading the global key
 * for backward compat — the bundled extension and the legacy timer
 * are independent compaction drivers (the legacy one wraps
 * `runCompaction()` directly; the bundled extension does the same via
 * `runtime.memory.compact`). Marked deprecated in v1.4; removable
 * once the legacy timer is retired.
 *
 * The migration NEVER deletes the legacy setting — Stage 2 of the
 * deletion commit handles cleanup once the legacy listener is gone.
 * Today's behavior keeps both readers in sync: the legacy listener at
 * `web/src/lib/server/context.ts` continues to read the global setting
 * directly via `extractMemories`; the bundled extension reads its own
 * per-extension value via `runtime.settings.getMine`. Both should
 * agree post-migration.
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

const log = logger.child("memory-extractor-settings-migration");

const LEGACY_KEY = "global:memoryEnabled";
const SENTINEL_KEY = "global:memoryEnabled.migrated_at";
const LEGACY_INTERVAL_KEY = "global:compactionIntervalHours";

/** v1.4 — supported per-extension `compaction_interval_hours` values.
 *  Mirrors `extensions/memory-extractor/ezcorp.config.ts`'s setting
 *  options. Kept inline (not imported) so the migration doesn't pull
 *  the bundled extension's runtime entrypoint into a host-side
 *  module path. */
const SUPPORTED_HOURS = [1, 3, 6, 12, 24] as const;

/** Clamp a legacy `compaction_interval_hours` value to the closest
 *  supported cadence. Pure helper; exported for the migration test
 *  to pin the boundary cases. */
export function clampToSupportedCompactionHours(legacy: number): number {
  let best: number = SUPPORTED_HOURS[0];
  let bestDelta = Math.abs(legacy - best);
  for (const h of SUPPORTED_HOURS) {
    const delta = Math.abs(legacy - h);
    // Strict-less so the smaller cadence wins ties (more conservative
    // — over-eager compaction is preferred over silent drift toward
    // a longer interval the user didn't pick).
    if (delta < bestDelta) {
      best = h;
      bestDelta = delta;
    }
  }
  return best;
}

export async function migrateMemoryExtractorEnabledSetting(
  memoryExtractorExtensionId: string,
): Promise<void> {
  try {
    // Sentinel check — short-circuit fast path on every boot after the
    // first migration run.
    const sentinel = await getSetting(SENTINEL_KEY);
    if (sentinel != null) return;

    const legacy = await getSetting(LEGACY_KEY);

    // Migrate per-user. The `extension_settings_user` table is keyed on
    // (userId, extensionId); the legacy `global:memoryEnabled` is a
    // server-wide flag, so we apply the same value to every user. This
    // preserves the legacy semantics (one knob disables the pipeline
    // for everyone) while moving the storage into the per-extension
    // settings model that the SchemaForm UI expects.
    if (legacy === false) {
      const allUsers = await getDb().select({ id: users.id }).from(users);
      let migrated = 0;
      let perUserFailures = 0;
      for (const u of allUsers) {
        // Per-user try/catch: a single bad row must not poison the whole
        // migration. Track failures so we DON'T write the sentinel if
        // anything failed — next boot retries the surviving users without
        // re-clobbering the ones that succeeded. Mirrors the
        // distiller-enabled migration's bail-before-sentinel pattern.
        try {
          const existing = await getUserSettings(u.id, memoryExtractorExtensionId);
          if (existing.enabled === false) continue; // already migrated by hand
          await setUserSettings(u.id, memoryExtractorExtensionId, {
            ...existing,
            enabled: false,
          });
          migrated += 1;
        } catch (perUserErr) {
          perUserFailures += 1;
          log.warn("per-user memory-extractor migration failed; will retry on next boot", {
            userId: u.id,
            extensionId: memoryExtractorExtensionId,
            error: perUserErr instanceof Error ? perUserErr.message : String(perUserErr),
          });
        }
      }
      log.info("Migrated memoryEnabled=false to per-user extension settings", {
        userCount: allUsers.length,
        migratedCount: migrated,
        failureCount: perUserFailures,
        extensionId: memoryExtractorExtensionId,
      });
      // Bail before sentinel write so the next boot retries the failed
      // rows. The legacy listener is still wired during Stage 1 so the
      // bundled extension's default applies for any user we couldn't
      // reach this round.
      if (perUserFailures > 0) return;
    } else if (legacy === true) {
      // Explicit enabled=true preserves the manifest default; nothing
      // to write per-user since the schema's `default: true` already
      // covers it.
      log.info("Skipping migration write — legacy enabled=true matches manifest default", {
        extensionId: memoryExtractorExtensionId,
      });
    } else {
      log.info("Skipping migration write — legacy setting never set; defaults preserved", {
        extensionId: memoryExtractorExtensionId,
      });
    }

    // v1.4 — compaction-interval migration. The bundled extension
    // exposes `compaction_interval_hours` as a select with values
    // {1, 3, 6, 12, 24}. If the legacy global is set to one of those
    // (or 6 — the default), write it per-user; otherwise clamp to
    // the closest supported cadence so the user gets approximately
    // what they asked for. Sentinel-gated by the same
    // `global:memoryEnabled.migrated_at` row, so a manual flip of
    // the per-user value sticks across boots.
    const customInterval = await getSetting(LEGACY_INTERVAL_KEY);
    if (customInterval != null) {
      const numeric = Number(customInterval);
      if (Number.isFinite(numeric) && numeric > 0) {
        const supported = clampToSupportedCompactionHours(numeric);
        if (supported !== 6) {
          // Only write per-user when the value differs from the
          // schema default — `default: "6"` already covers the 6h
          // case for users who never had a per-user override.
          const allUsers = await getDb().select({ id: users.id }).from(users);
          let migrated = 0;
          let perUserFailures = 0;
          for (const u of allUsers) {
            try {
              const existing = await getUserSettings(u.id, memoryExtractorExtensionId);
              // Don't clobber an explicit per-user choice — the
              // SchemaForm UI may have already persisted one before
              // the migration runs (rare on the first boot, but
              // possible after a hand-edit / hand-restore).
              if (existing.compaction_interval_hours != null) continue;
              await setUserSettings(u.id, memoryExtractorExtensionId, {
                ...existing,
                compaction_interval_hours: String(supported),
              });
              migrated += 1;
            } catch (perUserErr) {
              perUserFailures += 1;
              log.warn("per-user compaction_interval_hours migration failed; will retry next boot", {
                userId: u.id,
                extensionId: memoryExtractorExtensionId,
                legacyValue: customInterval,
                resolvedTo: supported,
                error: perUserErr instanceof Error ? perUserErr.message : String(perUserErr),
              });
            }
          }
          log.info("Migrated compaction_interval_hours to per-user extension settings", {
            legacyValue: customInterval,
            resolvedTo: supported,
            userCount: allUsers.length,
            migratedCount: migrated,
            failureCount: perUserFailures,
            extensionId: memoryExtractorExtensionId,
          });
          // Bail before sentinel write so the next boot retries the
          // failures (mirrors the enabled-flag migration pattern).
          if (perUserFailures > 0) return;
        } else {
          log.info("Legacy compaction_interval_hours matches default (6h) — no per-user write", {
            legacyValue: customInterval,
            extensionId: memoryExtractorExtensionId,
          });
        }
      } else {
        log.warn("Legacy compaction_interval_hours not a finite positive number — skipping migration", {
          legacyValue: customInterval,
          extensionId: memoryExtractorExtensionId,
        });
      }
    }

    // Sentinel write — makes step 1 fast on subsequent boots.
    await upsertSetting(SENTINEL_KEY, new Date().toISOString());
  } catch (err) {
    // Non-fatal: legacy listener still works during Stage 1, so a
    // failed migration just means the bundled extension's default
    // (`enabled: true`) takes effect. Next boot retries.
    log.error("Memory-extractor settings migration failed", {
      extensionId: memoryExtractorExtensionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
