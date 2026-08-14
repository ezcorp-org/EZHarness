/**
 * SSRF guard for the platform's OWN outbound MCP connections.
 *
 * `POST /api/mcp-servers`, `PUT /api/mcp-servers/[id]` and every runtime
 * connect (`ExtensionRegistry.getMcpClient` → refresh / reload / tool
 * dispatch) open an `McpClient` against a caller-supplied server config.
 * For the `http` and `sse` transports that config carries a URL, and the
 * server dials it. Without this module an admin-scoped caller could point
 * the platform at `http://169.254.169.254/latest/meta-data/` (cloud
 * credentials) or at `http://10.0.0.5:6379` (any internal service), and
 * the connection was made with no target validation at all.
 *
 * ## Where this sits relative to the stdio sandbox
 *
 * These are two DIFFERENT egress directions and they get different
 * policies on purpose:
 *
 *   - `mcp-proxy.ts` governs an MCP *server's own* outbound traffic — an
 *     arbitrary third-party binary reaching out through the per-MCP
 *     forward proxy. Internal hosts are a HARD deny there, regardless of
 *     grant, because nothing the binary asks for is trusted.
 *   - This module governs the platform reaching *in* to an
 *     admin-configured MCP endpoint. The target IS operator intent, and
 *     EZCorp is self-hosted — an MCP server on `127.0.0.1:3000` or on the
 *     LAN is a first-class deployment. So the default posture is deny,
 *     with an explicit env escape hatch (below).
 *
 * `stdio` targets are exempt: they spawn a process, they never dial a
 * network address, and their egress is already governed by the sandbox
 * envelope (netns / forward proxy / seccomp). This module returns
 * immediately for them.
 *
 * ## Policy
 *
 * For `http` / `sse`:
 *   1. The URL must parse and must be `http:` or `https:`.
 *   2. The hostname is resolved to EVERY address (`dns.lookup({all:true})`;
 *      an IP literal validates as itself).
 *   3. If ANY resolved address is loopback / RFC-1918 / link-local
 *      (169.254.0.0/16, the cloud metadata address) / CGNAT / unspecified
 *      / broadcast, or their IPv6 equivalents (`::1`, `fc00::/7`,
 *      `fe80::/10`, and every v4-in-v6 transition encoding), the connect
 *      is refused. ALL addresses must clear — a hostname with a mixed
 *      public/private A-record set is denied, so round-robin DNS can't
 *      smuggle an internal target past a lucky first answer.
 *
 * The classification itself is NOT re-implemented here: `isBlockedIp`
 * (and the `parseIpv4` / `ipv6ToBytes` primitives) come from
 * `src/search/egress.ts`, which already owns the repo's address
 * block-list for host-side `read-url` fetches. One block-list, two
 * callers — a second copy would drift.
 *
 * ## Escape hatch — `EZCORP_MCP_TARGET_ALLOW`
 *
 * A comma/whitespace-separated list of hosts and/or CIDRs, e.g.
 *
 *     EZCORP_MCP_TARGET_ALLOW=127.0.0.1,::1,192.168.1.50,10.0.0.0/8,mcp.lan
 *
 * An allowlist rather than a single `allow private` boolean, because a
 * boolean is all-or-nothing: an operator who just wants their LAN MCP box
 * at `192.168.1.50` would have to re-open `169.254.169.254` — the single
 * highest-value SSRF target on a cloud host — to get it. The list is
 * least-privilege and composes.
 *
 * Two entry kinds, and they are NOT equivalent:
 *   - **IP or CIDR** — matched against each RESOLVED address. This is the
 *     safe form: DNS cannot move the target out from under it.
 *   - **Hostname** — matched against the URL's host, and it SKIPS address
 *     validation entirely. It means "I vouch for this name, wherever it
 *     resolves", so an attacker who controls DNS for that name controls
 *     the target. Prefer the IP/CIDR form; use a hostname only for a name
 *     you own (`localhost`, an internal service name).
 *
 * Malformed entries are dropped, which can only make the guard STRICTER.
 *
 * ## Re-checked on every connect
 *
 * The guard runs inside `McpClient.connect()`, not at the route. So the
 * install-time check is not a one-off: a target that resolves public at
 * install and private later (DNS rebinding) is re-validated and refused
 * on the next connect. There is still a sub-second TOCTOU window between
 * our `dns.lookup` and the SDK transport's own connect — the SDK owns its
 * socket, so we cannot IP-pin the way `guardedFetch` does. Closing that
 * needs a pinned-dispatcher transport; the re-check per connect is what
 * bounds the exposure today.
 */

