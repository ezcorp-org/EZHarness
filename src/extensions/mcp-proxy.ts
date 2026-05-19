/**
 * Per-MCP forward proxy — the Phase 7 outbound gate for stdio MCP
 * servers. Listens on a per-extension localhost port (random, OS-
 * assigned). Speaks HTTP/1.1 CONNECT only — every legitimate stdlib
 * HTTP client (curl, requests, Go net/http, Node http) does CONNECT-
 * then-tunnel for HTTPS through the `HTTPS_PROXY` env var.
 *
 * What it enforces:
 *   1. Constant-time bearer-token auth on every CONNECT. The token is
 *      minted at proxy start and embedded in the `HTTPS_PROXY` URL the
 *      MCP receives via env. `crypto.timingSafeEqual` closes the
 *      reviewer-flagged timing oracle (Phase 7 fix-pass C1).
 *   2. Per-host PDP gate. Calls `engine.authorize(...)` with a
 *      `network` capability for the target hostname; deny → 403 +
 *      audit. Allow → continue to the upstream tunnel.
 *   3. Internal-host hard deny. localhost / RFC-1918 / link-local
 *      hostnames are refused outright at the proxy with a 403 +
 *      `MCP_HOST_BLOCKED reason: "internal"`. SSRF gating no longer
 *      depends on the manifest including / excluding internal hosts in
 *      its grant — they're always denied (Phase 7 fix-pass S6).
 *   4. Per-extension byte + connection quotas via `rate-limit.ts`'s
 *      token bucket. 100 MB/min rx+tx; 10 concurrent CONNECTs per
 *      MCP. Exhaustion returns `429` (bytes) or `503` (connections)
 *      and audits `MCP_HOST_BLOCKED` with a `reason: "quota:*"` field.
 *
 * What it does NOT do:
 *   - Per-call PDP per-byte. The PDP gate fires once per CONNECT, not
 *     once per packet. Matches the spec's "Resolved open questions"
 *     point on per-call PDP.
 *   - HTTP/2 or HTTP/3 CONNECT. HTTP/1.1 only.
 *   - WebSocket forwarding. No legitimate MCP server uses ws today.
 *   - HTTPS termination. The proxy is a transparent byte-pump after
 *     the CONNECT line; the MCP and upstream negotiate TLS end-to-end
 *     so the proxy never sees plaintext.
 *
 * Phase 7 fix-pass change: dropped UDS support entirely. The Linux
 * netns originally surrounded the MCP, requiring a UDS bind-mounted
 * into the namespace — but the resulting `http+unix://...` HTTPS_PROXY
 * URL is not parseable by curl/requests/Go/Node/Bun, breaking every
 * legitimate MCP server. We now use loopback (`127.0.0.1:<port>`)
 * regardless of platform; the URL `http://_:<token>@127.0.0.1:<port>`
 * is universally accepted. Kernel-level network isolation is deferred;
 * per-host PDP + bearer token + prlimit + filesystem sandbox remain.
 *
 * Tied to:
 *   - `mcp-sandbox.ts`      — invokes `createMcpProxy(...).start()`
 *                             before transport instantiation, threads
 *                             the proxy URL into HTTPS_PROXY env.
 *   - `audit-actions.ts`    — `MCP_HOST_BLOCKED` action code.
 */

import { timingSafeEqual } from "node:crypto";
import type { Socket } from "bun";
import type { PermissionEngine } from "./permission-engine";
import type { Capability } from "./capability-types";
import { isInternalHost, normalizeHostname } from "./runtime/internal-host";
import { lookup as dnsLookup } from "./runtime/dns";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";
import { createRateLimiter } from "./rate-limit";

// ── Module-scope kill-switch boot-flag (Phase 55 / MCP-01) ──────────
//
// One-time-per-process flag for the EZCORP_MCP_STAGE1_DNS_RECHECK=0
// kill-switch boot row. When an operator disables the DNS rebind
// recheck via env var, the FIRST CONNECT after process boot emits
// exactly one MCP_NETNS_FALLBACK audit row so /audit reflects the
// degraded mode without flooding the log on every request.
//
// Mirrors mcp-sandbox.ts's `killSwitchBootRowEmitted` pattern (Plan
// 02). Tests reset via `_resetDnsRecheckKillSwitchBootFlagForTests`.
let dnsRecheckKillSwitchBootRowEmitted = false;

