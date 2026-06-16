/**
 * SSRF-guarded outbound fetch for the shared search host module.
 *
 * `read-url` and the search backends fetch user/agent-controllable URLs
 * HOST-side — outside the extension sandbox's `EZCORP_PERMITTED_HOSTS`
 * enforcement. That is a classic SSRF surface, so EVERY host-side search
 * fetch routes through `guardedFetch`.
 *
 * Two modes:
 *
 *   - `mode: "read"` (the `read-url` reader): the URL is fully
 *     attacker-controlled. Resolve the hostname to IP(s); REJECT if ANY
 *     resolved IP is loopback / private (RFC-1918) / link-local /
 *     unique-local / the cloud metadata address / 0.0.0.0 / unspecified.
 *     Then connect to the VALIDATED IP (pin it) and re-validate after
 *     every redirect — this defeats both DNS-rebinding (hostname resolves
 *     public on the first lookup, private on the connect) and
 *     redirect-to-internal. Cap redirects (≤3), body size, and timeout.
 *     Block non-http(s) schemes.
 *
 *   - `mode: "backend"` (the search backends → SearXNG / DDG / BYOK): the
 *     target host is NOT attacker-controlled — it comes from the
 *     configured provider chain. Allowlist to the configured backend
 *     hosts only. The configured SearXNG instance is the ONE sanctioned
 *     internal target: an internal-host SearXNG URL is allowed *by exact
 *     configured host*, but is STILL IP-pinned (so a hostile DNS answer
 *     for `searxng` can't redirect the fetch elsewhere — the allow is on
 *     the host string, the connection is on the validated IP).
 *
 * Every block emits an audit signal via the injected `onBlocked`
 * callback (the handler wires `insertAuditEntry(... SDK_SEARCH_EGRESS_BLOCKED)`;
 * pure unit tests pass a spy). This module imports NO DB / SDK code so
 * its tests run over a mocked transport with zero live network and zero
 * PGlite.
 *
 * IP resolution uses `node:dns/promises` (vitest-bundleable — see the
 * landmine note in tasks/shared-search-capability.md §7) rather than a
 * bun builtin.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

// ── Configuration / injection seams ─────────────────────────────────

export type EgressMode = "read" | "backend";

/** Reason a fetch was blocked — drives the audit metadata + the thrown
 *  error message. */
export type EgressBlockReason =
  | "scheme"
  | "private-ip"
  | "host-not-allowed"
  | "redirect-limit"
  | "body-too-large"
  | "timeout"
  | "no-address";

export class EgressBlockedError extends Error {
  readonly code = "EGRESS_BLOCKED";
  readonly reason: EgressBlockReason;
  /** The blocked target (URL or `host → ip`) for the audit row. */
  readonly target: string;
  constructor(reason: EgressBlockReason, target: string, message?: string) {
    super(message ?? `Egress blocked (${reason}): ${target}`);
    this.name = "EgressBlockedError";
    this.reason = reason;
    this.target = target;
  }
}

/** Signature of the low-level transport. Injected so tests can drive
 *  redirects / bodies without a live network. Defaults to global
 *  `fetch`. The guard always calls this with `redirect: "manual"`. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Signature of the DNS resolver. Injected so tests can simulate
 *  DNS-rebinding (different answer per call). Returns the list of
 *  resolved IP literals for a hostname. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

/** Fired (best-effort) on every block with the structured reason +
 *  target. The handler wires the audit write; unit tests pass a spy. */
export type OnBlocked = (info: {
  reason: EgressBlockReason;
  target: string;
  mode: EgressMode;
}) => void;

export interface GuardedFetchOptions {
  mode: EgressMode;
  /** For `mode:"backend"`: the exact set of hostnames the configured
   *  provider chain may reach (SearXNG URL host ∪ DDG hosts ∪ selected
   *  BYOK provider host). Case-insensitive exact match. Ignored in
   *  `mode:"read"`. */
  allowedHosts?: readonly string[];
  /** Max redirects to follow before blocking. Default 3. */
  maxRedirects?: number;
  /** Max response body size in bytes. Default 5 MiB. */
  maxBodyBytes?: number;
  /** Overall timeout in ms. Default 15_000. */
  timeoutMs?: number;
  /** Injected transport (defaults to global fetch). */
  fetchImpl?: FetchLike;
  /** Injected DNS resolver (defaults to node:dns/promises lookup). */
  resolveHost?: ResolveHost;
  /** Block audit hook. */
  onBlocked?: OnBlocked;
}

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

