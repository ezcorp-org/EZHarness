/**
 * Grant the new `write` scope to every already-issued key that holds `read`.
 *
 * ## Why this migration has to exist
 *
 * 18 handlers used to gate mutation on the `read` scope — `POST /api/memories`,
 * `DELETE /api/lessons/:id`, and so on (the full list is in
 * docs/audit/2026-08-read-scope-mutation-inventory.md). They now gate on
 * `write`. Without a backfill, every key an operator has already issued
 * silently loses the ability to mutate the moment this release lands, and
 * there is no way to repair it in place:
 *
 *   - There is NO update-scopes endpoint.
 *     `web/src/routes/api/settings/developer/api-keys/+server.ts` exposes
 *     GET (:24), POST (:41) and DELETE (:76) — mint, list, revoke. Nothing edits
 *     an existing row's scopes.
 *   - The raw key is displayed exactly once, at mint time (`+server.ts:73`).
 *     Re-minting therefore means handing every integration a NEW secret
 *     out-of-band, which for an unattended CI key means downtime.
 *
 * ## Why it is SAFE to rewrite the scopes of a live key
 *
 * Because a key's authority is not sealed into its secret. `generateApiKey`
 * (src/auth/api-key.ts) hashes ONLY the random string; the scope list lives
 * beside the hash in a mutable JSONB settings row at `apikey:<userId>:<keyId>`
 * (`apiKeySettingsKey`), and `verifyApiKey`
 * (web/src/lib/server/security/api-keys.ts:53-107) re-reads that row on every
 * request. So editing `scopes` here takes effect on the key's very next use,
 * with the same secret. There is no signature over the scope list to
 * invalidate and nothing cached across the boundary.
 *
 * ## Scope of the rewrite — deliberately narrow
 *
 * `read` is the ONLY trigger. A key minted `--scopes chat` never had the
 * ability to mutate those 18 handlers (scopes are flat: `chat` does not
 * subsume `read`, so a chat-only key was already refused by all of them), and
 * granting it `write` here would hand it authority it never had. That would be
 * a privilege ESCALATION performed by a migration, which is exactly the thing
 * a migration must never do. So: `read` in, `write` added; anything else
 * untouched.
 *
 * Safety properties:
 *   - **Additive only.** `||` appends; no existing scope is removed or
 *     reordered, so a key's other authority is bit-for-bit preserved.
 *   - **Never escalates.** A row without `read` is excluded by the `@> "read"`
 *     predicate, so no key gains an authority it did not already exercise.
 *   - **Idempotent.** After the append the row contains `write`, so the
 *     `NOT (... @> "write")` guard excludes it forever after. Re-running is a
 *     no-op by construction, not by a version ledger — the contract for
 *     everything in this codebase's boot migration (there is no migration
 *     version table).
 *   - **Touches only key rows.** `LIKE 'apikey:%'` requires a literal colon at
 *     offset 6, so the derived hash-index rows (`apikeyhash:<hash>`,
 *     `apiKeyHashIndexKey`) do NOT match — their 7th character is `h`. Those
 *     rows carry no scopes and must not be rewritten. Note the shape guard
 *     below ALSO excludes them (they have no `scopes` array), so the two are
 *     defence in depth; what the prefix uniquely protects is an unrelated row
 *     whose key merely starts with `apikey` and which DOES carry a `scopes`
 *     array. Both directions are asserted in the migration test.
 *   - **Shape-guarded.** `jsonb_typeof(value->'scopes') = 'array'` skips any
 *     row whose `scopes` is missing or malformed rather than corrupting it
 *     into `null || "write"`.
 *   - **Safe on zero matches.** `UPDATE ... WHERE <no rows>` is a no-op, so a
 *     fresh database and an already-migrated one both pass straight through.
 *
 * Applied from src/db/migrate.ts. This file is the single source of truth for
 * the SQL — migrate.ts calls `up()`, it does not re-inline the statement —
 * mirroring add-user-commands-unique-name.ts and
 * normalize-extension-state-root.ts.
 */
import { sql } from "drizzle-orm";

/** Settings-key prefix for the canonical per-user key rows. The trailing
 *  colon is what excludes the `apikeyhash:` index rows. */
const API_KEY_ROW_PREFIX = "apikey:";

export async function up(db: {
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>;
}): Promise<void> {
  const scopes = sql`value -> 'scopes'`;
  await db.execute(sql`
    UPDATE settings
    SET value = jsonb_set(value, '{scopes}', ${scopes} || '"write"'::jsonb)
    WHERE key LIKE ${`${API_KEY_ROW_PREFIX}%`}
      AND jsonb_typeof(${scopes}) = 'array'
      AND ${scopes} @> '"read"'::jsonb
      AND NOT (${scopes} @> '"write"'::jsonb)
  `);
}