// ── Tunables ────────────────────────────────────────────────────────

/** 100 MB/minute rx + tx per MCP, expressed as bytes-per-second tokens. */
const BYTES_PER_SECOND = (100 * 1024 * 1024) / 60;

/** Hard cap on simultaneous CONNECT tunnels per MCP. New CONNECTs over
 *  this number get a 503 immediately. */
const MAX_CONCURRENT_CONNECTIONS = 10;

/** Max HTTP/1.1 request-line + header buffer size. CONNECT lines are
 *  short; anything past 8 KB is malicious framing. */
const MAX_HEADER_BUFFER = 8 * 1024;

// ── Public surface ──────────────────────────────────────────────────

export interface McpProxyConfig {
  extensionId: string;
  extensionName: string;
  /** Per-conversation context for audit chaining. Phase 7 doesn't
   *  thread per-call conversationIds (the MCP process has no ALS); the
   *  value here is the install-time context — typically null. */
  conversationId: string | null;
  userId: string | null;
  /** Allowed hostnames from `manifest.permissions.network`. The PDP is
   *  the source of truth for the authorize() check; this list is held
   *  for diagnostic logging only. */
  permittedHosts: readonly string[];
  /** Phase 1 PDP singleton. Required: a missing engine is fail-closed
   *  per the spec. */
  engine: PermissionEngine;
  /** Loopback bind address. Format: `host:port`. Pass `port=0` to let
   *  the OS pick. Always `127.0.0.1` in production; tests may pass a
   *  fixed port for deterministic teardown. */
  bindAddress: string;
}

export interface McpProxyHandle {
  /** Bring up the listener. Idempotent — repeated calls return the
   *  same listener and are no-ops. */
  start(): Promise<void>;
  /** Tear down the listener and close any active CONNECT tunnels.
   *  Idempotent. Called from `registry.killAll()` and on uninstall via
   *  `registry.reload()` (Phase 7 fix-pass C3). */
  stop(): Promise<void>;
  /** Token + URL the MCP process should receive via HTTPS_PROXY env.
   *  Only meaningful after `start()` resolves. */
  proxyUrl(): string;
  bytesTransferred(): { rx: number; tx: number };
  connectionsCount(): number;
  /** Test-only: force-flush counters AND active-tunnel set so a test
   *  that re-uses the proxy across cases doesn't see carry-over. */
  _resetCountersForTests(): void;
}

/**
 * Create the per-MCP proxy. Construction is synchronous and lazy —
 * call `.start()` to bind the listener.
 */
