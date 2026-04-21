/**
 * Internal (bundled-extension) API key authentication.
 *
 * Security posture
 * ----------------
 * Bundled extensions like `@ezcorp/ai-kit` need to call back into the same
 * EZCorp server they're running inside. Rather than force the operator to
 * manually generate a long-lived API key, the server auto-provisions a
 * key for each allowlisted bundled extension on startup and injects it
 * into that extension's subprocess env.
 *
 * Because these keys bypass the normal user-facing key-management flow,
 * we apply extra controls on top of `verifyApiKey`:
 *
 *   1. Distinct prefix `ezkint_` (vs user-key `ezk_`) so log scans and
 *      middleware routing can differentiate them; the prefix alone is not
 *      a security boundary.
 *   2. Ephemeral storage — keys live in an in-process `Map`, never touch
 *      the DB, disk, or any settings table. A server restart mints fresh
 *      keys; stolen keys die with the process.
 *   3. Loopback-only — verification rejects any request whose remote
 *      address is not `127.0.0.1` / `::1`. This limits the blast radius
 *      if an attacker somehow exfiltrates the key (e.g., from /proc of a
 *      compromised extension subprocess). A leaked key is useless from
 *      any other host.
 *   4. Constant-time comparison via `crypto.timingSafeEqual` — defeats
 *      the byte-by-byte timing leak that a naive `===` on hex strings
 *      allows across thousands of probe requests.
 *   5. Minimum scopes — keys are minted with the scopes the extension
 *      actually needs (`read`, `chat`, `extensions`), NEVER `admin`. A
 *      compromised subprocess can't create new API keys, delete users,
 *      or touch billing.
 *   6. Identity isolation — verified keys resolve to a system-internal
 *      "service user" shape whose `id` is `sys:<extensionName>`, so
 *      audit logs/analytics can always tell an extension-originated
 *      request from a human-originated one.
 *   7. Log hygiene — only the keyId (a UUID) is logged. The raw key and
 *      its hash are never surfaced in any log, error, or thrown value.
 *   8. Revoke on uninstall — `revokeInternalKey(name)` wipes the map
 *      entry; subsequent subprocess spawns won't get a key. Extensions
 *      removed via the UI or CLI drop their internal credential atomically.
 *
 * This module is intentionally small. It's a trust anchor; every line has
 * security implications and every change should come with a test.
 */

import crypto from "node:crypto";
import type { ApiKeyScope } from "./api-keys";

/** Raw-key prefix. Allows log scans + middleware routing to distinguish
 *  internal keys from user-issued keys at a glance. Not a security
 *  boundary on its own. */
export const INTERNAL_KEY_PREFIX = "ezkint_";

/** In-memory registry of active internal keys. Key: extensionName. */
interface StoredKey {
  keyId: string;
  hash: Buffer; // raw SHA-256 bytes, used with timingSafeEqual
  scopes: readonly ApiKeyScope[];
  extensionName: string;
  /** The DB users.id the principal resolves to. Provisioned separately
   *  via ensureSystemUser() so conversations + other FK-bearing rows can
   *  legally reference it. Stored here so verify() can return it without
   *  hitting the DB on every request. */
  userId: string;
  createdAt: number;
}

const store = new Map<string, StoredKey>();

/** Hash a raw key to its SHA-256 bytes. Returns a `Buffer` so callers can
 *  feed it directly to `timingSafeEqual` (which rejects string inputs). */
