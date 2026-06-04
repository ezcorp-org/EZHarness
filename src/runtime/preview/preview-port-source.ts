/**
 * Pluggable port-enumeration source for the preview port watcher
 * (Secure User-Site Preview / Port Exposure, Phase 2 — see
 * tasks/preview-port-exposure.md §3.2).
 *
 * The watcher is decoupled from HOW listening sockets are discovered so
 * the whole detection framework is unit/integration testable with an
 * injected source. This mirrors how Phase 1 built the netns scaffolding
 * (alloc/reap + capability detection) without the live veth pair: the
 * interface + wiring are complete and tested; the live syscall read is
 * the Phase 3 deliverable.
 *
 * Two concrete sources ship here:
 *
 *   1. `NetnsPortSource` — the real, capability-gated source. When
 *      `previewCapabilities().dynamic` is TRUE it would enter each
 *      conversation's netns and parse `/proc/net/tcp{,6}` for LISTEN
 *      sockets. On every host that fails-closed for dynamic previews
 *      (the current env — D2), it yields NOTHING (no silent capability;
 *      the watcher logs the no-op). The actual `/proc/net/tcp`-in-netns
 *      read is explicitly Phase 3 and is marked with `PHASE3_STUB`.
 *
 *   2. `StaticPortSource` — a deterministic in-memory source used by
 *      tests (and conceivably a future manual-registration path). It
 *      returns whatever listeners were programmed for a conversation.
 *
 * D2 (LOCKED): dynamic previews fail closed on hosts without netns /
 * CAP_NET_ADMIN. The capability gate lives in `NetnsPortSource` so the
 * watcher daemon stays source-agnostic.
 */

import { readFileSync } from "node:fs";
import { logger } from "../../logger";
import { previewCapabilities } from "./preview-netns";
import { conversationForPreviewUid } from "./preview-uid-pool";

const log = logger.child("preview.port-source");

/** A single listening socket discovered inside a conversation's netns. */
export interface PreviewListener {
  /** The TCP port the dev server is LISTENing on. */
  port: number;
}

/**
 * The enumeration contract the watcher polls. `listListeners` returns
 * the CURRENT set of LISTEN sockets attributable to `conversationId`
 * (i.e. bound inside that conversation's netns). It must be cheap +
 * synchronous-or-async and MUST NOT throw for an unknown conversation
 * (return an empty array). Attribution is by construction — the source
 * only ever sees sockets in the conversation's own namespace.
 */
export interface PreviewPortSource {
  listListeners(conversationId: string): PreviewListener[] | Promise<PreviewListener[]>;
}

/**
 * The real, capability-gated enumeration source.
 *
 * When `previewCapabilities().dynamic` is false (the current host, and
 * every host without netns + CAP_NET_ADMIN — D2 fail-closed) this yields
 * NOTHING. The watcher treats an always-empty source as a logged no-op:
 * detection is simply disabled, exactly like Phase 1 disabled dynamic
 * alloc. No cross-user attribution ever leans on a degraded fallback.
 *
 * When dynamic IS available (Phase 3 deployment posture), `readNetnsListeners`
 * enters the conversation's netns and parses `/proc/net/tcp{,6}` for
 * `st == 0x0A` (TCP_LISTEN) rows. That live syscall read is the Phase 3
 * deliverable; here it is a clearly-marked stub so the interface + the
 * capability gate are complete and fully tested today.
 */
export class NetnsPortSource implements PreviewPortSource {
  /** Logged-once guard so the disabled-source no-op doesn't spam. */
  private loggedDisabled = false;

  constructor(
    /** Injected for tests: override the capability probe. Defaults to the
     *  real `previewCapabilities()`. */
    private readonly capabilities: () => { dynamic: boolean; reason: string | null } = previewCapabilities,
    /** Injected for tests: override the live netns read. Defaults to the
     *  PHASE3_STUB (always empty). Production wires the real reader in
     *  Phase 3 — until then dynamic is fail-closed-disabled anyway, so the
     *  stub is never reached on a capability-available host that lacks it. */
    private readonly readNetnsListeners: (conversationId: string) => PreviewListener[] = NetnsPortSource.phase3StubReader,
  ) {}

  listListeners(conversationId: string): PreviewListener[] {
    const caps = this.capabilities();
    if (!caps.dynamic) {
      if (!this.loggedDisabled) {
        this.loggedDisabled = true;
        // No silent capability degradation (project policy): announce
        // that auto-detection is off because dynamic previews are
        // fail-closed on this host.
        log.info("preview port detection disabled — dynamic previews unavailable (fail-closed)", {
          reason: caps.reason ?? "unknown",
        });
      }
      return [];
    }
    return this.readNetnsListeners(conversationId);
  }

  /**
   * PHASE3_STUB — the live `/proc/net/tcp{,6}`-in-netns read.
   *
   * Phase 3 will: resolve the conversation's netns (getPreviewNetns),
   * `nsenter`/`setns` into it, read `/proc/net/tcp` + `/proc/net/tcp6`,
   * keep rows where the connection state column equals `0A` (TCP_LISTEN),
   * decode the local-address port, and return the de-duplicated port set.
   * Inside an isolated netns even `0.0.0.0` binds are safe to surface —
   * they're unreachable except via the proxy.
   *
   * Until that posture change ships, dynamic is fail-closed-disabled (D2)
   * so `listListeners` never calls this on a real host. Returning [] keeps
   * the type honest and the framework testable.
   */
  static phase3StubReader(_conversationId: string): PreviewListener[] {
    return [];
  }
}

