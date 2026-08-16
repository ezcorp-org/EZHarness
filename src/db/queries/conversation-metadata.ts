/**
 * Atomic `conversations.metadata` writes.
 *
 * WHY THIS MODULE EXISTS. `conversations.metadata` is one shared jsonb bag with
 * several independent owners — `spawnDepth` (spawn-assignment),
 * `spawnParentAuditId` (the PDP audit chain) and `goal` (the `/goal`
 * autopilot). Every writer used to be a JS read-modify-write that SELECTed the
 * whole column, spread a key in, and UPDATEd the whole column back. Two of
 * those interleaving lose one side outright: the second UPDATE overwrites the
 * key the first one wrote, with no error and no trace. It is not theoretical —
 * `writePersistedGoal` fires on every goal-evaluator cycle, so a user's `/goal`
 * could be silently erased by any concurrent metadata write.
 *
 * The fix is to stop reading in JS at all: `||` merges the patch into the
 * column inside a single UPDATE, so the read and the write are one statement
 * and the loser of a race is the *key*, not the whole bag.
 *
 * ── THE `::text::jsonb` CAST IS LOAD-BEARING ────────────────────────────────
 *
 * Measured on both drivers (PGlite 0.x and a real Postgres 16 through
 * `Bun.sql`), binding the patch as `$1::jsonb`:
 *
 *   PGlite   `... || $1::jsonb`  → {"goal": …, "spawnDepth": 3}   (an object)
 *   bun-sql  `... || $1::jsonb`  → [{"spawnDepth": 3}, "{\"goal\":…}"]  (!)
 *
 * Bun.sql sees a parameter whose target type is jsonb and JSON-encodes the
 * value a SECOND time, so the JSON *text* lands as a jsonb STRING SCALAR and
 * `||` concatenates an object with a scalar into a two-element ARRAY. Nothing
 * throws; `metadata->>'goal'` simply reads back NULL forever after. This is the
 * same double-encoding hazard documented on `serializeJsonbFields`
 * (`./extensions.ts`) and on the identity mapper in `../nul-column-patch.ts`.
 *
 * `::text` pins the parameter to text, which both drivers put on the wire
 * verbatim; the second cast then makes Postgres PARSE it. That one token makes
 * a single expression correct on both drivers, so this module needs no
 * `getPglite()` conditional.
 *
 * ── THE NUL SCRUB IS EXPLICIT, ON PURPOSE ───────────────────────────────────
 *
 * The U+0000 scrubber is installed on the drizzle COLUMN prototype
 * (`../nul-column-patch.ts`), and a raw `sql` fragment never reaches a column
 * mapper — the parameter goes to the driver untouched. Verified: the fragment
 * below binds `params[0]` exactly as handed to it. The four writers this module
 * replaces were all protected by the prototype patch, so calling
 * `sanitizeNulDeep` here is what keeps that protection rather than an extra
 * belt: goal text is LLM/user-authored, and `JSON.stringify` of a NUL-bearing
 * value emits the escape `\u0000`, which Postgres refuses for jsonb
 * ("unsupported Unicode escape sequence") — an exception on both drivers.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { conversations } from "../schema";
import { isPlainObject, sanitizeNulDeep } from "../sanitize-nul";

/**
 * Merge `patch` into `conversations.metadata` in ONE statement.
 *
 * Shallow merge, jsonb `||` semantics: top-level keys in `patch` replace those
 * already present, every other key is preserved, and a NULL column starts from
 * `{}`. An unknown `id` matches no row and is a silent no-op — the same
 * observable behaviour as the `if (!conv) return` guard this replaces.
 *
 * ── WHY A RUNTIME TYPE CHECK ON AN ALREADY-TYPED PARAMETER ──────────────────
 *
 * `Record<string, unknown>` is erased at runtime, and jsonb `||` does NOT
 * refuse a non-object right operand — it CONCATENATES. Measured on PGlite with
 * the statement below, starting from `{"goal":"g","spawnDepth":3}`:
 *
 *   {x:1}   →  {"x":1,"goal":"g","spawnDepth":3}          (object, correct)
 *   [1,2]   →  [{"goal":"g","spawnDepth":3},1,2]          (ARRAY)
 *   "hi"    →  [{"goal":"g","spawnDepth":3},"hi"]         (ARRAY)
 *   null    →  [{"goal":"g","spawnDepth":3},null]         (ARRAY)
 *
 * Nothing throws, and `metadata->>'goal'` reads NULL from every one of the
 * bottom three — the SAME observable corruption the `::text::jsonb` cast above
 * exists to prevent, reached through a different door. This bag has several
 * independent owners and one shared write path, so the loss is not confined to
 * the caller that made the mistake. Throwing keeps the bad write OUT of the
 * database and names its author in the stack.
 */
export async function mergeConversationMetadata(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!isPlainObject(patch)) {
    throw new TypeError(
      "mergeConversationMetadata: patch must be a plain object — jsonb `||` " +
        "concatenates an array/scalar operand into an ARRAY instead of merging it",
    );
  }
  const clean = JSON.stringify(sanitizeNulDeep(patch));
  await getDb()
    .update(conversations)
    .set({
      metadata: sql`COALESCE(${conversations.metadata}, '{}'::jsonb) || ${clean}::text::jsonb`,
    })
    .where(eq(conversations.id, id));
}

/**
 * Delete ONE top-level key from `conversations.metadata` in one statement.
 *
 * `key` is a compile-time union, never caller data, and it is interpolated
 * through drizzle's parameter binding all the same — no key can be a `-`
 * operand smuggled in as SQL.
 */
export async function deleteConversationMetadataKey(
  id: string,
  key: ConversationMetadataKey,
): Promise<void> {
  await getDb()
    .update(conversations)
    .set({ metadata: sql`COALESCE(${conversations.metadata}, '{}'::jsonb) - ${key}::text` })
    .where(eq(conversations.id, id));
}

/**
 * The keys `deleteConversationMetadataKey` may remove. Deliberately a closed
 * union: the bag has independent owners, and "delete an arbitrary key" is not
 * an operation any of them should be able to ask for.
 */
export type ConversationMetadataKey = "goal" | "callerTools";

/** Drop the `/goal` autopilot's persisted goal — the canonical disarm write. */
export async function deleteGoalMetadata(id: string): Promise<void> {
  await deleteConversationMetadataKey(id, "goal");
}

/** Drop the caller-executed-tools declaration bag. */
export async function deleteCallerToolsMetadata(id: string): Promise<void> {
  await deleteConversationMetadataKey(id, "callerTools");
}