export function createMcpProxy(config: McpProxyConfig): McpProxyHandle {
  if (!config.engine) {
    throw new Error("createMcpProxy: missing PermissionEngine — fail-closed");
  }

  // Per-instance bearer token. The MCP process learns it via the
  // HTTPS_PROXY url; nothing else can mint a valid CONNECT request.
  const token = generateToken();
  // Pre-encoded token bytes for `timingSafeEqual` — both sides must be
  // equal-length Buffers, so we cache the constant side here.
  const tokenBytes = Buffer.from(token, "utf8");

  // Quotas. One bytes-budget for rx + tx combined (matches the
  // headline "100MB/min rx+tx" wording in the spec); separate
  // connection-counter for the 10-concurrent cap.
  const consumeBytes = createRateLimiter(BYTES_PER_SECOND);

  let listenerHandle: { close: () => Promise<void> } | null = null;
  // Track every active tunnel so `stop()` can rip them down.
  const activeTunnels = new Set<{ close: () => void }>();
  // Counters surfaced via `bytesTransferred()` / `connectionsCount()`.
  let rxBytes = 0;
  let txBytes = 0;
  let totalConnections = 0;
  // Concrete bind result captured at start(). Used by `proxyUrl()`.
  let boundAddress: { host: string; port: number } | null = null;

  async function start(): Promise<void> {
    if (listenerHandle) return;
    listenerHandle = await bindListener();
  }

  async function stop(): Promise<void> {
    if (!listenerHandle) return;
    // Stop accepting new connections first so no race between
    // teardown and a new CONNECT.
    await listenerHandle.close();
    listenerHandle = null;

    for (const t of activeTunnels) {
      try { t.close(); } catch { /* socket already torn down */ }
    }
    activeTunnels.clear();
  }

  async function bindListener() {
    // `bindAddress` is always `host:port` (post-fix-pass — UDS removed
    // because `http+unix://...` HTTPS_PROXY is unparseable by stdlib
    // HTTP clients). Default host to 127.0.0.1 if unspecified.
    const [hostPart, portStr] = config.bindAddress.split(":");
    const wantPort = Number.parseInt(portStr ?? "0", 10);
    const hostname = hostPart || "127.0.0.1";
    const listener = Bun.listen({
      hostname,
      port: Number.isFinite(wantPort) ? wantPort : 0,
      socket: buildSocketHandler(),
    });
    // Capture the OS-assigned port. We deliberately use the configured
    // hostname (not `listener.hostname`) for the URL: Bun normalizes
    // the listening address to "0.0.0.0" / "::" in some configs, which
    // produces an unreachable HTTPS_PROXY URL for the MCP child.
    boundAddress = { host: hostname, port: listener.port };
    return { close: async () => { listener.stop(true); } };
  }

  function buildSocketHandler() {
    // One state slot per inbound socket — accumulating CONNECT-line
    // bytes until we see the CRLF CRLF terminator. After CONNECT is
    // approved + tunneled, `state.upstream` holds the upstream socket
    // and the pump runs raw.
    type ClientState = {
      headerBuf: Buffer | null;
      upstream: Socket<TunnelData> | null;
      tunnel: { close: () => void } | null;
    };
    type TunnelData = { client: Socket<ClientState> };

    return {
      open(client: Socket<ClientState>) {
        // Per-MCP cap on concurrent tunnels. Reject the new one before
        // it consumes a CONNECT round trip.
        if (activeTunnels.size >= MAX_CONCURRENT_CONNECTIONS) {
          writeStatusAndClose(
            client,
            "503 Service Unavailable",
            `Too many concurrent connections (max ${MAX_CONCURRENT_CONNECTIONS})`,
          );
          void auditBlocked(config, "quota:concurrent", null);
          return;
        }
        client.data = { headerBuf: Buffer.alloc(0), upstream: null, tunnel: null };
      },

      data(client: Socket<ClientState>, chunk: Buffer) {
        const state = client.data;
        if (state.upstream) {
          // Tunneled phase: byte-pump client → upstream. Quota: count
          // the bytes against the per-MCP bucket; over-budget closes
          // the tunnel.
          if (!consumeBytes(config.extensionId, chunk.byteLength)) {
            void auditBlocked(config, "quota:bytes", null);
            tearDown(client, state, "quota:bytes");
            return;
          }
          rxBytes += chunk.byteLength;
          state.upstream.write(chunk);
          return;
        }

        // Header phase: append, then look for CRLF CRLF.
        if (!state.headerBuf) return;
        state.headerBuf = Buffer.concat([state.headerBuf, chunk]);
        if (state.headerBuf.byteLength > MAX_HEADER_BUFFER) {
          writeStatusAndClose(client, "431 Request Header Fields Too Large", "");
          return;
        }

        const headerEnd = state.headerBuf.indexOf("\r\n\r\n");
        if (headerEnd === -1) return; // incomplete; wait for more bytes

        const headerStr = state.headerBuf.toString("utf8", 0, headerEnd);
        const tail = state.headerBuf.subarray(headerEnd + 4);
        state.headerBuf = null;
        void handleConnect(client, state, headerStr, tail);
      },

      close(client: Socket<ClientState>) {
        const state = client.data;
        if (state?.tunnel) {
          activeTunnels.delete(state.tunnel);
          state.tunnel = null;
        }
        if (state?.upstream) {
          try { state.upstream.end(); } catch { /* already torn */ }
          state.upstream = null;
        }
      },

      error(client: Socket<ClientState>) {
        const state = client.data;
        if (state?.upstream) {
          try { state.upstream.end(); } catch { /* already torn */ }
        }
      },
    };

    async function handleConnect(
      client: Socket<ClientState>,
      state: ClientState,
      headerStr: string,
      pendingBytes: Buffer,
    ): Promise<void> {
      const parsed = parseConnectRequest(headerStr);
      if (!parsed.ok) {
        writeStatusAndClose(client, "400 Bad Request", parsed.reason);
        return;
      }
      const { hostname, port, providedToken } = parsed;

      // Constant-time token compare. `timingSafeEqual` requires equal
      // byte-lengths on both sides; an unequal length is itself a
      // mismatch and short-circuits without leaking the prefix.
      const providedBytes = Buffer.from(providedToken, "utf8");
      const tokenOk =
        providedBytes.byteLength === tokenBytes.byteLength &&
        timingSafeEqual(providedBytes, tokenBytes);
      if (!tokenOk) {
        writeStatusAndClose(client, "407 Proxy Authentication Required", "Bad token");
        // Audit metadata deliberately omits the provided token. The
        // value is sensitive; an attacker who can read audit logs
        // shouldn't be able to learn what token a victim used. The
        // audit row carries `reason: "auth"` and the hostname only.
        void auditBlocked(config, "auth", hostname);
        return;
      }

      // Internal-host hard deny. localhost / RFC-1918 / link-local /
      // unique-local are refused outright at the proxy regardless of
      // what the manifest grants. Phase 2's `network.internal`
      // reverse-RPC handles the legitimate "extension wants to talk
      // to a host-internal service" case via a separate, manifest-
      // declared opt-in; the bare `network` grant on an MCP server
      // never opens that door.
      const normalized = normalizeHostname(hostname);
      if (isInternalHost(normalized)) {
        writeStatusAndClose(
          client,
          "403 Forbidden",
          `Internal host blocked: ${hostname}`,
        );
        void auditBlocked(config, "internal", hostname);
        return;
      }

      // MCP-01 (Phase 55): DNS-rebind recheck. Resolve the (non-literal)
      // hostname and refuse if any A/AAAA record is an internal address.
      // Reuses the existing MCP_HOST_BLOCKED audit action with
      // metadata.reason="rebind" — taxonomy unchanged, SIEM filters on
      // metadata.reason (mirrors Phase 54 SEC-03's AUDIT_PERM_DENIED
      // reuse for cap-exceeded denies).
      //
      // The TOCTOU window between this lookup and the upstream connect
      // remains a documented gap (MCP-06, v1.5+ — pin Bun.connect to
      // the validated IP with SNI plumbing).
      //
      // Kill-switch: EZCORP_MCP_STAGE1_DNS_RECHECK=0 disables this
      // block at boot. Operator escape hatch for emergency fleet
      // rollback. When the kill-switch is set, we ALSO emit a one-time
      // MCP_NETNS_FALLBACK boot row on the first CONNECT so /audit
      // reflects the degraded mode (CONTEXT.md lines 55-56; mirrors
      // Plan 02's tmpfs flag).
      if (process.env.EZCORP_MCP_STAGE1_DNS_RECHECK === "0") {
        if (!dnsRecheckKillSwitchBootRowEmitted) {
          dnsRecheckKillSwitchBootRowEmitted = true;
          void emitDnsRecheckKillSwitchBootRow(config);
        }
      } else {
        let records: Array<{ address: string; family: 4 | 6 }>;
        try {
          records = await dnsLookup(normalized, { family: 0 });
        } catch (err) {
          writeStatusAndClose(
            client,
            "502 Bad Gateway",
            `DNS resolution failed: ${(err as Error).message}`,
          );
          void auditBlocked(config, "rebind", hostname);
          return;
        }
        for (const rec of records) {
          if (isInternalHost(rec.address)) {
            writeStatusAndClose(
              client,
              "403 Forbidden",
              `Internal IP blocked: ${rec.address}`,
            );
            void auditBlocked(config, "rebind", hostname);
            return;
          }
        }
      }

      const cap: Capability = {
        kind: "network",
        value: normalized,
      };
      let decision;
      try {
        decision = await config.engine.authorize(
          {
            extensionId: config.extensionId,
            userId: config.userId,
            conversationId: config.conversationId,
          },
          [cap],
        );
      } catch {
        writeStatusAndClose(client, "500 Internal Server Error", "PDP failure");
        return;
      }
      if (decision.decision !== "allow") {
        writeStatusAndClose(client, "403 Forbidden", `Hostname denied: ${hostname}`);
        void auditBlocked(config, "host", hostname);
        return;
      }

      // Open upstream. `Bun.connect({hostname, port})` doesn't itself
      // do TLS — the MCP and the upstream perform the TLS handshake
      // through the tunnel after we send `200 Connection Established`.
      let upstream: Socket<TunnelData>;
      try {
        upstream = await Bun.connect<TunnelData>({
          hostname,
          port,
          socket: buildUpstreamHandler(),
        });
      } catch (err) {
        writeStatusAndClose(
          client,
          "502 Bad Gateway",
          `Upstream connect failed: ${(err as Error).message}`,
        );
        return;
      }
      upstream.data = { client };

      const tunnel = {
        close() {
          try { upstream.end(); } catch { /* already torn */ }
          try { client.end(); } catch { /* already torn */ }
        },
      };
      activeTunnels.add(tunnel);
      totalConnections += 1;
      state.tunnel = tunnel;
      state.upstream = upstream;

      // 200 OK — RFC 7230 §3.3.1: "Connection Established" is the
      // canonical reason phrase. After this, the client is free to
      // start the TLS ClientHello.
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      // Forward any bytes the client already sent past the CRLF CRLF
      // (rare, but legal for HTTP-pipelining clients).
      if (pendingBytes.byteLength > 0) {
        if (!consumeBytes(config.extensionId, pendingBytes.byteLength)) {
          void auditBlocked(config, "quota:bytes", hostname);
          tearDown(client, state, "quota:bytes");
          return;
        }
        rxBytes += pendingBytes.byteLength;
        upstream.write(pendingBytes);
      }
    }

    function buildUpstreamHandler() {
      return {
        data(upstream: Socket<TunnelData>, chunk: Buffer) {
          const peer = upstream.data?.client;
          if (!peer) return;
          if (!consumeBytes(config.extensionId, chunk.byteLength)) {
            void auditBlocked(config, "quota:bytes", null);
            try { upstream.end(); } catch { /* race */ }
            try { peer.end(); } catch { /* race */ }
            return;
          }
          txBytes += chunk.byteLength;
          peer.write(chunk);
        },
        close(upstream: Socket<TunnelData>) {
          const peer = upstream.data?.client;
          if (peer) try { peer.end(); } catch { /* race */ }
        },
        error(upstream: Socket<TunnelData>) {
          const peer = upstream.data?.client;
          if (peer) try { peer.end(); } catch { /* race */ }
        },
      };
    }
  }

  function tearDown(
    client: Socket<{ headerBuf: Buffer | null; upstream: Socket<{ client: Socket<unknown> }> | null; tunnel: { close: () => void } | null }>,
    state: { upstream: Socket<{ client: Socket<unknown> }> | null; tunnel: { close: () => void } | null },
    reason: string,
  ): void {
    writeStatusAndClose(client, "429 Too Many Requests", reason);
    if (state.tunnel) {
      activeTunnels.delete(state.tunnel);
      state.tunnel = null;
    }
    if (state.upstream) {
      try { state.upstream.end(); } catch { /* race */ }
      state.upstream = null;
    }
  }

  function proxyUrl(): string {
    if (!boundAddress) throw new Error("proxyUrl() before start()");
    return `http://_:${token}@${boundAddress.host}:${boundAddress.port}`;
  }

  return {
    start,
    stop,
    proxyUrl,
    bytesTransferred: () => ({ rx: rxBytes, tx: txBytes }),
    connectionsCount: () => totalConnections,
    _resetCountersForTests: () => {
      rxBytes = 0;
      txBytes = 0;
      totalConnections = 0;
      // Phase 7 fix-pass nit: also clear the active-tunnel set so a
      // test that re-uses the proxy across cases doesn't trip the
      // 503-on-11th-connect cap because of leaked refs from a prior
      // case. Tunnels themselves are still drained by `stop()`.
      activeTunnels.clear();
    },
  };
}

