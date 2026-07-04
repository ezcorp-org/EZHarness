/**
 * Cross-process guard for the embedded PGlite data directory.
 *
 * PGlite is single-writer: two processes opening the same datadir do NOT
 * share state — each gets its own WASM Postgres over the same files, so
 * writes from one are invisible to the other and page-level interleaving
 * can corrupt the directory. PGlite's own `postmaster.pid` cannot arbitrate
 * this because it records a fake pid (`-42`), which is exactly why
 * `initPglite()` clears it as "stale" on every boot — including, before
 * this guard existed, when the file belonged to a LIVE server (e.g.
 * `ezcorp key mint` run via `docker exec` against a running container).
 *
 * The guard is a sidecar pidfile at `<dbPath>.ezcorp.pid` (a SIBLING of the
 * datadir, so datadir snapshots/renames in `connection.ts` never copy or
 * move it) holding the real OS pid of the process that opened the DB.
 * Liveness is checked with `kill(pid, 0)`; a dead pid means an unclean
 * shutdown (SIGKILL) and is treated as stale — no operator action needed.
 * This is a fail-loud guard, not a mutex: a boot-vs-boot race is still
 * possible, but the common corruption path (CLI vs live server) is closed.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";

export class DbInUseError extends Error {
  constructor(dbPath: string, pid: number) {
    super(
      `The EZCorp database at ${dbPath} is open in another EZCorp process (pid ${pid}). ` +
        `PGlite is single-writer — concurrent access corrupts the data directory and writes ` +
        `made here would be invisible to the running server. ` +
        `Stop the server first, or perform this action through it ` +
        `(API keys: Settings → Developer → API keys, or POST /api/settings/developer/api-keys ` +
        `with an admin session). If you are certain no other EZCorp process is running, ` +
        `delete ${holderPidPath(dbPath)} and retry.`,
    );
    this.name = "DbInUseError";
  }
}

/** Sidecar pidfile path for a PGlite data directory. */
export function holderPidPath(dbPath: string): string {
  return `${dbPath}.ezcorp.pid`;
}

/** True when `pid` refers to a live process. `kill(pid, 0)` sends no
 *  signal; EPERM means "alive but not ours" and counts as alive. */
function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Pid-recycling defense: a claim is only treated as LIVE when the pid is
 * alive AND (on Linux) its `/proc/<pid>/cmdline` looks like a JS-runtime
 * process — EZCorp only ever runs under bun or node (`vite preview`/`dev`
 * run vite's own node binary even when launched via `bunx --bun`), so any
 * other cmdline means the pid was recycled by an unrelated process after a
 * container restart, and refusing to boot over it would crash-loop the
 * server. When cmdline can't be read (non-Linux, hidepid, EPERM) we stay
 * CONSERVATIVE and treat the holder as live — a false refusal has a
 * documented remediation, silent datadir corruption does not.
 * `procRoot` is injectable for tests only.
 */
export function isLiveHolder(pid: number, procRoot = "/proc"): boolean {
  if (!pidIsAlive(pid)) return false;
  try {
    const cmdline = readFileSync(`${procRoot}/${pid}/cmdline`, "utf8");
    return ["bun", "node", "ezcorp"].some((needle) => cmdline.includes(needle));
  } catch {
    return true; // can't inspect — conservative: assume it's a real holder
  }
}

/** The pid recorded in the sidecar file, or null when absent/unreadable. */
export function readHolderPid(dbPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(holderPidPath(dbPath), "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Throw `DbInUseError` when another LIVE process holds the datadir.
 * A missing/unparseable pidfile, a dead pid (unclean shutdown), or our own
 * pid (re-init in the same process) all pass.
 */
export function assertNoLiveHolder(dbPath: string): void {
  const pid = readHolderPid(dbPath);
  if (pid !== null && pid !== process.pid && isLiveHolder(pid)) {
    throw new DbInUseError(dbPath, pid);
  }
}

/** Record this process as the datadir holder. Best-effort: a write failure
 *  (read-only parent) must not block boot — the guard degrades to the
 *  pre-guard behavior instead of taking the DB down. */
export function claimHolder(dbPath: string): void {
  try {
    writeFileSync(holderPidPath(dbPath), String(process.pid));
  } catch {
    /* degrade silently — see docstring */
  }
}

/** Drop the claim if it is ours (used by `closeDb()`); never someone else's. */
export function releaseHolder(dbPath: string): void {
  if (readHolderPid(dbPath) !== process.pid) return;
  try {
    rmSync(holderPidPath(dbPath));
  } catch {
    /* already gone / unwritable parent — nothing to release */
  }
}