// ── IP classification ───────────────────────────────────────────────

/** Parse a dotted-quad IPv4 into its four octets, or null if malformed. */
function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return octets as [number, number, number, number];
}

/**
 * Is this IP literal one we must NEVER connect to from the host? Covers
 * loopback, RFC-1918 private ranges, link-local (incl. the cloud
 * metadata address 169.254.169.254), unspecified (0.0.0.0 / ::),
 * carrier-grade NAT, and IPv6 loopback / unique-local (fc00::/7, which
 * includes the `fd00:ec2::254` metadata address) / link-local /
 * IPv4-mapped private.
 */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedIpv4(ip);
  if (v === 6) return isBlockedIpv6(ip);
  // Not a parseable IP literal — fail closed.
  return true;
}

function isBlockedIpv4(ip: string): boolean {
  const o = parseIpv4(ip);
  if (!o) return true;
  const [a, b] = o;
  // 0.0.0.0/8 — "this network" / unspecified.
  if (a === 0) return true;
  // 10.0.0.0/8 — private.
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback.
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (incl. 169.254.169.254 metadata).
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — private.
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private.
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 — carrier-grade NAT (RFC 6598).
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // ::1 loopback, :: unspecified.
  const collapsed = lower.replace(/(^|:)0+(?=[0-9a-f])/g, "$1");
  if (lower === "::1" || lower === "::" || collapsed === "::1") return true;
  // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded v4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]!);
  // fc00::/7 — unique-local (fc.. / fd..). Includes fd00:ec2::254
  // (the AWS IPv6 metadata address).
  const head = lower.split(":")[0] ?? "";
  if (/^f[cd][0-9a-f]{0,2}$/.test(head)) return true;
  // fe80::/10 — link-local.
  if (/^fe[89ab][0-9a-f]?$/.test(head)) return true;
  return false;
}

// ── DNS resolution + pinning ────────────────────────────────────────

export const defaultResolveHost: ResolveHost = async (hostname) => {
  // If the host is already an IP literal, return it verbatim (no lookup).
  if (isIP(hostname) !== 0) return [hostname];
  const records = await dnsLookup(hostname, { all: true });
  return records.map((r) => r.address);
};

/**
 * Resolve `hostname` to IPs and ensure ALL of them are public. Returns
 * the first validated IP to pin the connection to. Throws
 * `EgressBlockedError` (reason `private-ip` or `no-address`) otherwise.
 *
 * We require EVERY resolved address to be public (not just the one we
 * pin) so a hostname that resolves to a mix of public + private can't be
 * used to smuggle an internal target through round-robin DNS.
 */
async function resolveAndValidate(
  hostname: string,
  resolve: ResolveHost,
): Promise<string> {
  let ips: string[];
  try {
    ips = await resolve(hostname);
  } catch {
    throw new EgressBlockedError("no-address", hostname, `DNS resolution failed for ${hostname}`);
  }
  if (ips.length === 0) {
    throw new EgressBlockedError("no-address", hostname, `No address for ${hostname}`);
  }
  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      throw new EgressBlockedError("private-ip", `${hostname} → ${ip}`);
    }
  }
  return ips[0]!;
}

// ── Main guarded fetch ──────────────────────────────────────────────

function normalizeHost(h: string): string {
  return h.toLowerCase().replace(/^\[|\]$/g, "");
}

/**
 * SSRF-guarded fetch. Resolves + validates the host, pins the connection
 * to the validated IP, follows redirects manually (re-validating each
 * hop), and caps redirects / body / time. Returns a `Response` whose
 * body has already been validated to be within `maxBodyBytes`.
 */
