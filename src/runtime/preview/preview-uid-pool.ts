/**
 * preview-uid-pool.ts — per-conversation preview-uid allocation + the
 * boot-time .ezcorp/data lockdown (Secure User-Site Preview / Port
 * Exposure, Phase 3a — see tasks/preview-port-exposure.md "Phase 3
 * REDESIGN — portable uid-based isolation", item 2).
 *
 * In the portable uid design a conversation that runs a dev server gets
 * its own uid from an allowlisted range (90000–99000). That uid is BOTH:
 *   - the FILESYSTEM isolation boundary — it can read its own work dir but
 *     NOT .ezcorp/data (which is chmod 0700, app-owned), so the DB +
 *     encrypted JWT secret are unreachable, and
 *   - the ATTRIBUTION key — /proc/net/tcp exposes a uid column, so a LISTEN
 *     socket owned by a preview uid maps straight back to its conversation
 *     and user (see ProcPortSource).
 *
 * This mirrors the shape of `allocatePreviewNetns` (alloc/reap/idempotent/
 * reuse-after-reap + an active count) so the watcher + spawn wiring treat
 * uid and netns modes the same way.
 *
 * THE KEYSTONE — `.ezcorp/data` must be 0700 owned by the app uid so a
 * preview uid (a different uid with no supplementary groups) cannot read
 * it. `enforceDataDirLockdown()` is called once at boot to make that
 * load-bearing rather than assumed. If it can't be enforced, the caller
 * MUST refuse to enable uid-mode dynamic previews (fail-closed).
 */

import { resolve } from "node:path";
import { chmodSync, statSync } from "node:fs";
import { logger } from "../../logger";

const log = logger.child("preview.uid-pool");

/**
 * The allowlisted preview-uid range — kept in sync with preview-spawn.ts
 * (PREVIEW_UID_MIN/MAX) and build/preview-spawn.c. Re-imported rather than
 * re-declared so there is a single source of truth.
 */
import { PREVIEW_UID_MIN, PREVIEW_UID_MAX } from "./preview-spawn";

// Re-export the range so consumers of the pool don't need a second import.
export { PREVIEW_UID_MIN, PREVIEW_UID_MAX };

/** Inclusive count of uids in the pool. */
export const PREVIEW_UID_POOL_SIZE = PREVIEW_UID_MAX - PREVIEW_UID_MIN + 1;

export interface PreviewUidAllocation {
  conversationId: string;
  /** The preview uid this conversation's dev servers run as. */
  uid: number;
}

/** convId → allocation. */
const allocations = new Map<string, PreviewUidAllocation>();
/** uid → convId reverse index (for ProcPortSource attribution). */
const uidToConversation = new Map<number, string>();
/** Free uids, lazily seeded from the range on first alloc. */
let freeUids: number[] | null = null;

function ensureSeeded(): number[] {
  if (freeUids === null) {
    freeUids = [];
    for (let u = PREVIEW_UID_MIN; u <= PREVIEW_UID_MAX; u++) freeUids.push(u);
  }
  return freeUids;
}

/**
 * Allocate (or return the existing) preview uid for a conversation.
 * Idempotent — a second call for the same conversation returns the same
 * uid without consuming another. Returns null when the pool is exhausted
 * (logged, not silent — mirrors the veth 60-slot cap behavior).
 */
export function allocatePreviewUid(conversationId: string): PreviewUidAllocation | null {
  if (!conversationId) return null;
  const existing = allocations.get(conversationId);
  if (existing) return existing;

  const free = ensureSeeded();
  const uid = free.shift();
  if (uid === undefined) {
    log.warn("preview uid pool exhausted — refusing new allocation", {
      conversationId,
      poolSize: PREVIEW_UID_POOL_SIZE,
      active: allocations.size,
    });
    return null;
  }
  const alloc: PreviewUidAllocation = { conversationId, uid };
  allocations.set(conversationId, alloc);
  uidToConversation.set(uid, conversationId);
  return alloc;
}

/** Look up a conversation's current uid allocation, if any. */
export function getPreviewUid(conversationId: string): PreviewUidAllocation | undefined {
  return allocations.get(conversationId);
}

/**
 * Reverse lookup: the conversation that owns `uid`, if any. Used by
 * ProcPortSource to attribute a LISTEN socket's uid column back to a
 * conversation (→ user).
 */