/**
 * Deterministic in-memory source for tests + any future manual path.
 * `set(conversationId, ports)` programs the listeners a subsequent
 * `listListeners` returns; `clear()` resets everything.
 */
export class StaticPortSource implements PreviewPortSource {
  private readonly map = new Map<string, PreviewListener[]>();

  set(conversationId: string, ports: number[]): void {
    this.map.set(conversationId, ports.map((port) => ({ port })));
  }

  clear(conversationId?: string): void {
    if (conversationId === undefined) this.map.clear();
    else this.map.delete(conversationId);
  }

  listListeners(conversationId: string): PreviewListener[] {
    return this.map.get(conversationId) ?? [];
  }
}

// ─────────────────────────────────────────────────────────────────────
// ProcPortSource — the real uid-attributed enumeration (Phase 3a).
//
// In the portable uid design each conversation's dev servers run as a
// per-conversation preview uid (see preview-uid-pool.ts). A LISTEN socket
// in `/proc/net/tcp{,6}` carries the OWNING uid in column 8 — so the uid
// is BOTH the fs-isolation boundary AND the attribution key. This source
// reads those files, keeps LISTEN sockets, and maps each socket's uid back
// to a conversation via the uid pool. No PID-ancestry guessing; no netns.
// ─────────────────────────────────────────────────────────────────────

/** TCP_LISTEN — the `st` (state) column value for a listening socket. */
const TCP_LISTEN_STATE = 0x0a;

/** A parsed LISTEN socket row: its local port + the owning uid. */
export interface ProcListenSocket {
  port: number;
  uid: number;
}

/**
 * Parse the contents of a `/proc/net/tcp` or `/proc/net/tcp6` file into the
 * set of LISTEN sockets (port + owning uid). Pure — fed fixture content in
 * tests. Format (one socket per line after the header):
 *
 *   sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt  uid ...
 *   0: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 ...
 *                    ^local         ^st                                        ^uid
 *
 * `local_address` is `HEXIP:HEXPORT`. We keep rows where `st == 0A`
 * (TCP_LISTEN), decode the hex port, and read the uid column (index 7,
 * 0-based, after the header is skipped). Malformed lines are skipped
 * defensively — a single bad row never throws.
 */
export function parseProcNetTcp(content: string): ProcListenSocket[] {
  const out: ProcListenSocket[] = [];
  const lines = content.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // Skip the header row (starts with "sl").
    if (line.startsWith("sl ") || line.startsWith("sl\t") || line === "sl") continue;
    const cols = line.split(/\s+/);
    // Need at least: sl(0) local(1) rem(2) st(3) txrx(4) trtm(5) retr(6) uid(7)
    if (cols.length < 8) continue;
    const local = cols[1];
    const st = cols[3];
    const uidStr = cols[7];
    if (!local || !st || uidStr === undefined) continue;
    // State must be TCP_LISTEN.
    const state = Number.parseInt(st, 16);
    if (!Number.isFinite(state) || state !== TCP_LISTEN_STATE) continue;
    // local is HEXIP:HEXPORT — take the port after the last ':'.
    const colon = local.lastIndexOf(":");
    if (colon < 0) continue;
    const portHex = local.slice(colon + 1);
    const port = Number.parseInt(portHex, 16);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) continue;
    const uid = Number.parseInt(uidStr, 10);
    if (!Number.isFinite(uid) || uid < 0) continue;
    out.push({ port, uid });
  }
  return out;
}

/**
 * Default proc-file reader: reads `/proc/net/tcp` + `/proc/net/tcp6` and
 * returns their concatenated content. A missing file (e.g. no ipv6) is
 * tolerated — its content is simply empty.
 */
function defaultProcReader(): string {
  let combined = "";
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      combined += readFileSync(path, "utf8");
      combined += "\n";
    } catch {
      // Missing/unreadable — skip (tcp6 absent on ipv4-only hosts).
    }
  }
  return combined;
}

/**
 * The real, uid-attributed enumeration source for `uid` capability mode.
 *
 * On each `listListeners(conversationId)` it reads `/proc/net/tcp{,6}`,
 * parses LISTEN sockets, and returns only those whose owning uid maps
 * (via the uid pool) back to THIS conversation. Attribution is by the uid
 * column — structural, not heuristic.
 *
 * The proc-file reader + the uid→conversation resolver are injected so the
 * whole thing is unit-testable with fixture `/proc/net/tcp` content and a
 * synthetic uid map.
 */
export class ProcPortSource implements PreviewPortSource {
  constructor(
    /** Injected for tests: returns the concatenated /proc/net/tcp{,6}
     *  content. Defaults to reading the real files. */
    private readonly readProc: () => string = defaultProcReader,
    /** Injected for tests: resolve an owning uid to its conversation.
     *  Defaults to the live uid pool. */
    private readonly uidToConversation: (uid: number) => string | undefined = conversationForPreviewUid,
  ) {}

  listListeners(conversationId: string): PreviewListener[] {
    if (!conversationId) return [];
    let content: string;
    try {
      content = this.readProc();
    } catch (err) {
      log.warn("ProcPortSource: /proc read failed", { error: String((err as Error)?.message ?? err) });
      return [];
    }
    const sockets = parseProcNetTcp(content);
    // Keep only sockets whose uid maps back to THIS conversation. Dedup by
    // port (a server may bind both tcp + tcp6 on the same port).
    const ports = new Set<number>();
    for (const s of sockets) {
      const owner = this.uidToConversation(s.uid);
      if (owner === conversationId) ports.add(s.port);
    }
    return [...ports].map((port) => ({ port }));
  }
}