// ── Internal helpers ────────────────────────────────────────────────

function generateToken(): string {
  // 32 bytes of crypto-grade randomness, hex-encoded → 64 chars.
  // crypto.randomUUID() is too narrow (122 bits) for a value that
  // travels in env. URL-safe and copy-paste safe.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface ParsedConnectOk {
  ok: true;
  hostname: string;
  port: number;
  providedToken: string;
}
interface ParsedConnectFail {
  ok: false;
  reason: string;
}

/**
 * Parse the leading HTTP/1.1 request and pull out:
 *   - the target hostname + port from `CONNECT host:port HTTP/1.1`
 *   - the bearer token from the `Proxy-Authorization: Basic ...` header
 *
 * The proxy URL the MCP gets is `http://_:<token>@host:port`, which
 * curl / requests / Go all forward as a Basic-auth Proxy-Authorization
 * header where the password slot is the token.
 */
export function parseConnectRequest(
  headerStr: string,
): ParsedConnectOk | ParsedConnectFail {
  const lines = headerStr.split("\r\n");
  const requestLine = lines[0] ?? "";
  // CONNECT <host:port> HTTP/1.1
  const reqMatch = requestLine.match(/^CONNECT\s+([^\s]+)\s+HTTP\/1\.[01]\s*$/);
  if (!reqMatch) {
    return { ok: false, reason: `Expected CONNECT request, got: ${requestLine.slice(0, 60)}` };
  }
  const [hostnamePart, portPart] = (reqMatch[1] ?? "").split(":");
  if (!hostnamePart || !portPart) {
    return { ok: false, reason: "CONNECT target must be host:port" };
  }
  const port = Number.parseInt(portPart, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return { ok: false, reason: `Invalid CONNECT port: ${portPart}` };
  }

  let providedToken = "";
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "proxy-authorization") {
      // RFC 7617 — `Basic <b64(user:password)>`. We treat the password
      // half as the token (user is the placeholder `_`).
      const m = value.match(/^Basic\s+(.+)$/i);
      if (m?.[1]) {
        try {
          const decoded = Buffer.from(m[1], "base64").toString("utf8");
          const sep = decoded.indexOf(":");
          if (sep !== -1) providedToken = decoded.slice(sep + 1);
        } catch { /* malformed — leave empty */ }
      }
    }
  }

  return { ok: true, hostname: hostnamePart, port, providedToken };
}