export function conversationForPreviewUid(uid: number): string | undefined {
  return uidToConversation.get(uid);
}

/**
 * Reap a conversation's uid: return it to the free pool + drop both index
 * entries. Idempotent — reaping an unknown conversation is a no-op.
 * Returns true when an allocation was actually released. The freed uid is
 * reusable by a later conversation (reuse-after-reap).
 */
export function reapPreviewUid(conversationId: string): boolean {
  const alloc = allocations.get(conversationId);
  if (!alloc) return false;
  allocations.delete(conversationId);
  uidToConversation.delete(alloc.uid);
  ensureSeeded().push(alloc.uid);
  return true;
}

/** Number of conversations currently holding a uid allocation. */
export function activePreviewUidCount(): number {
  return allocations.size;
}

/** Test-only: clear all allocations + re-seed the free pool. */
export function _resetPreviewUidPoolForTests(): void {
  allocations.clear();
  uidToConversation.clear();
  freeUids = null;
}

// ─────────────────────────────────────────────────────────────────────
// The keystone — `.ezcorp/data` lockdown.
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the `.ezcorp/data` dir that MUST be unreadable by preview uids.
 * Env-derived (mirrors previewSitesRoot in preview-sessions.ts) so this
 * module doesn't drag in the heavier project-root graph.
 */
export function previewDataDir(projectRoot?: string): string {
  const root = projectRoot ?? process.env.EZCORP_PROJECT_ROOT ?? process.cwd();
  return resolve(root, ".ezcorp", "data");
}

export interface DataDirLockdownResult {
  /** True when the dir is (now) 0700. */
  ok: boolean;
  /** The path we operated on. */
  path: string;
  /** Reason it could not be locked down (null on success). */
  reason: string | null;
}

/**
 * Enforce that `.ezcorp/data` is chmod 0700 so a preview uid (a different
 * uid with NO supplementary groups, per the setuid helper) cannot read the
 * PGlite DB or the encrypted JWT secret. Called once at boot BEFORE any
 * preview uid can run.
 *
 * This is the load-bearing keystone of the uid design: without it, a
 * preview uid that shares the app user's group (or a world-readable data
 * dir) could read secrets. We make the invariant real, not assumed.
 *
 * Fail-closed contract: the caller treats `ok === false` as "do NOT enable
 * uid-mode dynamic previews" (capability mode falls back to static). We do
 * NOT throw — a missing data dir on a fresh boot is not an error, but it
 * also doesn't grant the capability until the dir exists + is locked.
 *
 * `chmodFn`/`statFn` are injected for unit tests.
 */
export function enforceDataDirLockdown(
  projectRoot?: string,
  deps: {
    chmodFn?: (p: string, mode: number) => void;
    statFn?: (p: string) => { mode: number };
  } = {},
): DataDirLockdownResult {
  const path = previewDataDir(projectRoot);
  const chmodFn = deps.chmodFn ?? ((p, m) => chmodSync(p, m));
  const statFn = deps.statFn ?? ((p) => ({ mode: statSync(p).mode }));

  // Confirm the dir exists first — a fresh instance may not have created
  // it yet; that's fine (no secrets to protect), just no capability grant.
  try {
    statFn(path);
  } catch {
    return { ok: false, path, reason: "data dir does not exist yet" };
  }

  try {
    // 0o700: owner rwx, group/other nothing. The mask 0o7777 covers the
    // permission + setid bits; we set exactly rwx------.
    chmodFn(path, 0o700);
  } catch (err) {
    const reason = `chmod 0700 failed: ${(err as Error)?.message ?? String(err)}`;
    log.warn("preview data-dir lockdown FAILED — uid-mode previews unsafe", { path, reason });
    return { ok: false, path, reason };
  }

  // Verify the mode actually took (a no-op chmod on some filesystems).
  try {
    const { mode } = statFn(path);
    const perms = mode & 0o777;
    if (perms !== 0o700) {
      const reason = `data dir is ${perms.toString(8)} after chmod, expected 700`;
      log.warn("preview data-dir lockdown did not stick", { path, reason });
      return { ok: false, path, reason };
    }
  } catch (err) {
    return { ok: false, path, reason: `re-stat failed: ${(err as Error)?.message ?? String(err)}` };
  }

  log.info("preview data-dir locked down to 0700 (keystone)", { path });
  return { ok: true, path, reason: null };
}
