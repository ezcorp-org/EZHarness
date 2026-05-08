/**
 * Auto-wire selected bundled extensions into newly-created conversations.
 *
 * Background: `EventSubscriptionDispatcher.dispatch()` gates `run:complete`
 * (and every other `eventSubscription`) delivery on the conversation
 * being wired into the subscriber via the `conversation_extensions`
 * table. Bundled extensions that need to fire on EVERY conversation
 * (not just the ones a user explicitly mentions) need a row inserted
 * at conversation-create time.
 *
 * Phase 53 Stage 2 introduces the lessons-distiller as the first
 * generalised opt-in. The scratchpad already has a hardcoded
 * special-case in `src/runtime/stream-chat/setup-tools.ts`; future
 * bundled extensions can opt in by adding their manifest name to
 * `AUTO_WIRE_BUNDLED_EXTENSION_NAMES`.
 *
 * Failure semantics: this helper NEVER throws. A wiring failure must
 * not block conversation creation — auto-distillation degrades
 * gracefully (silent skip; the legacy host listener was already a
 * fire-and-forget shape) but the conversation itself must persist.
 * Errors are logged and swallowed.
 */

import { getExtensionByName } from "../db/queries/extensions";
import { addConversationExtensions } from "../db/queries/conversation-extensions";
import { logger } from "../logger";

const log = logger.child("auto-wire-bundled");

/** Manifest names of bundled extensions that get auto-wired into every
 *  newly-created conversation. The list is intentionally narrow —
 *  every entry costs a `conversation_extensions` row per conversation
 *  per user. Add entries deliberately. */
export const AUTO_WIRE_BUNDLED_EXTENSION_NAMES: readonly string[] = [
  "lessons-distiller",
];

/**
 * Insert `conversation_extensions` rows for every bundled extension in
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
  let wired = 0;
  for (const name of AUTO_WIRE_BUNDLED_EXTENSION_NAMES) {
    try {
      const ext = await getExtensionByName(name);
      if (!ext) {
        // Bundled extension hasn't been installed yet (boot order issue
        // or DB not yet seeded). Silent skip — the next conversation
        // create will retry, and the backfill migration covers the
        // gap once `ensureBundledExtensions` runs.
        continue;
      }
      if (!ext.enabled) {
        // Operator disabled the extension; respect the choice.
        continue;
      }
      await addConversationExtensions(conversationId, [
        { extensionId: ext.id },
      ]);
      wired += 1;
    } catch (err) {
      // Wiring failure is non-fatal — the conversation must persist.
      log.warn("auto-wire failed for bundled extension", {
        conversationId,
        extensionName: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return wired;
}