import { isIP } from "node:net";
import {
  defaultResolveHost,
  isBlockedIp,
  ipv6ToBytes,
  parseIpv4,
  type ResolveHost,
} from "../search/egress";
import type { McpServerDefinition } from "../extensions/types";

/** Env var holding the operator's allowlist. */
export const MCP_TARGET_ALLOW_ENV = "EZCORP_MCP_TARGET_ALLOW";

/** Stand-in for a URL we could not parse — see `McpTargetBlockedError.target`. */
export const UNPARSEABLE_TARGET = "<unparseable>";

/** Why a target was refused. Server-side diagnostics only — this NEVER
 *  reaches an API response body (see `src/mcp/connect-failure.ts`). */
export type McpTargetBlockReason =
  | "malformed-url"
  | "scheme"
  | "no-address"
  | "private-address";

export class McpTargetBlockedError extends Error {
  readonly code = "MCP_TARGET_BLOCKED";
  readonly reason: McpTargetBlockReason;
  /**
   * The refused target (`scheme`, `host`, or `host → ip`) for the log.
   *
   * NEVER the raw URL: an MCP URL may carry `user:password@` userinfo, and
   * this string reaches the server log and the admin error-log surface. The
   * unparseable case reports a placeholder rather than echoing the input.
   */
  readonly target: string;
  constructor(reason: McpTargetBlockReason, target: string) {
    super(`MCP target blocked (${reason}): ${target}`);
    this.name = "McpTargetBlockedError";
    this.reason = reason;
    this.target = target;
  }
}

/** One parsed CIDR (or bare IP, as a full-length prefix), normalized to
 *  the 16-byte IPv6 space so v4 and v6 entries match uniformly. An IPv4
 *  entry becomes its v4-mapped form with the prefix shifted by 96, which
 *  also makes `10.0.0.0/8` cover a literal `::ffff:10.0.0.5` target. */
interface AllowNet {
  bytes: readonly number[];
  prefix: number;
}

export interface McpTargetAllowlist {
  /** Vouched-for host strings (lowercased, brackets + trailing dot stripped). */
  hosts: ReadonlySet<string>;
  /** Vouched-for address ranges. */
  nets: readonly AllowNet[];
}

export interface McpTargetGuardDeps {
  /** Injected resolver so tests can drive multi-record and rebinding
   *  cases without touching real DNS. Defaults to the shared
   *  `dns.lookup({all:true})` wrapper. */
  resolveHost?: ResolveHost;
  /** Raw allowlist text. Defaults to `process.env[MCP_TARGET_ALLOW_ENV]`,
   *  read per call so a test (or a reloaded config) is never stale. */
  allowRaw?: string;
}

/** Lowercase, strip IPv6 URL brackets, strip a trailing root dot.
 *  `URL.hostname` keeps `[...]` for IPv6, and `example.com.` is the same
 *  DNS name as `example.com` — normalizing both ends keeps an allowlist
 *  entry matching the target an operator actually typed. */
