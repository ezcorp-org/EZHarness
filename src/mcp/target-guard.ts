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
 * ## When this actually runs — precisely
 *
 * Two enforcement points, and the difference matters:
 *
 *   - `McpClient.connect()` calls this once, as a fail-fast. That is once
 *     per CLIENT, not once per use: `connect()` returns early when
 *     `this.connected` is set (only ever cleared by `close()`), and
 *     `ExtensionRegistry.getMcpClient` returns early on `isConnected`. On a
 *     long-lived registry client this is effectively once per process.
 *   - `src/mcp/guarded-fetch.ts` calls it on **every HTTP request** an
 *     `http`/`sse` transport makes, and on every redirect hop. That is the
 *     load-bearing one: it covers `tools/list` and every `tools/call` on an
 *     already-connected client, so a hostname rebound after connect is
 *     refused on the next request.
 *
 * `stdio` has no network target and is a no-op in both.
 *
 * ## Residual: rebinding inside a single request
 *
 * We resolve, then the SDK's socket resolves again — the SDK owns its
 * connection, so we cannot IP-pin the way `guardedFetch` does (and must
 * not: pinning rewrites the URL host, which breaks TLS SNI for a vendor
 * https endpoint). The window is between our `dns.lookup` and that connect,
 * per request. Closing it needs a pinned-dispatcher transport. Re-checking
 * per request — and per redirect hop — is what bounds the exposure today.
 */

import { isIP } from "node:net";
import {
  defaultResolveHost,
  isBlockedIp,
  ipv6ToBytes,
  parseIpv4,
  type ResolveHost,
} from "../search/egress";
import { logger } from "../logger";
import type { McpServerDefinition } from "../extensions/types";

const guardLog = logger.child("mcp-target-guard");

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
  | "private-address"
  /** Too many `Location` hops — see `src/mcp/guarded-fetch.ts`. */
  | "redirect-limit";

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
  /** Human-readable reasons entries were thrown away, each quoting the
   *  offending value. Surfaced by {@link warnAboutAllowlist}. */
  problems: readonly string[];
}

export interface McpTargetGuardDeps {
  /** Injected resolver so tests can drive multi-record and rebinding
   *  cases without touching real DNS. Defaults to the shared
   *  `dns.lookup({all:true})` wrapper. */
  resolveHost?: ResolveHost;
  /** Raw allowlist text. Defaults to `process.env[MCP_TARGET_ALLOW_ENV]`,
   *  read per call so a test (or a reloaded config) is never stale. */
  allowRaw?: string;
  /** Deadline for the DNS lookup, in ms. Default
   *  {@link DEFAULT_RESOLVE_TIMEOUT_MS}. */
  resolveTimeoutMs?: number;
  /** Sink for allowlist complaints. Defaults to the `mcp-target-guard`
   *  logger; tests inject a spy. */
  logger?: AllowlistLogger;
}

/**
 * How long a hostname lookup may take before the target is refused.
 *
 * `dns.lookup` has no timeout of its own — it inherits the resolver's, which
 * against a blackholed nameserver was MEASURED at ~24s for a single lookup.
 * That is an API handler occupied for half a minute, and the same lookup sits
 * on the first tool dispatch inside a chat turn, where the user just sees a
 * stall. `guardedFetch` already sets a deadline before resolving; this is the
 * equivalent for the MCP path.
 *
 * A timeout collapses into `no-address`, which is already an
 * indistinguishable 502, so no response contract moves.
 */
export const DEFAULT_RESOLVE_TIMEOUT_MS = 5_000;

/** Reject with a `no-address` block if `promise` outlives `ms`. */
async function withResolveDeadline<T>(
  promise: Promise<T>,
  ms: number,
  host: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new McpTargetBlockedError("no-address", host)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  // `isIP` accepts a few spellings the byte parsers reject (a scoped
  // `fe80::1%eth0` is `isIP === 6` but has no fixed byte form), so both
  // arms can still yield null. Callers treat null as "not vouched for".
  if (family === 6) return ipv6ToBytes(ip);
  if (family !== 4) return null;
  const octets = parseIpv4(ip);
  return octets ? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...octets] : null;
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

/** A DNS name, as an allowlist entry may spell it. Deliberately narrow:
 *  anything else is a typo we should complain about rather than silently
 *  accept as a host vouch. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Parse `EZCORP_MCP_TARGET_ALLOW` into host and network entries.
 *
 * Entries split on commas, semicolons and/or whitespace. An entry containing
 * `/` is a CIDR; a bare IP literal is a host-length prefix; a bare DNS name
 * is a host vouch.
 *
 * **Every rejection is reported in `problems`, by value.** Silence here was
 * a real operator trap: the four spellings people actually type all failed
 * QUIETLY, and the resulting 502 told them to set the variable they had
 * already set —
 *
 *   - `192.168.1.50:8080`        → became a HOSTNAME vouch that can never
 *                                   match `URL.hostname`, so still denied
 *   - `http://192.168.1.50`      → dropped whole
 *   - `10.0.0.0/8;172.16.0.0/12` → semicolon unsupported, BOTH dropped
 *   - `10.0.0.0 / 8`             → split on the spaces; `/8` silently became
 *                                   `/32` (16.7M addresses narrower) plus a
 *                                   junk `8` host vouch
 *
 * The last two are the dangerous shape: a typo used to land in the `hosts`
 * set, which is the validation-SKIPPING form. Nothing lands there now unless
 * it is a well-formed DNS name.
 */
