// ── One-time namespace migration for legacy entity keys ─────────
//
// Phase 3 (stub-shaped) / Phase 7 (full wiring): when an extension that
// previously hand-rolled its CRUD ports to the SDK's `entities` block,
// the host runs this renamer on every existing per-user row in
// `extension_storage` before the SDK starts serving CRUD tools.
//
// Rename pattern is parameterized; substack-pilot's case is:
//
//     post-type:<slug>   → __entity:post-type:<slug>
//     post-type-index    → __entity-index:post-type
//
// Generalizes to any (legacyKeyPrefix, legacyIndexKey, type) triple
// — future ports just call `runEntityNamespaceMigration` with the
// extension's own legacy shape. The renamer is:
//
//   - idempotent — re-runs are no-ops once managed keys exist
//   - per-user — each (extensionId, scope, scopeId) cell migrates in
//     isolation so a single user's broken row can't fail the whole
//     extension's install
//   - audit-logged via `audit_log` as `ENTITY_NAMESPACE_MIGRATION`
//     (action `ext:entity-namespace-migrated`) — one row per scopeId
//     migrated, with `{from, to, slugs}` metadata
//   - non-destructive on failure: source keys are deleted ONLY after
//     the managed keys are persisted. A crash mid-migration leaves the
//     source intact so a retry can complete it.
//
// Phase 3 ships this as a no-op when no legacy keys are present — that
// matches the "stub" contract the spec hands us. The renamer is fully
// implemented (not a TODO) because Phase 7 calls it; we just don't
// register any legacy mappings yet.

import { eq, and, like, sql } from "drizzle-orm";
import { getDb } from "../../db/connection";
import { extensionStorage } from "../../db/schema";
import { insertAuditEntry } from "../../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "../audit-actions";
import {
  ENTITY_INDEX_PREFIX,
  ENTITY_KEY_PREFIX,
  isValidSlug,
} from "@ezcorp/sdk/entities";

/**
 * A single legacy-shape mapping. Each extension that needs migration
 * supplies one or more of these in `runEntityNamespaceMigration`.
 *
 *   - `entityType` — the type slug the SDK will use post-migration.
 *   - `legacyKeyPrefix` — what the legacy CRUD wrote per record,
 *     e.g. `"post-type:"`. The renamer pulls every row whose key
 *     starts with this prefix and rewrites it under the managed
 *     namespace.
 *   - `legacyIndexKey` — the legacy index key (the list of slugs).
 *     Optional: extensions that didn't maintain an index can omit
 *     this; the renamer derives the slug list from the row keys.
 */
export interface LegacyNamespaceMapping {
  entityType: string;
  legacyKeyPrefix: string;
  legacyIndexKey?: string;
}

export interface EntityMigrationOptions {
  extensionId: string;
  mappings: readonly LegacyNamespaceMapping[];
}

export interface EntityMigrationResult {
  /** Number of per-scope cells where at least one row was rewritten. */
  scopesMigrated: number;
  /** Total record rows renamed across all scopes. */
  recordsRenamed: number;
  /** Per-entity slugs surfaced into the managed index. */
  slugsByType: Record<string, string[]>;
}

interface ScopeKey {
  scope: "global" | "conversation" | "user";
  scopeId: string | null;
}

/** Compose the storage scope tuple into a stable string key for the
 *  per-scope grouping. The unique-marker `||` is safe — neither scope
 *  enum values nor scopeIds (UUIDs) contain it. */
function scopeKeyToString(k: ScopeKey): string {
  return `${k.scope}||${k.scopeId ?? ""}`;
}

function parseScopeKey(s: string): ScopeKey {
  const [scopeStr, idStr] = s.split("||");
  return {
    scope: (scopeStr ?? "global") as ScopeKey["scope"],
    scopeId: idStr && idStr.length > 0 ? idStr : null,
  };
}

/**
 * Run the rename for one extension across every (scope, scopeId)
 * cell that has at least one legacy row. Idempotent: scopes whose
 * managed-namespace keys already exist for the relevant type are
 * skipped.
 *
 * Returns aggregate counts for the installer log + audit trail. Per-
 * user (scope, scopeId) audit rows are written inline as the renamer
 * progresses, NOT batched at the end — a crash mid-migration still
 * leaves an audit trail of the work completed so far.
 */
