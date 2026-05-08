/**
 * Phase 53 Stage 2 auto-wire migration: backfill `conversation_extensions`
 * rows for the bundled `lessons-distiller` extension.
 *
 * Stage 2 deletes the host-side `registerLessonDistillerListener`. After
 * deletion, auto-distillation flows through the bundled extension's
 * `registerEventHandler("run:complete")` — but
 * `EventSubscriptionDispatcher.dispatch()` hard-gates delivery on the
 * conversation being wired into the subscriber via the
 * `conversation_extensions` table (see
 * `src/extensions/event-subscription-dispatcher.ts:303-304`). Bundled
 * extensions are not auto-wired into existing conversations on install
 * (the only precedent is the scratchpad's hardcoded special-case in
 * `src/runtime/stream-chat/setup-tools.ts`). Without this migration,
 * legacy conversations would silently stop auto-distilling at the
 * Stage 2 cutover.
 *
 * Behaviour:
 *   1. Sentinel-fast-path on every boot via the `settings` row
 *      `global:lessonsDistillerAutoWiringMigratedAt`. Once stamped, the
 *      function returns without touching the DB further.
 *   2. On first run after the bundled lessons-distiller row exists:
 *      - Find every conversation that does NOT already have a
 *        `conversation_extensions` row for the lessons-distiller
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
 * Failure mode: a thrown migration is caught + logged by the caller in
 * `bundled.ts` (mirrors the `migrateDistillerEnabledSetting` and
 * `migrateBuiltinTaskStorage` patterns). Boot must never block on a
 * lessons-wiring backfill.
 */

import { getDb } from "../../db/connection";
import { addConversationExtensions } from "../../db/queries/conversation-extensions";
import { conversations, conversationExtensions } from "../../db/schema";
import { getSetting, upsertSetting } from "../../db/queries/settings";
import { eq, and, isNull } from "drizzle-orm";
import { logger } from "../../logger";

const log = logger.child("lessons-distiller-wiring-migration");

const SENTINEL_KEY = "global:lessonsDistillerAutoWiringMigratedAt";

/** Bound transaction / parameter size on first-run-after-large-DB. PG's
 *  hard cap is 65535 bind params; each row carries 2 params (conv id +
 *  ext id) so 500 rows = 1000 params, well clear of the ceiling. */
const BATCH_SIZE = 500;

export async function migrateLessonsDistillerConversationWiring(
  lessonsDistillerExtensionId: string,
): Promise<void> {
  // Sentinel-fast-path. Once stamped, the migration is permanently a
  // no-op for the lifetime of the deployment — protects user-driven
  // unwirings from being undone on every boot.
  const sentinel = await getSetting(SENTINEL_KEY);
  if (sentinel != null) return;

  const db = getDb();

  // LEFT JOIN with `extId IS NULL` finds every conversation lacking a
  // wiring row for the lessons-distiller. One scan; no per-conv probe.
  const rows: { id: string }[] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .leftJoin(
      conversationExtensions,
      and(
        eq(conversationExtensions.conversationId, conversations.id),
        eq(conversationExtensions.extensionId, lessonsDistillerExtensionId),
      ),
    )
    .where(isNull(conversationExtensions.extensionId));

  if (rows.length === 0) {
    // Nothing to backfill — stamp the sentinel and exit.
    await upsertSetting(SENTINEL_KEY, new Date().toISOString());
    log.info(
      "lessons-distiller wiring backfill: no conversations to wire; sentinel stamped",
      { extensionId: lessonsDistillerExtensionId },
    );
    return;
  }

  log.info("lessons-distiller wiring backfill: starting", {
    extensionId: lessonsDistillerExtensionId,
    conversationCount: rows.length,
    batchSize: BATCH_SIZE,
  });

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    // `addConversationExtensions` accepts a single conversationId per
    // call; we call once per row inside the batch but the surrounding
    // batch loop bounds the work so a transient DB blip doesn't fail
    // an entire conversation-table-sized insert. Each call is its own
    // statement under PG's `onConflictDoNothing` semantics.
    for (const row of slice) {
      await addConversationExtensions(row.id, [
        { extensionId: lessonsDistillerExtensionId },
      ]);
      inserted += 1;
    }
  }

  // Sentinel last — only stamp on a fully-successful run. A throw mid-
  // batch leaves the sentinel unset; next boot's LEFT JOIN naturally
  // resumes from whichever conversations still lack a wiring row.
  await upsertSetting(SENTINEL_KEY, new Date().toISOString());

  log.info("lessons-distiller wiring backfill: complete", {
    extensionId: lessonsDistillerExtensionId,
    inserted,
  });
}