function normalizeHost(raw: string): string {
  let h = raw.toLowerCase();
  if (h.length >= 2 && h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.length > 1 && h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** An IP literal as its 16 bytes in IPv6 space (IPv4 → v4-mapped), or
 *  null when it isn't a parseable literal. */
function toBytes16(ip: string): number[] | null {
  const family = isIP(ip);
  if (family === 4) {
    const octets = parseIpv4(ip);
    if (!octets) return null;
    return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...octets];
  }
  if (family === 6) return ipv6ToBytes(ip);
  return null;
}

/** Does `net` contain `bytes` (both already in 16-byte IPv6 space)? */
function netContains(net: AllowNet, bytes: readonly number[]): boolean {
  let remaining = net.prefix;
  for (let i = 0; i < 16 && remaining > 0; i++) {
    const take = remaining >= 8 ? 8 : remaining;
    const mask = (0xff << (8 - take)) & 0xff;
    if (((net.bytes[i]! ^ bytes[i]!) & mask) !== 0) return false;
    remaining -= take;
  }
  return true;
}

/**
 * Parse `EZCORP_MCP_TARGET_ALLOW` into host and network entries.
 *
 * Entries split on commas and/or whitespace. An entry containing `/` is a
 * CIDR; a bare IP literal is a host-length prefix; anything else is a
 * hostname. Anything unparseable (bad prefix length, bad address, empty)
 * is DROPPED — a dropped entry can only deny more, never allow more.
 */
export function parseMcpTargetAllowlist(raw: string | undefined | null): McpTargetAllowlist {
  const hosts = new Set<string>();
  const nets: AllowNet[] = [];
  for (const rawEntry of (raw ?? "").split(/[\s,]+/)) {
    const entry = rawEntry.trim();
    if (entry === "") continue;

    const slash = entry.lastIndexOf("/");
    if (slash !== -1) {
      const addr = normalizeHost(entry.slice(0, slash));
      const prefixText = entry.slice(slash + 1);
      const family = isIP(addr);
      if (family === 0) continue;
      if (!/^\d{1,3}$/.test(prefixText)) continue;
      const declared = Number(prefixText);
      if (declared > (family === 4 ? 32 : 128)) continue;
      const bytes = toBytes16(addr);
      if (!bytes) continue;
      // An IPv4 entry lives in the v4-mapped block, so its prefix counts
      // from bit 96 rather than bit 0.
      nets.push({ bytes, prefix: family === 4 ? declared + 96 : declared });
      continue;
    }

    const normalized = normalizeHost(entry);
    if (normalized === "") continue;
    if (isIP(normalized) !== 0) {
      const bytes = toBytes16(normalized);
      if (!bytes) continue;
      nets.push({ bytes, prefix: 128 });
      continue;
    }
    hosts.add(normalized);
  }
  return { hosts, nets };
}

/** Is this otherwise-blocked address explicitly vouched for by a CIDR or
 *  IP entry? */
function allowlistCoversAddress(allow: McpTargetAllowlist, address: string): boolean {
  const bytes = toBytes16(address);
  if (!bytes) return false;
  return allow.nets.some((net) => netContains(net, bytes));
}

/**
 * Throw `McpTargetBlockedError` unless `rawUrl` is a safe outbound MCP
 * target. Resolves the hostname and requires EVERY answer to be either
 * public or allowlisted.
 */
export async function assertMcpTargetUrlAllowed(
  rawUrl: string,
  deps: McpTargetGuardDeps = {},
): Promise<void> {
  const allow = parseMcpTargetAllowlist(deps.allowRaw ?? process.env[MCP_TARGET_ALLOW_ENV]);
  const resolve = deps.resolveHost ?? defaultResolveHost;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Placeholder, not `rawUrl` — see McpTargetBlockedError.target.
    throw new McpTargetBlockedError("malformed-url", UNPARSEABLE_TARGET);
  }

  // Only http(s) reaches an MCP transport. Blocks file:, gopher:, ftp:, …
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new McpTargetBlockedError("scheme", parsed.protocol);
  }

  const host = normalizeHost(parsed.hostname);
  if (host === "") throw new McpTargetBlockedError("malformed-url", UNPARSEABLE_TARGET);

  // Host-string vouch: skips address validation by design (see the module
  // header's warning about the DNS trust this implies).
  if (allow.hosts.has(host)) return;

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new McpTargetBlockedError("no-address", host);
  }
  if (addresses.length === 0) throw new McpTargetBlockedError("no-address", host);

  for (const address of addresses) {
    // `isBlockedIp` fails CLOSED: anything it can't parse as a literal is
    // treated as blocked.
    if (!isBlockedIp(address)) continue;
    if (allowlistCoversAddress(allow, address)) continue;
    throw new McpTargetBlockedError("private-address", `${host} → ${address}`);
  }
}

/**
 * Guard entry point for a whole MCP server spec. `stdio` is a no-op (no
 * network target); `http` / `sse` are validated.
 */
export async function assertMcpTargetAllowed(
  spec: McpServerDefinition,
  deps: McpTargetGuardDeps = {},
): Promise<void> {
  if (spec.transport === "stdio") return;
  await assertMcpTargetUrlAllowed(spec.url, deps);
}