function sha256(raw: string): Buffer {
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

/** RFC 5735 loopback addresses. `::1` is IPv6 loopback; `127.0.0.0/8` is
 *  IPv4 loopback — we accept the common `127.0.0.1` and the IPv4-mapped
 *  IPv6 form `::ffff:127.0.0.1`. Unix-domain socket requests surface as
 *  empty string in some runtimes; those are local by definition.
 *
 *  IMPORTANT: the match is exact on the canonical forms. Parsing is done
 *  in clearly-scoped stages (zone id → bracketed IPv6 port → trailing
 *  IPv4 port) rather than one sloppy regex, so attacker-crafted strings
 *  like `127.0.0.1.evil.com`, `1127.0.0.1`, or `0127.0.0.1` can't squeak
 *  through. Each stage normalizes to a candidate string that is then
 *  compared against the exact allowlist. */
const LOOPBACK_SET: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

export function isLoopbackAddress(remoteAddr: string | undefined | null): boolean {
  if (remoteAddr === null || remoteAddr === undefined || remoteAddr === "") return true;
  if (typeof remoteAddr !== "string") return false;
  if (LOOPBACK_SET.has(remoteAddr)) return true;

  // Strip IPv6 zone id: `::1%lo0` → `::1`
  let addr = remoteAddr.replace(/%[^]*$/, "");
  if (LOOPBACK_SET.has(addr)) return true;

  // Strip bracketed IPv6 port: `[::1]:8080` → `::1`
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(addr);
  if (bracket) {
    addr = bracket[1]!;
    if (LOOPBACK_SET.has(addr)) return true;
  }

  // IPv4-in-IPv6 fail-closed: reject anything that starts with `::ffff:`
  // but isn't the canonical form. Linux normalises `::ffff:0x7f000001`,
  // `::ffff:2130706433`, etc. to `::ffff:127.0.0.1` before Bun sees the
  // address, so alt forms shouldn't reach us in practice. Defense-in-
  // depth: if a future runtime ever surfaces one, reject rather than
  // accept.
  if (/^::ffff:/i.test(addr) && addr !== "::ffff:127.0.0.1") return false;

  // Strip IPv4 port: `127.0.0.1:8080` → `127.0.0.1`. Only applied when
  // the address has no `::` sequence (unambiguously not IPv6) so we
  // don't clip a real IPv6 segment.
  if (!addr.includes("::")) {
    addr = addr.replace(/:\d+$/, "");
  }
  return LOOPBACK_SET.has(addr);
}

export interface ProvisionResult {
  raw: string;
  keyId: string;
}

/** Mint a fresh internal key for the named extension. Overwrites any
 *  prior key for the same name (callers opting in at startup always get a
 *  clean slate). Returns the raw key ONCE — the caller is responsible for
 *  handing it to the subprocess env and then discarding the reference.
 *
 *  `userId` must be the DB users.id of a previously-seeded system-user
 *  row. `bootstrapBundledCredentials` calls `ensureSystemUser` first,
 *  then passes the resulting id here; see `system-user.ts` for why the
 *  mapping exists (conversations FK → users). */
export function provisionInternalKey(
  extensionName: string,
  scopes: readonly ApiKeyScope[],
  userId: string,
): ProvisionResult {
  if (!extensionName || typeof extensionName !== "string") {
    throw new Error("provisionInternalKey: extensionName required");
  }
  if (!userId || typeof userId !== "string") {
    throw new Error("provisionInternalKey: userId required (seed via ensureSystemUser)");
  }
  if (scopes.length === 0) {
    throw new Error("provisionInternalKey: at least one scope required");
  }
  if (scopes.includes("admin")) {
    // Defense-in-depth: refuse to mint admin-scoped internal keys. If an
    // extension needs admin-equivalent capabilities, it should go through
    // the explicit human-approved API-key flow.
    throw new Error("provisionInternalKey: 'admin' scope is forbidden for internal keys");
  }
  const raw = INTERNAL_KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
  const keyId = crypto.randomUUID();
  store.set(extensionName, {
    keyId,
    hash: sha256(raw),
    scopes,
    extensionName,
    userId,
    createdAt: Date.now(),
  });
  return { raw, keyId };
}

/** Revoke any key currently registered for the named extension. Safe to
 *  call when no key exists. Use on extension uninstall or disable. */
export function revokeInternalKey(extensionName: string): boolean {
  return store.delete(extensionName);
}

/** Wipe the entire internal-key registry. Use only for tests. */
export function resetInternalKeyStoreForTests(): void {
  store.clear();
}

export interface InternalKeyPrincipal {
  /** Pseudo-userId — prefixed `sys:` so it can never collide with a real
   *  UUID user id and so audit logs obviously flag extension origin. */
  userId: string;
  scopes: readonly ApiKeyScope[];
  name: string;
  keyId: string;
  extensionName: string;
}

/** Verify a candidate raw key. Returns `null` (never throws) when any
 *  check fails — callers treat null as "not an internal key" and fall
 *  back to the user-key path.
 *
 *  Security checks, in order of cheapness:
 *    1. Prefix match — cheap, no secret comparison.
 *    2. Loopback enforcement — cheap string check. A non-loopback request
 *       bearing an internal-prefixed key is rejected without probing the
 *       key store at all (no timing signal about whether the key exists).
 *    3. Constant-time hash compare against every registered extension's
 *       stored hash. We loop over all entries rather than short-circuit
 *       to keep timing proportional to the number of extensions, not to
 *       which one matches. */
export function verifyInternalKey(
  raw: string,
  remoteAddr: string | undefined | null,
): InternalKeyPrincipal | null {
  if (typeof raw !== "string" || !raw.startsWith(INTERNAL_KEY_PREFIX)) return null;
  if (!isLoopbackAddress(remoteAddr)) return null;

  const candidate = sha256(raw);
  let match: StoredKey | null = null;
  for (const entry of store.values()) {
    // Both buffers are fixed-width SHA-256 (32 bytes), so timingSafeEqual
    // won't throw on length mismatch. Don't early-exit on match — keep
    // iterating so the loop's wall time is constant across the set.
    if (crypto.timingSafeEqual(entry.hash, candidate)) {
      match = entry;
    }
  }
  if (!match) return null;
  return {
    // Resolves to the DB users.id of the seeded system-user row. Prefix
    // `sys-` (enforced by systemUserIdFor) keeps the machine-origin
    // signal obvious in logs while satisfying the users.id FK.
    userId: match.userId,
    scopes: match.scopes,
    name: `internal:${match.extensionName}`,
    keyId: match.keyId,
    extensionName: match.extensionName,
  };
}

/** Inspection helper for diagnostics + tests. Returns metadata only —
 *  never the hash, raw key, or the resolved system-user id. Explicit
 *  field selection prevents future StoredKey fields from leaking through
 *  a spread-based implementation. */
export function listInternalKeyMetadata(): Array<{
  extensionName: string;
  keyId: string;
  scopes: readonly ApiKeyScope[];
  createdAt: number;
}> {
  return Array.from(store.values()).map((e) => ({
    extensionName: e.extensionName,
    keyId: e.keyId,
    scopes: e.scopes,
    createdAt: e.createdAt,
  }));
}
