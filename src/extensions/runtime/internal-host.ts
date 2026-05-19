/**
 * Canonical internal-host classification — shared by the in-sandbox
 * fetch wrapper (`network-wrapper.ts`) and the host-side reverse-RPC
 * handler (`network-handler.ts`).
 *
 * Both sides MUST agree on what "internal" means. Pre-extraction
 * drift: `network-handler.ts:isInternalHost` only lower-cased its
 * input, while `network-wrapper.ts` first stripped the IPv6 `[...]`
 * brackets that `URL.hostname` keeps. Result: `isInternalHost("[::1]")`
 * returned `false` host-side while the wrapper classified the same URL
 * as internal — a wrapper-vs-host disagreement that's exactly the
 * kind of split-brain the validator flagged (M1, reviewer C1).
 *
 * One module, one regex, one normalizer. Both sides import.
 *
 * Pattern matches:
 *   - localhost (literal)
 *   - 127.x.x.x (loopback IPv4 — full /8)
 *   - ::1 (IPv6 loopback)
 *   - 10.x.x.x (RFC-1918 class A)
 *   - 192.168.x.x (RFC-1918 class C)
 *   - 172.16-31.x.x (RFC-1918 class B)
 *   - 169.254.x.x (link-local IPv4)
 *   - fc00:* / fd00:* (unique local IPv6)
 *   - fe80:* (link-local IPv6)
 *
 * Does NOT match (intentionally):
 *   - 8.8.8.8, 1.1.1.1 — public IPs go through the external lane
 *   - mydomain.local (mDNS) — DNS-resolved at fetch time; if it lands
 *     on a private IP, the proxy's per-CONNECT DNS recheck (Phase 55
 *     / MCP-01) governs at the MCP boundary. The TOCTOU window
 *     between lookup and upstream connect is a documented residual
 *     closed by MCP-06 (deferred to v1.5+).
 */

// Phase 54 SEC-05 — anchor `localhost` to end-of-string OR a port-
// separator colon. Pre-fix: `localhost` was an unanchored alternative,
// so attacker-controlled domains like `localhost.evil.com` were
// classified as internal and waved through the internal lane. The
// `(?:$|:)` non-capturing group matches end-of-input OR `:` (port
// separator), so `localhost:8080` continues to match while
// `localhost.evil.com` no longer does. See tasks/v1.3-security-review.md.
export const INTERNAL_HOST_RE =
  /^(localhost(?:$|:)|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fc00:|fd00:|fe80:|::1$)/i;

/**
 * Strip IPv6 URL-syntax brackets from a hostname and lower-case the
 * rest. `URL.hostname` keeps the `[...]` for IPv6 hosts; both the
 * regex AND the allowlist comparison expect the bare form, so every
 * caller normalizes input here before comparing.
 */
export function normalizeHostname(raw: string): string {
  let h = raw.toLowerCase();
  if (h.length >= 2 && h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
  }
  return h;
}

/**
 * `true` iff `hostname` is a localhost / RFC-1918 / link-local /
 * unique-local address. Strips IPv6 brackets so callers can pass the
 * raw `URL.hostname` value directly.
 */
export function isInternalHost(hostname: string): boolean {
  return INTERNAL_HOST_RE.test(normalizeHostname(hostname));
}
