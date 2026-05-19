/**
 * Phase 53.4 Stage 1 auto-wire migration: backfill
 * `conversation_extensions` rows for the bundled `memory-extractor`
 * extension across every existing conversation.
 *
 * Sibling of `lessons-distiller-conversation-wiring.ts`. Same
 * sentinel-gated, idempotent backfill pattern; same LEFT-JOIN+IS-NULL
 * scan; same batching strategy. The two migrations are kept as
 * separate modules (rather than collapsed into a single helper) so
 * each carries its own sentinel key and can be reverted / replayed
 * independently.
 *
 * Why now (not Stage 2):
 *   The memory-extractor's `run:complete` handler is wired in this
 *   commit. Stage 1 keeps the legacy `registerExtractionListener`
 *   live, so the bundled extension is a "ride-along" until Stage 2.
 *   But Stage 1 must establish the wiring rows so the parity test +
 *   UAT can verify the extension actually fires on existing
 *   conversations — without the rows, `EventSubscriptionDispatcher`
 *   silently drops the event delivery and the extension looks dead.
 *
 * Behaviour:
 *   1. Sentinel-fast-path on every boot via the `settings` row
 *      `global:memoryExtractorAutoWiringMigratedAt`. Once stamped,
 *      the function returns without touching the DB further.
 *   2. On first run after the bundled memory-extractor row exists:
 *      - Find every conversation that does NOT already have a
 *        `conversation_extensions` row for the memory-extractor
 *        extension id (a LEFT JOIN with `IS NULL` filter — single
 *        scan; no per-conversation lookup).
 *      - Insert wiring rows in batches of 500 to keep parameter
 *        binding under PG's 65k-arg ceiling and to bound transaction
 *        size on large datasets.
 *      - `onConflictDoNothing` on each batch so a partial run is
 *        replayable without UNIQUE-violation errors.
 *   3. Stamp the sentinel only on a fully-successful run. A throw
 *      mid-batch leaves the sentinel unset → next boot retries from
 *      where the LEFT JOIN's `IS NULL` filter naturally resumes.
 *
 * Idempotency contract:
 *   - The sentinel is the fast path. Once present, the function is a
 *     no-op even if the user has manually unwired conversations from
 *     the extension via the UI — we deliberately do NOT re-add rows
 *     a user removed. User intent wins; the sentinel respects it.
 *   - Without the sentinel (e.g. test reset, manual delete),
 *     `addConversationExtensions`'s `onConflictDoNothing` makes the
 *     re-run safe for any conversation that's still wired.
 *
 * Failure mode: a thrown migration is caught + logged by the caller
 * in `bundled.ts` (mirrors the lessons-distiller wiring migration).
 * Boot must never block on a memory-extractor wiring backfill.
 */

import { getDb } from "../../db/connection";
import { addConversationExtensions } from "../../db/queries/conversation-extensions";
import { conversations, conversationExtensions } from "../../db/schema";
import { getSetting, upsertSetting } from "../../db/queries/settings";
import { eq, and, isNull } from "drizzle-orm";
import { logger } from "../../logger";

const log = logger.child("memory-extractor-wiring-migration");

const SENTINEL_KEY = "global:memoryExtractorAutoWiringMigratedAt";

/** Bound transaction / parameter size on first-run-after-large-DB. PG's
 *  hard cap is 65535 bind params; each row carries 2 params (conv id +
 *  ext id) so 500 rows = 1000 params, well clear of the ceiling. */
const BATCH_SIZE = 500;

export async function migrateMemoryExtractorConversationWiring(
  memoryExtractorExtensionId: string,
): Promise<void> {
  // Sentinel-fast-path. Once stamped, the migration is permanently a
  // no-op for the lifetime of the deployment — protects user-driven
  // unwirings from being undone on every boot.
  const sentinel = await getSetting(SENTINEL_KEY);
  if (sentinel != null) return;

  const db = getDb();

  // LEFT JOIN with `extId IS NULL` finds every conversation lacking a
  // wiring row for the memory-extractor. One scan; no per-conv probe.
  const rows: { id: string }[] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .leftJoin(
      conversationExtensions,
      and(
        eq(conversationExtensions.conversationId, conversations.id),
        eq(conversationExtensions.extensionId, memoryExtractorExtensionId),
      ),
    )
    .where(isNull(conversationExtensions.extensionId));

  if (rows.length === 0) {
    // Nothing to backfill — stamp the sentinel and exit.
    await upsertSetting(SENTINEL_KEY, new Date().toISOString());
    log.info(
      "memory-extractor wiring backfill: no conversations to wire; sentinel stamped",
      { extensionId: memoryExtractorExtensionId },
    );
    return;
  }

  log.info("memory-extractor wiring backfill: starting", {
    extensionId: memoryExtractorExtensionId,
    conversationCount: rows.length,
    batchSize: BATCH_SIZE,
  });

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    for (const row of slice) {
      await addConversationExtensions(row.id, [
        { extensionId: memoryExtractorExtensionId },
      ]);
      inserted += 1;
    }
  }

  // Sentinel last — only stamp on a fully-successful run. A throw mid-
  // batch leaves the sentinel unset; next boot's LEFT JOIN naturally
  // resumes from whichever conversations still lack a wiring row.
  await upsertSetting(SENTINEL_KEY, new Date().toISOString());

  log.info("memory-extractor wiring backfill: complete", {
    extensionId: memoryExtractorExtensionId,
    inserted,
  });
}