export function parseMcpTargetAllowlist(raw: string | undefined | null): McpTargetAllowlist {
  const hosts = new Set<string>();
  const nets: AllowNet[] = [];
  const problems: string[] = [];
  const reject = (entry: string, why: string) =>
    problems.push(`ignored ${JSON.stringify(entry)} — ${why}`);

  for (const rawEntry of (raw ?? "").split(/[\s,;]+/)) {
    const entry = rawEntry.trim();
    if (entry === "") continue;

    if (entry.includes("://")) {
      reject(entry, "looks like a URL; use just the host or a CIDR (e.g. 192.168.1.50)");
      continue;
    }

    const slash = entry.lastIndexOf("/");
    const addr = normalizeHost(slash === -1 ? entry : entry.slice(0, slash));
    const family = isIP(addr);

    if (family === 0) {
      if (slash !== -1) {
        reject(entry, "not a CIDR — the part before '/' must be an IP address");
        continue;
      }
      if (addr === "") {
        reject(entry, "empty host");
        continue;
      }
      // `192.168.1.50:8080` used to land here as a host vouch that could
      // never match. Ports are not part of the policy — the guard decides on
      // the address, not the port.
      if (addr.includes(":")) {
        reject(entry, "host:port is not supported — drop the port, or use the bare IP/CIDR");
        continue;
      }
      if (/^\d+$/.test(addr)) {
        // Almost always the tail of a CIDR someone spaced out ("10.0.0.0 / 8").
        reject(entry, "bare number is not a host — did you write a CIDR with spaces around '/'?");
        continue;
      }
      if (!HOSTNAME_RE.test(addr)) {
        reject(entry, "not a valid hostname, IP or CIDR");
        continue;
      }
      hosts.add(addr);
      continue;
    }

    // A bare IP is its own /32 or /128.
    const bits = family === 4 ? 32 : 128;
    const prefixText = slash === -1 ? String(bits) : entry.slice(slash + 1);
    const bytes = toBytes16(addr);
    if (!bytes) {
      reject(entry, "address has no fixed byte form (a scoped IPv6 literal?)");
      continue;
    }
    if (!/^\d{1,3}$/.test(prefixText)) {
      reject(entry, `prefix ${JSON.stringify(prefixText)} is not a number`);
      continue;
    }
    if (Number(prefixText) > bits) {
      reject(entry, `prefix /${prefixText} is out of range for IPv${family} (max /${bits})`);
      continue;
    }
    // An IPv4 entry lives in the v4-mapped block, so its prefix counts from
    // bit 96 rather than bit 0.
    nets.push({ bytes, prefix: family === 4 ? Number(prefixText) + 96 : Number(prefixText) });
  }
  return { hosts, nets, problems };
}

/**
 * Raw allowlist values already reported. The guard reads the env on every
 * call, so without this a malformed entry would warn once per MCP request.
 */
const warnedAllowlists = new Set<string>();

/**
 * Complain — once per distinct raw value — about entries we threw away.
 *
 * This is the whole point of collecting `problems`: a dropped entry is
 * invisible at the API, because a denied target returns the same opaque 502
 * as an unreachable one. The server log is the only place an operator can
 * find out that the variable they set was not understood.
 */
export function warnAboutAllowlist(raw: string | undefined | null, log: AllowlistLogger): void {
  const key = raw ?? "";
  if (warnedAllowlists.has(key)) return;
  warnedAllowlists.add(key);
  const { problems } = parseMcpTargetAllowlist(raw);
  for (const problem of problems) {
    log.warn(`${MCP_TARGET_ALLOW_ENV}: ${problem}`);
  }
}

/** Minimal logger shape, so this module keeps its no-DB/no-SDK footprint. */
export interface AllowlistLogger {
  warn(message: string): void;
}

/** Test seam: forget which raw values have already been reported. */
export function resetAllowlistWarnings(): void {
  warnedAllowlists.clear();
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
  const rawAllow = deps.allowRaw ?? process.env[MCP_TARGET_ALLOW_ENV];
  // Report a mis-typed allowlist BEFORE deciding, so the log line sits next
  // to the denial it explains. De-duplicated per raw value, so this is once
  // per process in practice.
  warnAboutAllowlist(rawAllow, deps.logger ?? guardLog);
  const allow = parseMcpTargetAllowlist(rawAllow);
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

  // Host-string vouch: skips address validation by design (see the module
  // header's warning about the DNS trust this implies).
  if (allow.hosts.has(host)) return;

  // An IP literal is validated AS ITSELF, here — never handed to the
  // resolver. The default resolver happens to short-circuit literals too,
  // but relying on that would put the most direct attack (`http://10.0.0.5`,
  // `http://169.254.169.254`) at the mercy of an injected or future
  // resolver. Classification of a literal must not be delegated.
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await withResolveDeadline(
        resolve(host),
        deps.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS,
        host,
      );
    } catch (e) {
      // Preserve a deadline block verbatim; any resolver failure is also
      // `no-address`, so both collapse to the same uniform 502.
      if (e instanceof McpTargetBlockedError) throw e;
      throw new McpTargetBlockedError("no-address", host);
    }
    if (addresses.length === 0) throw new McpTargetBlockedError("no-address", host);
  }

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
