/**
 * Pluggable port-enumeration source for the preview port watcher
 * (Secure User-Site Preview / Port Exposure — see
 * docs/features/tools/preview-port-exposure.md).
 *
 * The watcher is decoupled from HOW listening sockets are discovered so
 * the detection framework is testable with an injected source. Two
 * sources ship here:
 *
 *   1. `ProcPortSource` — the production source in uid mode: reads
 *      `/proc/net/tcp{,6}` and attributes a LISTEN socket to a
 *      conversation by its preview uid.
 *   2. `StaticPortSource` — a deterministic in-memory source for tests.
 */

import { readFileSync } from "node:fs";
import { logger } from "../../logger";
import { conversationForPreviewUid } from "./preview-uid-pool";

const log = logger.child("preview.port-source");

/** A single listening socket attributed to a conversation. */
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
function defaultProcReader(paths: readonly string[] = ["/proc/net/tcp", "/proc/net/tcp6"]): string {
  let combined = "";
  for (const path of paths) {
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

/**
 * Test-only export: the default `/proc/net/tcp{,6}` reader used when
 * `ProcPortSource` is constructed without an injected `readProc`. Exposed so
 * the live (host-readable) read + the missing-file tolerance are gated;
 * production constructs it implicitly.
 */
export const _previewPortSourceInternals = {
  defaultProcReader,
};