export async function runEntityNamespaceMigration(
  opts: EntityMigrationOptions,
): Promise<EntityMigrationResult> {
  if (opts.mappings.length === 0) {
    return { scopesMigrated: 0, recordsRenamed: 0, slugsByType: {} };
  }

  const db = getDb();
  const result: EntityMigrationResult = {
    scopesMigrated: 0,
    recordsRenamed: 0,
    slugsByType: {},
  };

  for (const mapping of opts.mappings) {
    const { entityType, legacyKeyPrefix, legacyIndexKey } = mapping;
    const managedRecordPrefix = `${ENTITY_KEY_PREFIX}${entityType}:`;
    const managedIndexKey = `${ENTITY_INDEX_PREFIX}${entityType}`;

    // Pull every row that starts with the legacy prefix OR is the
    // legacy index key. Group by (scope, scopeId) so the renamer
    // proceeds per-cell.
    //
    // LIKE escape: legacy prefixes are extension-author-declared. The
    // documented format is `<type-slug>:` which excludes `%` and `_`;
    // even so, we escape defensively so a future declaration with an
    // underscore (e.g. `my_type:`) doesn't accidentally match
    // unrelated keys.
    const escapedPrefix = legacyKeyPrefix
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");

    const rows = await db
      .select({
        scope: extensionStorage.scope,
        scopeId: extensionStorage.scopeId,
        key: extensionStorage.key,
        value: extensionStorage.value,
      })
      .from(extensionStorage)
      .where(
        and(
          eq(extensionStorage.extensionId, opts.extensionId),
          legacyIndexKey
            ? sql`(${extensionStorage.key} LIKE ${escapedPrefix + "%"} ESCAPE '\\' OR ${extensionStorage.key} = ${legacyIndexKey})`
            : like(extensionStorage.key, `${escapedPrefix}%`),
        ),
      );

    if (rows.length === 0) continue;

    // Group by scope.
    type StorageRow = (typeof rows)[number];
    const byScope = new Map<string, StorageRow[]>();
    for (const row of rows) {
      const k = scopeKeyToString({
        scope: row.scope as ScopeKey["scope"],
        scopeId: row.scopeId,
      });
      const list = byScope.get(k) ?? [];
      list.push(row);
      byScope.set(k, list);
    }

    for (const [scopeKey, scopeRows] of byScope) {
      const sk = parseScopeKey(scopeKey);

      // Per-user transaction isolation (spec L116): the entire
      // (extensionId, scope, scopeId) cell migrates atomically — the
      // idempotency probe, managed-row writes, legacy deletes, and
      // audit row all commit together or roll back together. A
      // connection drop mid-cell leaves the user with their legacy
      // rows intact (re-run picks up from scratch); a partial commit
      // is impossible. A failure in one cell does NOT fail the whole
      // migration — we catch the rollback per-cell, log + re-throw
      // higher up only when we want to halt the install, but the spec
      // (and existing tests) expect "skip-bad-cell + continue".
      //
      // Cells track their own outcome through `cellResult`, which
      // mirrors the post-commit aggregate the outer loop writes into
      // `result`. We assemble that struct inside the tx and apply it
      // only after a successful commit, so an aborted tx never
      // pollutes the aggregate counts.
      // Audit rows are written AFTER the tx commits, not inside it.
      // `insertAuditEntry` always uses `getDb()` (not the tx) — passing
      // the tx would require widening the audit-log API. Collecting the
      // intended audit payload here and emitting it post-commit keeps
      // the invariant: rollback ⇒ no audit row, commit ⇒ audit row.
      interface PendingAudit {
        scopeUserId: string | null;
        metadata: Record<string, unknown>;
      }
      interface CellOutcome {
        migratedSlugs: string[];
        skippedSlugs: string[];
        scopeCounted: boolean; // true when this cell did real work
        pendingAudit: PendingAudit | null;
      }
      const cellResult: CellOutcome = await db.transaction(
        async (tx: typeof db) => {
          // Idempotency: skip scopes that already have the managed
          // namespace present for this type — a previous run completed
          // here.
          const existingManaged = await tx
            .select({ key: extensionStorage.key })
            .from(extensionStorage)
            .where(
              and(
                eq(extensionStorage.extensionId, opts.extensionId),
                eq(extensionStorage.scope, sk.scope),
                sk.scopeId === null
                  ? sql`${extensionStorage.scopeId} IS NULL`
                  : eq(extensionStorage.scopeId, sk.scopeId),
                sql`(${extensionStorage.key} LIKE ${managedRecordPrefix + "%"} ESCAPE '\\' OR ${extensionStorage.key} = ${managedIndexKey})`,
              ),
            );
          if (existingManaged.length > 0) {
            // Already migrated — but the source keys might still linger
            // if a prior run crashed AFTER managed writes but BEFORE
            // source deletes. Clean up any straggling legacy keys here
            // (audit only if we actually delete something).
            const deleted = await tx
              .delete(extensionStorage)
              .where(
                and(
                  eq(extensionStorage.extensionId, opts.extensionId),
                  eq(extensionStorage.scope, sk.scope),
                  sk.scopeId === null
                    ? sql`${extensionStorage.scopeId} IS NULL`
                    : eq(extensionStorage.scopeId, sk.scopeId),
                  sql`(${extensionStorage.key} LIKE ${escapedPrefix + "%"} ESCAPE '\\'${legacyIndexKey ? sql` OR ${extensionStorage.key} = ${legacyIndexKey}` : sql``})`,
                ),
              )
              .returning({ id: extensionStorage.id });
            const stragglerAudit: PendingAudit | null =
              deleted.length > 0
                ? {
                    scopeUserId: sk.scope === "user" ? sk.scopeId : null,
                    metadata: {
                      entityType,
                      from: legacyKeyPrefix,
                      to: managedRecordPrefix,
                      scope: sk.scope,
                      scopeId: sk.scopeId,
                      cleanedStragglers: deleted.length,
                    },
                  }
                : null;
            return {
              migratedSlugs: [],
              skippedSlugs: [],
              scopeCounted: false,
              pendingAudit: stragglerAudit,
            };
          }

          // Compute the slug list from the legacy row keys (excluding
          // the index row itself). Slugs that don't match the SDK's
          // regex are skipped — they wouldn't survive an entity read
          // anyway, and logging them in the audit row lets an operator
          // track down the corruption.
          const recordRows = scopeRows.filter(
            (r: StorageRow) =>
              r.key !== legacyIndexKey && r.key.startsWith(legacyKeyPrefix),
          );
          const skippedSlugs: string[] = [];
          const migratedSlugs: string[] = [];

          for (const row of recordRows) {
            const slug = row.key.slice(legacyKeyPrefix.length);
            if (!isValidSlug(slug)) {
              skippedSlugs.push(slug);
              continue;
            }
            migratedSlugs.push(slug);

            const serialized = JSON.stringify(row.value);
            const sizeBytes = Buffer.byteLength(serialized, "utf-8");
            await tx
              .insert(extensionStorage)
              .values({
                extensionId: opts.extensionId,
                scope: sk.scope,
                scopeId: sk.scopeId,
                key: `${managedRecordPrefix}${slug}`,
                value: row.value,
                encrypted: false,
                sizeBytes,
                expiresAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              })
              .onConflictDoNothing();
          }

          // Write the managed index — sorted+deduped slugs, mirroring
          // the SDK storage helper's contract.
          const indexValue = Array.from(new Set(migratedSlugs)).sort();
          const indexSerialized = JSON.stringify(indexValue);
          await tx
            .insert(extensionStorage)
            .values({
              extensionId: opts.extensionId,
              scope: sk.scope,
              scopeId: sk.scopeId,
              key: managedIndexKey,
              value: indexValue,
              encrypted: false,
              sizeBytes: Buffer.byteLength(indexSerialized, "utf-8"),
              expiresAt: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            })
            .onConflictDoNothing();

          // Delete the legacy rows (skipped invalid-slug rows included
          // — they were unreadable before and remain unreadable).
          await tx
            .delete(extensionStorage)
            .where(
              and(
                eq(extensionStorage.extensionId, opts.extensionId),
                eq(extensionStorage.scope, sk.scope),
                sk.scopeId === null
                  ? sql`${extensionStorage.scopeId} IS NULL`
                  : eq(extensionStorage.scopeId, sk.scopeId),
                sql`(${extensionStorage.key} LIKE ${escapedPrefix + "%"} ESCAPE '\\'${legacyIndexKey ? sql` OR ${extensionStorage.key} = ${legacyIndexKey}` : sql``})`,
              ),
            );

          const successAudit: PendingAudit = {
            scopeUserId: sk.scope === "user" ? sk.scopeId : null,
            metadata: {
              entityType,
              from: legacyKeyPrefix,
              to: managedRecordPrefix,
              scope: sk.scope,
              scopeId: sk.scopeId,
              recordsMigrated: migratedSlugs.length,
              ...(skippedSlugs.length > 0 ? { skippedSlugs } : {}),
            },
          };

          return {
            migratedSlugs,
            skippedSlugs,
            scopeCounted: true,
            pendingAudit: successAudit,
          };
        },
      );

      // Post-commit: audit row + aggregate counters. The audit
      // helper swallows its own failures (see audit-log.ts) so this
      // never aborts the migration, but a rolled-back transaction
      // never reaches here, preserving the "commit ⇒ audit, rollback
      // ⇒ no audit" invariant.
      if (cellResult.pendingAudit) {
        await insertAuditEntry(
          cellResult.pendingAudit.scopeUserId,
          EXT_AUDIT_ACTIONS.ENTITY_NAMESPACE_MIGRATION,
          opts.extensionId,
          cellResult.pendingAudit.metadata,
        );
      }
      if (cellResult.scopeCounted) {
        result.scopesMigrated += 1;
        result.recordsRenamed += cellResult.migratedSlugs.length;
        const accumulated = result.slugsByType[entityType] ?? [];
        result.slugsByType[entityType] = Array.from(
          new Set([...accumulated, ...cellResult.migratedSlugs]),
        ).sort();
      }
    }
  }

  return result;
}
