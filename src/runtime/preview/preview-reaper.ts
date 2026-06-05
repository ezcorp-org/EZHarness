/**
 * preview-reaper.ts — tear down a conversation's dynamic previews on
 * conversation close / idle timeout / explicit stop (Secure User-Site
 * Preview / Port Exposure, Phase 3b, deliverable 4 "idle reaping").
 *
 * Reaping a conversation must, in one atomic-ish sweep:
 *   1. KILL its dev-server processes (so the untrusted code stops running),
 *   2. REVOKE its preview_sessions rows (so the proxy fails closed instantly
 *      — even an in-flight request with a valid token gets a 404),
 *   3. RELEASE its preview uid back to the pool (reuse-after-reap),
 *   4. DROP the watcher's watch (so the daemon stops polling /proc for it),
 *   5. FORGET its rate-limit accounting (so a freed id doesn't leak memory).
 *
 * Pure over injected deps so the full ordering + the "kills proc + revokes +
 * drops watch" contract is unit-tested without a live process, DB, or daemon.
 * The live wiring (conversation-close hook + the watcher idle sweep) calls
 * `reapPreviewConversation` with the real implementations.
 */

import { logger } from "../../logger";
import {
  killConversationProcesses,
  type KillConversationResult,
} from "./preview-spawn-orchestration";
import { reapPreviewUid, quarantinePreviewUid } from "./preview-uid-pool";
import { reapPreviewNetns } from "./preview-netns";
import { getPreviewQuota } from "./preview-rate-limit";

const log = logger.child("preview.reaper");

export interface ReapPreviewDeps {
  /** Kill every tracked dev-server process for the conversation. Resolves to
   *  CONFIRMED vs UNCONFIRMED kill counts. Defaults to the live orchestration
   *  registry (which routes through the setuid helper's --kill mode). */
  killProcesses?: (conversationId: string) => Promise<KillConversationResult>;
  /** Revoke the conversation's preview_sessions rows (DB). Defaults to the
   *  live query. Returns the revoked preview IDs (so their quota accounting
   *  can be forgotten). */
  revokePreviews?: (conversationId: string) => Promise<string[]>;
  /** Release the conversation's preview uid back to the pool. Defaults to the
   *  live uid pool. Only called when the kill was CONFIRMED. */
  reapUid?: (conversationId: string) => boolean;
  /** Quarantine the conversation's preview uid (withhold from the pool) when
   *  the kill could NOT be confirmed. Defaults to the live uid pool. */
  quarantineUid?: (conversationId: string) => boolean;
  /** Release the conversation's netns allocation (hardened mode). Defaults to
   *  the live netns registry — a no-op in uid mode (nothing allocated). */
  reapNetns?: (conversationId: string) => boolean;
  /** Drop the watcher's watch so it stops polling for this conversation. */
  unwatch?: (conversationId: string) => void;
  /** Forget a revoked preview's quota accounting (so a freed id doesn't leak
   *  memory). Defaults to the singleton quota's `forget`. */
  forgetQuota?: (previewId: string) => void;
}

export interface ReapPreviewResult {
  conversationId: string;
  processesKilled: number;
  /** Processes whose kill could NOT be confirmed (drives uid quarantine). */
  processesUnconfirmed: number;
  previewsRevoked: number;
  /** True when the uid was released back to the pool (kill confirmed). */
  uidReleased: boolean;
  /** True when the uid was QUARANTINED instead of released (kill unconfirmed). */
  uidQuarantined: boolean;
}

/**
 * Reap a conversation's dynamic previews. Fail-safe: every step is guarded so
 * one failure (e.g. a DB hiccup) never blocks the others — killing the
 * untrusted process is the most important step and runs first. Returns a
 * summary for logging/observability.
 */
export async function reapPreviewConversation(
  conversationId: string,
  deps: ReapPreviewDeps = {},
): Promise<ReapPreviewResult> {
  const result: ReapPreviewResult = {
    conversationId,
    processesKilled: 0,
    processesUnconfirmed: 0,
    previewsRevoked: 0,
    uidReleased: false,
    uidQuarantined: false,
  };
  if (!conversationId) return result;

  // 1. Kill the untrusted dev-server processes FIRST. The kill is CONFIRMED
  //    only when the setuid helper reports the group leader gone; an
  //    unconfirmed kill must NOT release the uid (a live orphan may own it).
  //    A thrown killer is treated as fully unconfirmed (fail-closed): if we
  //    don't know how many processes we tracked, assume the worst and
  //    quarantine the uid below.
  let killUnknownFailure = false;
  try {
    const killer = deps.killProcesses ?? killConversationProcesses;
    const k = await killer(conversationId);
    result.processesKilled = k.killed;
    result.processesUnconfirmed = k.unconfirmed;
  } catch (err) {
    killUnknownFailure = true;
    log.warn("reap: killing processes failed", { conversationId, error: String(err) });
  }

  // 2. Revoke the DB rows so the proxy fails closed immediately, AND forget
  //    each revoked preview's quota accounting (so a freed id can't leak
  //    memory in the rate-limit maps).
  try {
    const revoke =
      deps.revokePreviews ??
      (async (c: string) => {
        const { reapPreviewIdsForConversation } = await import("../../db/queries/preview-sessions");
        return reapPreviewIdsForConversation(c);
      });
    const revokedIds = await revoke(conversationId);
    result.previewsRevoked = revokedIds.length;
    const forget = deps.forgetQuota ?? ((id: string) => getPreviewQuota().forget(id));
    for (const id of revokedIds) {
      try {
        forget(id);
      } catch (err) {
        log.warn("reap: forgetting quota failed", { conversationId, previewId: id, error: String(err) });
      }
    }
  } catch (err) {
    log.warn("reap: revoking previews failed", { conversationId, error: String(err) });
  }

  // 3. Release OR quarantine the preview uid based on kill confirmation.
  //    - kill fully confirmed (no unconfirmed, no thrown killer) → release
  //      the uid back to the allocatable pool (safe reuse).
  //    - ANY unconfirmed kill (or a thrown killer) → QUARANTINE the uid: drop
  //      its allocation but withhold it from the pool so a future conversation
  //      can NEVER be allocated a uid a live orphan still owns. This is the
  //      uid-barrier integrity fix.
  const killConfirmed = !killUnknownFailure && result.processesUnconfirmed === 0;
  try {
    if (killConfirmed) {
      result.uidReleased = (deps.reapUid ?? reapPreviewUid)(conversationId);
    } else {
      result.uidQuarantined = (deps.quarantineUid ?? quarantinePreviewUid)(conversationId);
    }
  } catch (err) {
    log.warn("reap: releasing/quarantining uid failed", { conversationId, error: String(err) });
  }
  try {
    (deps.reapNetns ?? reapPreviewNetns)(conversationId);
  } catch (err) {
    log.warn("reap: releasing netns failed", { conversationId, error: String(err) });
  }

  // 4. Drop the watcher's watch so the daemon stops polling for it.
  try {
    deps.unwatch?.(conversationId);
  } catch (err) {
    log.warn("reap: unwatch failed", { conversationId, error: String(err) });
  }

  log.info("preview conversation reaped", {
    conversationId,
    processesKilled: result.processesKilled,
    processesUnconfirmed: result.processesUnconfirmed,
    previewsRevoked: result.previewsRevoked,
    uidReleased: result.uidReleased,
    uidQuarantined: result.uidQuarantined,
  });
  return result;
}
