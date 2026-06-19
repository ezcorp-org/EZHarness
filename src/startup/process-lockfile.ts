/**
 * Shared PID-lockfile primitive for the host-side singleton daemons
 * (schedule, host-maintenance, embed-worker, preview-port-watcher,
 * file-organizer).
 *
 * Each of those daemons used to carry a verbatim copy of `acquireLockfile`
 * / `isProcessAlive` / `releaseLockfile`. The orchestrator briefs for the
 * first daemons said "refactor into a shared helper once a third caller
 * shows up" — there are now five, so this module is that extraction.
 *
 * ── Why the old copies self-deadlocked across restarts ──────────────────
 *
 * The old primitive stored only the PID and refused start if
 * `process.kill(storedPid, 0)` succeeded ("PID is alive"). That check is
 * NOT PID-reuse-safe:
 *
 *   - `.pid` files persist across a `docker restart` (container writable
 *     layer / bind mount). On the next boot the OS hands the new process a
 *     low / reused PID. If the stored PID now maps to ANY live process
 *     (often the case — PID 1, the vite/bun server, an unrelated process,
 *     or literally the new daemon's own PID), `isProcessAlive` returns
 *     true and EVERY daemon refuses to start ("sibling alive") — forever,
 *     until someone deletes the stale `.pid` by hand.
 *
 * The fix records a per-process **identity token** alongside the PID. The
 * token is the process's start-time read from `/proc/<pid>/stat` (field 22,
 * PID-reuse-safe: a reused PID has a different start-time), with a random
 * per-process nonce as a fallback on hosts without procfs.
 *
 * A stored lockfile is treated as a GENUINE LIVE SIBLING — and start is
 * refused — only when ALL of:
 *   1. the stored PID is alive, AND
 *   2. the stored PID is NOT our own PID, AND
 *   3. the stored identity token still matches the LIVE process's CURRENT
 *      identity token (so the PID wasn't reused by an unrelated process).
 *
 * Everything else (dead PID, self-PID, mismatched token = reused PID,
 * garbage / legacy bare-PID file we can't verify against a live token) is
 * treated as STALE and reclaimed. This benefits PROD restarts too: a
 * graceful shutdown removes the lockfile, but a hard kill leaves it — and
 * the next boot reclaims it instead of self-deadlocking.
 */

const STARTTIME_UNAVAILABLE = "";

/**
 * Per-process random nonce, generated once at module load. Used as the
 * identity token on hosts where `/proc/<pid>/stat` is unavailable
 * (non-Linux, or a locked-down procfs). Two distinct processes get
 * distinct nonces, so a reused PID from a prior boot never matches.
 */
