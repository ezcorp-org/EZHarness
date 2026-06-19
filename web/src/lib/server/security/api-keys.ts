import crypto from "node:crypto";
import {
  getAllSettings,
  getSetting,
  upsertSetting,
} from "$server/db/queries/settings";
import {
  type ApiKeyEntry,
  type ApiKeyHashIndexEntry,
  type ApiKeyScope,
  apiKeyHashIndexKey,
  hashApiKey,
} from "$server/auth/api-key";

// Re-export the pure key primitives from the shared backend module so the
// SvelteKit server and the CLI (`src/cli.ts key:mint`) share ONE definition.
// See `src/auth/api-key.ts`.
export {
  type ApiKeyEntry,
  type ApiKeyScope,
  type GeneratedKey,
  API_KEY_SCOPES,
  apiKeySettingsKey,
  apiKeySettingsPrefix,
  generateApiKey,
  hashApiKey,
  isApiKeyScope,
} from "$server/auth/api-key";

interface VerifiedKey {
  userId: string;
  scopes: ApiKeyScope[];
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
      return { userId: entry.userId, scopes: entry.scopes, name: entry.name };
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
      return { userId: entry.userId, scopes: entry.scopes, name: entry.name };
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
 *   - An API-key (or internal-auth) principal is ALWAYS minted with
 *     `role: "member"` in bearer-auth.ts, so it can never be admin by role
 *     even if it holds the `admin` SCOPE — exactly the property we want for
 *     "this action requires a real admin human".
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
