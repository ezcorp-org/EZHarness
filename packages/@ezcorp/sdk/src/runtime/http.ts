// ── fetchPermitted — hostname-allowlisted fetch ─────────────────
//
// Wraps global `fetch` with a pre-network hostname check against the
// comma-separated allowlist published by the host in
// `EZCORP_PERMITTED_HOSTS`. The host populates this env only when the
// extension's manifest declares `permissions.network` AND the user has
// granted that permission at install time (see
// src/extensions/registry.ts buildAllowedEnv).
//
// If the env is unset or empty, ALL fetches are rejected — a granted
// extension that accidentally runs outside the host sandbox should fail
// closed, not silently open.

function readAllowlist(): string[] {
  const raw = process.env.EZCORP_PERMITTED_HOSTS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Perform a fetch, but first verify the target hostname is present in
 * the extension's granted network allowlist.
 *
 * Throws when:
 *   - `EZCORP_PERMITTED_HOSTS` is unset or empty (extension has no
 *     granted network permission).
 *   - The URL's hostname is not a member of the allowlist.
 */
export async function fetchPermitted(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const allowlist = readAllowlist();
  if (allowlist.length === 0) {
    throw new Error(
      "[@ezcorp/sdk] fetchPermitted: EZCORP_PERMITTED_HOSTS not configured — extension lacks granted network permission",
    );
  }
  const target = typeof url === "string" ? new URL(url) : url;
  const hostname = target.hostname.toLowerCase();
  if (!allowlist.includes(hostname)) {
    throw new Error(
      `[@ezcorp/sdk] fetchPermitted: hostname '${hostname}' is not in EZCORP_PERMITTED_HOSTS allowlist (granted: ${allowlist.join(", ")})`,
    );
  }
  return fetch(url, init);
}
