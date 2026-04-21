/**
 * Deterministic system-user provisioning for bundled-extension principals.
 *
 * Why
 * ---
 * Conversations (and other core tables) carry a FK `user_id → users.id`.
 * When an extension subprocess calls back into EZCorp via its internal
 * API key, the resulting request must resolve to a real row in the users
 * table — otherwise the FK fires and handlers crash with 500.
 *
 * This module owns a narrow helper that ensures one row per allowlisted
 * extension exists at boot, with strong security controls:
 *
 *   1. Deterministic id (`sys-<extensionName>`). Makes audit logs
 *      self-describing: any row whose `user_id` starts with `sys-` is
 *      machine-originated, not human.
 *   2. role = "member". NEVER admin. An attacker who somehow forged a
 *      loopback request with a valid internal key still can't escalate
 *      — they run under a plain member identity and inherit the
 *      minimum-necessary API scopes declared in bundled-creds.ts.
 *   3. Password is a SHA-256 of `crypto.randomBytes(64)`, hashed with
 *      Bun.password. The plaintext is discarded immediately; nothing on
 *      this machine or anywhere else ever sees it again. Login via
 *      password is thus cryptographically impossible for the lifetime of
 *      this row.
 *   4. status = "active" so the user row doesn't get excluded from any
 *      user-existence checks, but it also doesn't appear in any UI user
 *      listings (the UI filters by `role !== "system"` or similar when
 *      we ship that — tracked in a follow-up).
 *   5. Email is `@sys.ezcorp.invalid` — the `.invalid` TLD is reserved
 *      by RFC 2606 as explicitly non-routable, so no one can hijack the
 *      address externally. Unique-constrained, so a duplicate seed is a
 *      no-op.
 *   6. Idempotent: on every boot we look up the row by deterministic id
 *      first. We never re-hash the password or overwrite the row.
 *      Stable across restarts without piling up duplicates.
 */

import crypto from "node:crypto";
import { getUserById, createUser } from "$server/db/queries/users";
import { hashPassword } from "$server/auth/password";

/** Deterministic user-row id for the named extension. Text PK on users
 *  table means any stable string works; we use `sys-<name>` for audit
 *  visibility (grep-friendly, impossible to confuse with a UUID). */
export function systemUserIdFor(extensionName: string): string {
  // Reject anything that isn't lowercase alphanum + internal dashes.
  // Must start AND end with alphanum — forbids leading/trailing dashes
  // that would produce ugly ids like `sys-ends-with-dash-` in logs, and
  // refuses shell/path-metacharacter-like characters outright. Length
  // cap 63 keeps the final `sys-<name>` fits in 67 chars (plenty of
  // headroom for any DB id column, log-line formatters, and URL paths).
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(extensionName) ||
    extensionName.length > 63
  ) {
    throw new Error(
      `systemUserIdFor: invalid extensionName ${JSON.stringify(extensionName)} — must be lowercase kebab`,
    );
  }
  return `sys-${extensionName}`;
}

/** Email for the system user. Uses `.invalid` TLD (RFC 2606) so the
 *  address can never resolve to a real mailbox — prevents any downstream
 *  "forgot password" or invite flow from accidentally emailing a real
 *  person. */
function systemUserEmail(extensionName: string): string {
  return `${extensionName}@sys.ezcorp.invalid`;
}

/** Ensure the system user row exists for the named extension. Returns
 *  the user row's id. Idempotent: on any subsequent call, the existing
 *  row is returned without touching the password or email. */
export async function ensureSystemUser(
  extensionName: string,
  displayName?: string,
): Promise<string> {
  const id = systemUserIdFor(extensionName);
  const existing = await getUserById(id);
  if (existing) return existing.id;

  // First-boot seed. Generate 64 bytes of random, hash it, discard the
  // plaintext. Nothing in this code path retains or logs the plaintext.
  const plaintext = crypto.randomBytes(64).toString("base64url");
  const passwordHash = await hashPassword(plaintext);
  await createUser({
    id,
    email: systemUserEmail(extensionName),
    passwordHash,
    name: displayName ?? `System: ${extensionName}`,
    role: "member",
    status: "active",
  });
  return id;
}
