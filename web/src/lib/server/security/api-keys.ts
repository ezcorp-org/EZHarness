import crypto from "node:crypto";
import {
  getAllSettings,
  getSetting,
  upsertSetting,
} from "$server/db/queries/settings";
import {
  type ApiKeyEntry,
  type ApiKeyHashIndexEntry,
  type ApiKeyRole,
  type ApiKeyScope,
  apiKeyHashIndexKey,
  hashApiKey,
} from "$server/auth/api-key";

// Re-export the pure key primitives from the shared backend module so the
// SvelteKit server and the CLI (`src/cli.ts key:mint`) share ONE definition.
// See `src/auth/api-key.ts`.
export {
  type ApiKeyEntry,
  type ApiKeyRole,
  type ApiKeyScope,
  type GeneratedKey,
  API_KEY_SCOPES,
  API_KEY_ROLES,
  apiKeySettingsKey,
  apiKeySettingsPrefix,
  canMintRole,
  generateApiKey,
  hashApiKey,
  isApiKeyRole,
  isApiKeyScope,
} from "$server/auth/api-key";

interface VerifiedKey {
  userId: string;
  scopes: ApiKeyScope[];
  role: ApiKeyRole;
  name: string;
}

/** Constant-time hash comparison. Both inputs are fixed-width SHA-256 hex
 *  digests; a length mismatch (only possible against corrupt data) short-
 *  circuits to `false` rather than throwing from timingSafeEqual. */
function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function verifyApiKey(raw: string): Promise<VerifiedKey | null> {
  const hash = hashApiKey(raw);

  // Fast path: O(1) lookup via the hash index written at mint time. The
  // pointer tells us exactly which per-user row to load, so we avoid
  // scanning the whole settings table on every Bearer request.
  const pointer = (await getSetting(apiKeyHashIndexKey(hash))) as
    | ApiKeyHashIndexEntry
    | undefined;
  if (pointer) {
    const entry = (await getSetting(
      `apikey:${pointer.userId}:${pointer.keyId}`,
    )) as ApiKeyEntry | undefined;
    // Defend against a dangling pointer (canonical row deleted out from
    // under a stale index): still verify the hash with constant-time
    // comparison before trusting the row.
    if (entry && hashesEqual(entry.hash, hash)) {
      // `role` is optional on-disk (keys minted before role-carrying keys
      // existed have none) → default to the least-privileged `member`.
      return {
        userId: entry.userId,
        scopes: entry.scopes,
        role: entry.role ?? "member",
        name: entry.name,
      };
    }
  }

  // Slow path / legacy fallback: keys minted before the hash index existed
  // have no pointer. Scan once, and lazily write the index for the matched
  // key so it upgrades to the fast path on its next use (no migration).
  const all = await getAllSettings();
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith("apikey:")) continue;
    const entry = value as ApiKeyEntry;
    if (hashesEqual(entry.hash, hash)) {
      const indexEntry: ApiKeyHashIndexEntry = {
        userId: entry.userId,
        keyId: key.slice(`apikey:${entry.userId}:`.length),
      };
      try {
        await upsertSetting(apiKeyHashIndexKey(hash), indexEntry);
      } catch {
        // Best-effort upgrade; a write failure must not fail the auth.
      }
      return {
        userId: entry.userId,
        scopes: entry.scopes,
        role: entry.role ?? "member",
        name: entry.name,
      };
    }
  }
  return null;
}

export function requireScope(
  locals: { apiKeyScopes?: ApiKeyScope[] },
  scope: ApiKeyScope,
): Response | null {
  if (!locals.apiKeyScopes) return null; // cookie auth -- allow all
  if (locals.apiKeyScopes.includes(scope)) return null;
  return Response.json({ error: "Insufficient scope", required: scope }, { status: 403 });
}

/**
 * Gate a route on BEING AN ADMIN, across BOTH authorization axes.
 *
 * `requireScope(locals,"admin")` alone is a footgun: it returns null
 * (ALLOW) for any cookie session because `locals.apiKeyScopes` is
 * undefined there — so a non-admin member with a browser cookie sails
 * through. The fix is to gate on the principal's ROLE, which is the real
 * authority an admin route cares about:
 *   - A cookie session carries the human's true role (`admin`/`member`).
 *   - An API-key (or internal-auth) principal defaults to `role: "member"`.
 *     It is `admin` ONLY when it is an explicitly minted admin-ROLE key
 *     (`ezcorp key mint --role admin` / `POST …/api-keys {role:"admin"}`),
 *     never merely by holding the `admin` SCOPE. And even an admin-role key
 *     is re-validated on every request in bearer-auth.ts: its owner is
 *     re-loaded and the effective role is CLAMPED to the owner's CURRENT
 *     role, so a since-demoted owner's key degrades to `member` (and a
 *     banned/deleted owner's key is rejected outright). Minting an admin-role
 *     key requires an admin actor (`canMintRole`), so this stays a
 *     deliberate, admin-authorized elevation — not something any scoped key
 *     can reach.
 *
 * Returns a 403 Response when the principal is not an admin, else null —
 * matching `requireScope`'s return-style so call sites stay
 * `const err = requireAdmin(locals); if (err) return err;`.
 *
 * Place admin routes behind THIS (or `requireScope("admin")` paired with
 * `requireRole(locals,"admin")`); the route-contract meta-test enforces
 * that pairing so this whole class of bug can't reappear.
 */
export function requireAdmin(
  locals: { user?: { role?: string } },
): Response | null {
  if (locals.user?.role === "admin") return null;
  return Response.json({ error: "Admin role required" }, { status: 403 });
}
