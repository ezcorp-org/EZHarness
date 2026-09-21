/**
 * Auto-wire selected bundled extensions into conversations.
 *
 * Background: `EventSubscriptionDispatcher.dispatch()` gates `run:complete`
 * (and every other `eventSubscription`) delivery on the conversation
 * being wired into the subscriber via the `conversation_extensions`
 * table. Bundled extensions that need to fire on EVERY conversation
 * (not just the ones a user explicitly mentions) need a row for every
 * conversation they must observe.
 *
 * Two entry points, one rule:
 *   - `autoWireBundledExtensions(conversationId)` runs at conversation
 *     creation and wires that ONE conversation.
 *   - `reconcileBundledConversationWiring()` runs at boot and right
 *     after an activation enables a bundled extension. It wires EVERY
 *     conversation that still lacks a row.
 *
 * The reconcile exists because the create-time hook only fires while
 * the extension is already enabled. Every conversation created during a
 * disabled window — a failed bootstrap, an operator toggle, an upgrade
 * gap — stays permanently unwired, and the extension looks dead on it
 * forever. The reconcile closes that window with no migration and no
 * restart.
 *
 * It replaced two sentinel-gated one-time backfills
 * (`global:lessonsDistillerAutoWiringMigratedAt` and its memory-extractor
 * twin). Those settings rows are left in place but no longer read.
 * Consequence worth knowing: the sentinel used to protect a
 * user-driven unwiring from being re-added, and the reconcile does not.
 * A conversation unwired by hand is re-wired on the next boot or
 * activation. Wiring an enabled bundled extension everywhere is the
 * declared invariant; a per-conversation opt-out needs a tombstone
 * column, which this table does not have.
 *
 * Failure semantics: nothing here ever throws. A wiring failure must
 * not block conversation creation, boot, or activation — auto-
 * distillation and memory extraction degrade gracefully (silent skip)
 * but their hosts must carry on. Errors are logged and swallowed.
 */

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/connection";
import { addConversationExtensions } from "../db/queries/conversation-extensions";
import { getExtensionByName } from "../db/queries/extensions";
import { conversationExtensions, conversations } from "../db/schema";
import { logger } from "../logger";

const log = logger.child("auto-wire-bundled");

/** Manifest names of bundled extensions that get auto-wired into every
 *  conversation. The list is intentionally narrow — every entry costs a
 *  `conversation_extensions` row per conversation. Add entries
 *  deliberately. */
export const AUTO_WIRE_BUNDLED_EXTENSION_NAMES: readonly string[] = [
  "lessons-distiller",
  // Phase 53.4 Stage 1 — memory-extractor's `run:complete` handler is
  // gated on the same `conversation_extensions` row the lessons
  // distiller needs.
  "memory-extractor",
];

/** Bound transaction / parameter size on a first reconcile over a large
 *  database. PG's hard cap is 65535 bind params; each row carries a
 *  handful, so 500 rows per statement stays well clear of the ceiling
 *  while keeping the whole backfill to `ceil(n / 500)` statements
 *  instead of one per conversation. */
const RECONCILE_BATCH_SIZE = 500;

/**
 * Run `wire` once for every name in `AUTO_WIRE_BUNDLED_EXTENSION_NAMES`
 * whose registry row exists AND is enabled, and sum the rows it
 * inserted.
 *
 * A missing row means the bundled extension is not installed yet (boot
 * order, unseeded DB); a disabled row means the operator said no. Both
 * are silent skips — the next conversation create, boot, or activation
 * retries.
 *
 * Per-name errors are logged and swallowed so one broken extension
 * cannot fail the host operation, nor stop the remaining names from
 * being wired.
 */
async function wireEnabledBundledExtensions(
  operation: string,
  wire: (extensionId: string) => Promise<number>,
  context: Record<string, unknown> = {},
): Promise<number> {
  let wired = 0;
  for (const extensionName of AUTO_WIRE_BUNDLED_EXTENSION_NAMES) {
    try {
      const ext = await getExtensionByName(extensionName);
      if (!ext?.enabled) continue;
      wired += await wire(ext.id);
    } catch (err) {
      log.warn(`${operation} failed for bundled extension`, {
        ...context,
        extensionName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return wired;
}

/**
 * Insert a `conversation_extensions` row for every bundled extension in
 * `AUTO_WIRE_BUNDLED_EXTENSION_NAMES` that exists + is enabled in the
 * registry. Idempotent via `addConversationExtensions`'s
 * `onConflictDoNothing` clause.
 *
 * Returns the count of rows successfully inserted (pre-conflict). Tests
 * use this to assert the wiring fired without touching the DB directly.
 *
 * Errors are logged + swallowed — the caller cannot fail conversation
 * creation on a wiring miss.
 */
export async function autoWireBundledExtensions(
  conversationId: string,
): Promise<number> {
  return wireEnabledBundledExtensions(
    "auto-wire",
    async (extensionId) => {
      await addConversationExtensions(conversationId, [{ extensionId }]);
      return 1;
    },
    { conversationId },
  );
}

/**
 * Wire one extension into every conversation that lacks a row for it.
 *
 * One LEFT JOIN + `IS NULL` scan finds the gap — no per-conversation
 * probe. The insert is batched and `onConflictDoNothing`, so a
 * concurrent writer racing the same row costs nothing and a partial run
 * resumes naturally on the next call.
 *
 * Returns the number of rows actually inserted; a conflict does not
 * count, so a second run over a fully-wired database returns 0.
 */
async function wireEveryConversation(extensionId: string): Promise<number> {
  const db = getDb();
  const missing: { id: string }[] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .leftJoin(
      conversationExtensions,
      and(
        eq(conversationExtensions.conversationId, conversations.id),
        eq(conversationExtensions.extensionId, extensionId),
      ),
    )
    .where(isNull(conversationExtensions.extensionId));
  if (missing.length === 0) return 0;

  let inserted = 0;
  for (let i = 0; i < missing.length; i += RECONCILE_BATCH_SIZE) {
    const batch = missing.slice(i, i + RECONCILE_BATCH_SIZE);
    const rows = await db
      .insert(conversationExtensions)
      .values(batch.map((conv) => ({ conversationId: conv.id, extensionId })))
      .onConflictDoNothing()
      .returning({ id: conversationExtensions.id });
    inserted += rows.length;
  }
  log.info("reconciled bundled conversation wiring", {
    extensionId,
    unwired: missing.length,
    inserted,
  });
  return inserted;
}

/**
 * Bring `conversation_extensions` back in line with the enabled bundled
 * extensions: every conversation gets a row for every auto-wire name
 * that is installed and enabled right now.
 *
 * Call it at boot (`ensureBundledExtensions`) and immediately after an
 * activation enables a bundled extension, so a conversation created
 * during a disabled window starts receiving events without a restart.
 *
 * Idempotent and cheap to repeat: a fully-wired database costs one
 * anti-join per extension and inserts nothing. Never throws.
 *
 * Returns the number of rows inserted across every extension.
 */
export async function reconcileBundledConversationWiring(): Promise<number> {
  return wireEnabledBundledExtensions("reconcile", wireEveryConversation);
}