export async function guardedFetch(
  rawUrl: string,
  init: RequestInit,
  opts: GuardedFetchOptions,
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const resolve = opts.resolveHost ?? defaultResolveHost;
  const allowed = new Set((opts.allowedHosts ?? []).map(normalizeHost));

  const block = (reason: EgressBlockReason, target: string, message?: string): never => {
    opts.onBlocked?.({ reason, target, mode: opts.mode });
    throw new EgressBlockedError(reason, target, message);
  };

  const deadline = Date.now() + timeoutMs;
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return block("scheme", currentUrl, `Malformed URL: ${currentUrl}`);
    }

    // Scheme gate — only http(s). Blocks file:, data:, gopher:, ftp:, …
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return block("scheme", currentUrl, `Blocked scheme: ${parsed.protocol}`);
    }

    const host = normalizeHost(parsed.hostname);

    // `mode:"backend"` — allowlist the host. The configured SearXNG
    // internal host is sanctioned here (it's in `allowedHosts`), but the
    // connection below is still IP-pinned.
    if (opts.mode === "backend" && !allowed.has(host)) {
      return block("host-not-allowed", currentUrl, `Backend host not allowed: ${host}`);
    }

    // Resolve + validate, then pin the connection to the validated IP.
    // In `mode:"read"` this rejects any private/internal IP. In
    // `mode:"backend"` it ALSO IP-pins the sanctioned SearXNG host: the
    // allowlist authorized the host string, but a DNS answer that
    // resolves to an unexpected internal address is still rejected
    // UNLESS the configured host is itself an internal sidecar. For the
    // sanctioned-internal case the caller passes the SearXNG host in
    // `allowedHosts` AND we skip the private-IP rejection for backend
    // mode (the host string is the trust anchor); we still PIN so the
    // fetch can't be rebound away from the resolved address mid-flight.
    let pinnedIp: string;
    if (opts.mode === "read") {
      try {
        pinnedIp = await resolveAndValidate(host, resolve);
      } catch (err) {
        if (err instanceof EgressBlockedError) {
          return block(err.reason, err.target, err.message);
        }
        throw err;
      }
    } else {
      // backend: resolve (for pinning) but don't reject internal IPs —
      // the host allowlist is the security boundary here.
      let ips: string[];
      try {
        ips = await resolve(host);
      } catch {
        return block("no-address", host, `DNS resolution failed for ${host}`);
      }
      if (ips.length === 0) return block("no-address", host, `No address for ${host}`);
      pinnedIp = ips[0]!;
    }

    if (Date.now() >= deadline) {
      return block("timeout", currentUrl, `Egress timed out before connect`);
    }

    // Pin: connect to the validated IP, preserve the Host header so TLS
    // SNI + virtual hosting still work. Bracket IPv6 literals.
    const ipLiteral = isIP(pinnedIp) === 6 ? `[${pinnedIp}]` : pinnedIp;
    const pinnedUrl = new URL(parsed.toString());
    pinnedUrl.hostname = ipLiteral;
    const headers = new Headers(init.headers ?? {});
    headers.set("host", parsed.host);

    const controller = new AbortController();
    const remaining = deadline - Date.now();
    const timer = setTimeout(() => controller.abort(), Math.max(0, remaining));
    let res: Response;
    try {
      res = await fetchImpl(pinnedUrl.toString(), {
        ...init,
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        return block("timeout", currentUrl, `Egress timed out`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // Redirect? Re-validate the next hop (defeats redirect-to-internal).
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      if (hop >= maxRedirects) {
        return block("redirect-limit", currentUrl, `Redirect limit (${maxRedirects}) exceeded`);
      }
      const location = res.headers.get("location")!;
      currentUrl = new URL(location, currentUrl).toString();
      // Drain the redirect body so the transport can be reused.
      try {
        await res.arrayBuffer();
      } catch {
        /* best-effort */
      }
      continue;
    }

    // Terminal response — enforce body-size cap.
    return await enforceBodyCap(res, maxBodyBytes, () =>
      block("body-too-large", currentUrl, `Response body exceeds ${maxBodyBytes} bytes`),
    );
  }

  // Unreachable: the loop either returns or blocks on redirect-limit.
  return block("redirect-limit", currentUrl, `Redirect limit (${maxRedirects}) exceeded`);
}

/**
 * Read the body with a hard byte cap. Prefers a streaming read (so a
 * huge body is aborted early); falls back to a buffered read +
 * length-check when the body isn't a readable stream (e.g. a mocked
 * Response in tests). Returns a fresh `Response` carrying the validated
 * bytes + original status/headers.
 */
async function enforceBodyCap(
  res: Response,
  maxBytes: number,
  onTooLarge: () => never,
): Promise<Response> {
  // Fast reject via Content-Length when present + trustworthy.
  const cl = res.headers.get("content-length");
  if (cl !== null) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) onTooLarge();
  }

  const body = res.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          onTooLarge();
        }
        chunks.push(value);
      }
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    return new Response(merged, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  // No streamable body (mocked Response) — buffer + check.
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) onTooLarge();
  return new Response(buf, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