const PROCESS_NONCE = `n-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

/**
 * Read a process's start-time from `/proc/<pid>/stat` (Linux). This is the
 * 22nd whitespace-delimited field, counted AFTER the `(comm)` group — comm
 * can contain spaces/parens, so we split on the last `)`. Returns
 * `STARTTIME_UNAVAILABLE` on any failure (non-Linux, dead PID, permission).
 *
 * Synchronous on purpose: it's read inside the acquire path and the file
 * is a tiny procfs pseudo-file.
 */
export function readProcStartTime(pid: number): string {
  if (!Number.isFinite(pid) || pid <= 0) return STARTTIME_UNAVAILABLE;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after `(comm)`: split on the final ")" so a comm like
    // "(vi te)" can't shift the field index.
    const afterComm = raw.slice(raw.lastIndexOf(")") + 1).trim();
    const fields = afterComm.split(/\s+/);
    // After the ")" the first field is `state`, so field 22 of the full
    // line (1-indexed: pid, comm, state, ...) is index 19 here.
    const starttime = fields[19];
    return starttime ?? STARTTIME_UNAVAILABLE;
  } catch {
    return STARTTIME_UNAVAILABLE;
  }
}

/** Returns true when the process for `pid` exists on this host. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM ⇒ the process exists but is owned by another user.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * The identity token for THIS process — `<starttime>` from procfs when
 * available, else the per-boot random nonce. Written into the lockfile so a
 * later boot can tell "still the same live owner" from "PID reused".
 */
export function selfToken(): string {
  const st = readProcStartTime(process.pid);
  return st !== STARTTIME_UNAVAILABLE ? st : PROCESS_NONCE;
}

interface ParsedLock {
  pid: number;
  /** Identity token, or "" for a legacy bare-PID lockfile. */
  token: string;
}

/** Parse a lockfile body. Format: `<pid>` (legacy) or `<pid> <token>`. */
export function parseLock(text: string): ParsedLock | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const [pidStr, ...rest] = trimmed.split(/\s+/);
  const pid = parseInt(pidStr ?? "", 10);
  if (!Number.isFinite(pid)) return null;
  return { pid, token: rest.join(" ") };
}

/**
 * Decide whether a parsed lockfile represents a genuine live sibling whose
 * start MUST be refused. Pure + injectable for testing.
 *
 * @param lock      Parsed stored lockfile (pid + token).
 * @param selfPid   The current process PID.
 * @param self      The current process identity token.
 * @param alive     `(pid) => boolean` — is that PID alive on this host.
 * @param liveToken `(pid) => string` — the CURRENT identity token of that
 *                  live PID (recomputed from procfs). Used to detect PID
 *                  reuse: a reused PID's live token won't match the stored
 *                  token.
 */
export function isLiveSibling(
  lock: ParsedLock,
  selfPid: number,
  self: string,
  alive: (pid: number) => boolean,
  liveToken: (pid: number) => string,
): boolean {
  // Dead PID ⇒ stale, reclaim.
  if (!alive(lock.pid)) return false;
  // Our own PID ⇒ same process (double-wire) or a reused-self PID from a
  // prior boot. Either way NOT a foreign sibling — reclaim. (Same-process
  // double-wiring is already guarded by the daemon's `this.timer` check.)
  if (lock.pid === selfPid) return false;

  // Legacy bare-PID lockfile (no token). A genuine concurrent sibling
  // running THIS code always stamps a token, so a tokenless file is
  // necessarily from old code or a prior boot whose PID has since been
  // reused (the cross-restart self-deadlock the token fixes). We can't
  // assert a live sibling here, and a graceful shutdown always removes the
  // lockfile — so a surviving tokenless file is reclaimable. (Marking `self`
  // as read so the signature documents the caller's identity input.)
  void self;
  if (lock.token === "") return false;

  // Tokenized lockfile: a genuine sibling iff the stored token still matches
  // the live process's CURRENT identity (PID not reused). If the live token
  // can't be recomputed (procfs gone) we can't confirm a match, so we
  // reclaim rather than wedge — the new boot re-stamps a fresh token.
  const current = liveToken(lock.pid);
  if (current === STARTTIME_UNAVAILABLE) return false;
  return lock.token === current;
}

async function ensureDir(path: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  if (dir && dir !== ".") await fs.mkdir(dir, { recursive: true });
}

/**
 * Acquire the lockfile at `path`. Returns true on success (and stamps
 * `<pid> <token>`), false when a genuine live sibling owns it.
 *
 * PID-reuse-safe: a stale lockfile left by a prior boot (dead PID, reused
 * PID, or our own reused PID) is reclaimed instead of wedging start.
 */
export async function acquireLockfile(path: string): Promise<boolean> {
  await ensureDir(path);
  const file = Bun.file(path);
  if (await file.exists()) {
    const parsed = parseLock(await file.text());
    if (
      parsed &&
      isLiveSibling(parsed, process.pid, selfToken(), isProcessAlive, readProcStartTime)
    ) {
      return false;
    }
    // Dead / reused / self / garbage ⇒ stale; fall through and overwrite.
  }
  await Bun.write(path, `${process.pid} ${selfToken()}`);
  return true;
}

export async function releaseLockfile(path: string): Promise<void> {
  try {
    const fs = await import("node:fs/promises");
    await fs.unlink(path);
  } catch {
    // Already gone — fine.
  }
}

export const _processLockfileInternals = {
  STARTTIME_UNAVAILABLE,
  PROCESS_NONCE,
};