function writeStatusAndClose(
  client: Socket<unknown>,
  statusLine: string,
  body: string,
): void {
  const payload = body || "";
  const headers = [
    `HTTP/1.1 ${statusLine}`,
    `Content-Length: ${Buffer.byteLength(payload, "utf8")}`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    "",
    payload,
  ].join("\r\n");
  try { client.write(headers); } catch { /* peer already gone */ }
  try { client.end(); } catch { /* peer already gone */ }
}

async function auditBlocked(
  config: McpProxyConfig,
  reasonClass: string,
  hostname: string | null,
): Promise<void> {
  try {
    await insertAuditEntry(
      config.userId,
      EXT_AUDIT_ACTIONS.MCP_HOST_BLOCKED,
      config.extensionId,
      {
        permission: "network",
        oldValue: null,
        newValue: null,
        actor: "system",
        reason: reasonClass,
        extensionName: config.extensionName,
        hostname: hostname ?? null,
      },
    );
  } catch { /* DB blip — never fail-open the proxy on a logging error */ }
}

/**
 * Phase 55 / MCP-01 — emit a one-time MCP_NETNS_FALLBACK audit row on
 * the FIRST CONNECT after process boot when the operator kill-switch
 * `EZCORP_MCP_STAGE1_DNS_RECHECK=0` is set. Mirrors mcp-sandbox.ts's
 * boot-row treatment (Plan 02). Fire-and-forget — a DB blip on the
 * boot row must NEVER fail-open the CONNECT path.
 *
 * The proxy is process-wide and has no per-spawn ctx/manifest, so the
 * row is written directly via `insertAuditEntry` (NOT through the
 * `auditBlocked` helper, which writes MCP_HOST_BLOCKED). This keeps
 * the kill-switch boot row in the same MCP_NETNS_FALLBACK bucket as
 * the other two Stage 1 kill-switches (tmpfs, seccomp) so operators
 * see all three uniformly in /audit.
 */
async function emitDnsRecheckKillSwitchBootRow(
  config: McpProxyConfig,
): Promise<void> {
  try {
    await insertAuditEntry(
      config.userId,
      EXT_AUDIT_ACTIONS.MCP_NETNS_FALLBACK,
      config.extensionId,
      {
        permission: "network",
        oldValue: null,
        newValue: null,
        actor: "system",
        extensionName: config.extensionName,
        reason: "kill-switch: dns-recheck disabled",
        platform: process.platform,
      },
    );
  } catch { /* fire-and-forget — mirror auditBlocked posture */ }
}

/**
 * Test-only: reset the one-time DNS-recheck kill-switch boot-row flag
 * so each test starts with a clean slate. Production code never calls
 * this — it's only wired through `mcp-proxy.test.ts`'s `beforeEach`.
 */
export function _resetDnsRecheckKillSwitchBootFlagForTests(): void {
  dnsRecheckKillSwitchBootRowEmitted = false;
}
