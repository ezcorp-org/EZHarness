/**
 * Thin Bun.dns.lookup wrapper — exists as a mock-able seam.
 *
 * Why a wrapper, not a direct `Bun.dns.lookup` call from `mcp-proxy.ts`?
 *
 *   1. Tests can replace this module with `mock.module(...)` to drive
 *      deterministic A/AAAA results into the proxy without standing up
 *      a real DNS resolver — mirrors the `internal-host.ts` mocking
 *      posture in `mcp-proxy.test.ts:53-61`.
 *
 *   2. Single chokepoint for the future MCP-06 TOCTOU close (deferred
 *      to v1.5+). When `Bun.connect({hostname, servername})` lands the
 *      ability to pin the upstream IP, the pin will happen here — the
 *      caller in `mcp-proxy.ts` will hand the resolved IP back into
 *      `Bun.connect` instead of letting it re-resolve.
 *
 * The wrapper deliberately does NOT consult any env var (e.g. the
 * `EZCORP_MCP_STAGE1_DNS_RECHECK` kill-switch). That gate lives in
 * `mcp-proxy.ts` so this module stays a pure side-effect-free seam
 * matching `internal-host.ts`'s posture.
 *
 * Tied to:
 *   - `mcp-proxy.ts`           — calls `lookup()` on every CONNECT
 *                                against the validated hostname.
 *   - `mcp-proxy.test.ts`      — `mock.module("../extensions/runtime/dns",
 *                                 () => ({ lookup: ... }))` replaces this
 *                                 module with a deterministic stub.
 */

/**
 * Re-export the Bun A/AAAA result shape so callers don't have to reach
 * into the Bun namespace. Mirrors `Bun.dns.DNSLookup`.
 */
export interface DnsLookupRecord {
  address: string;
  family: 4 | 6;
  ttl: number;
}

/**
 * Resolve `hostname` to its A/AAAA records via `Bun.dns.lookup`. The
 * default `family: 0` ("any") returns both A and AAAA records, which
 * is what the MCP-01 rebind check wants — every returned record gets
 * re-checked against `isInternalHost`.
 */
export async function lookup(
  hostname: string,
  opts: { family?: 4 | 6 | 0 } = {},
): Promise<DnsLookupRecord[]> {
  const family = opts.family ?? 0;
  return Bun.dns.lookup(hostname, { family });
}
