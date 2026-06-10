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
 *   - 0.x.x.x (0.0.0.0/8 "this network" — `0.0.0.0` reaches loopback
 *     services on Linux, so it MUST be classified internal)
 *   - ::1 (IPv6 loopback)
 *   - 10.x.x.x (RFC-1918 class A)
 *   - 192.168.x.x (RFC-1918 class C)
 *   - 172.16-31.x.x (RFC-1918 class B)
 *   - 100.64-127.x.x (CGNAT / RFC-6598 shared address space)
 *   - 169.254.x.x (link-local IPv4)
 *   - fc00:* / fd00:* (unique local IPv6)
 *   - fe80:* (link-local IPv6)
 *   - ::ffff:<v4> (IPv4-mapped IPv6 — decoded to its embedded IPv4 and
 *     re-tested, so `::ffff:127.0.0.1` can't smuggle loopback past the
 *     IPv4 patterns; see `isInternalHost`)
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
  /^(localhost(?:$|:)|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|fc00:|fd00:|fe80:|::1$)/i;

/**
 * Decode an IPv4-mapped IPv6 address (`::ffff:<v4>`) to its embedded
 * IPv4 dotted form, or `null` if `h` isn't a mapped address. Handles
 * both the dotted tail (`::ffff:127.0.0.1`) and the hex tail
 * (`::ffff:7f00:1`) — `URL.hostname` normalizes the former to the
 * latter, so both must be covered. `h` is expected pre-normalized
 * (lower-cased, brackets stripped).
 */
function ipv4FromMapped(h: string): string | null {
  const m = h.match(/^::ffff:(.+)$/);
  if (!m) return null;
  const rest = m[1]!;
  // Dotted tail: already an IPv4 literal.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rest)) return rest;
  // Hex tail: two 16-bit groups → four octets.
  const groups = rest.split(":");
  if (groups.length === 2) {
    const hi = parseInt(groups[0]!, 16);
    const lo = parseInt(groups[1]!, 16);
    if (!Number.isFinite(hi) || !Number.isFinite(lo) || Number.isNaN(hi) || Number.isNaN(lo)) return null;
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

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
  const h = normalizeHostname(hostname);
  if (INTERNAL_HOST_RE.test(h)) return true;
  // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) bypasses the IPv4 patterns
  // unless we decode the embedded v4 and re-test it.
  const mapped = ipv4FromMapped(h);
  return mapped !== null && INTERNAL_HOST_RE.test(mapped);
}
