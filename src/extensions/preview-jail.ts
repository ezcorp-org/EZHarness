/**
 * Filesystem jail bind-set builder for untrusted preview processes
 * (Secure User-Site Preview / Port Exposure, Phase 1 — see
 * tasks/preview-port-exposure.md §3.1 + the threat-model row "Untrusted
 * server reads .ezcorp/data off disk").
 *
 * ── Why this exists ──
 * The existing MCP jail (`mcp-launcher.sh`) execs `bwrap --bind / /`:
 * the child sees the WHOLE host filesystem, including
 * `<projectRoot>/.ezcorp/data` (the PGlite DB + the encrypted JWT
 * secret). For MCP servers that is tolerated because they are
 * semi-trusted tools gated by the SDK preload + per-host proxy. But a
 * DYNAMIC preview is an arbitrary dev server — raw, untrusted code. With
 * `--bind / /` it can read the DB + secret directly. That hole MUST be
 * closed before any dynamic server runs.
 *
 * This module builds an EXPLICIT MINIMAL bind set instead:
 *   - the conversation's work dir (rw) — the only writable host path,
 *   - read-only system dirs needed to exec a runtime (/usr, /bin, /lib,
 *     /lib64, /etc — only those present on the host),
 *   - a private tmpfs at /tmp,
 *   - /proc + /dev,
 *   - NO `--bind / /`,
 *   - NOTHING under `.ezcorp/data` (asserted by the builder + tests).
 *
 * It is a PURE function (returns the argv) so it is fully unit-tested
 * without spawning bwrap. The launcher consumes the same flag set via a
 * new `EZCORP_PREVIEW_JAIL=1` branch (DRY: it EXTENDS the existing
 * launcher, it does not fork it). Wiring a live dynamic-server spawn
 * through this jail is Phase 3 — Phase 1 lands the builder + launcher
 * branch + tests so the containment is reviewable and locked in.
 */

import { resolve, sep } from "node:path";

export interface PreviewJailInput {
  /** The conversation's writable work dir (e.g. a per-conv tmp workdir
   *  or `.ezcorp/sites/<convId>/`). Bound rw — the ONLY writable host
   *  path the child gets. */
  workDir: string;
  /** Project root, used ONLY to compute the forbidden `.ezcorp/data`
   *  path for the invariant assertion. */
  projectRoot: string;
  /** Read-only system dirs to bind. Caller passes the subset that exists
   *  on the host (probed via `existsSync`); the builder binds each `--ro-bind`.
   *  Defaults to the conventional Linux set. */
  roSystemDirs?: readonly string[];
  /** tmpfs size in bytes for /tmp. Default 64 MiB (matches the MCP jail). */
  tmpfsBytes?: number;
  /** Optional seccomp FD index (the launcher passes the BPF blob on this
   *  FD). When set, `--seccomp <fd>` is appended. */
  seccompFd?: number | null;
  /** The inner command + args to exec inside the jail. */
  command: string;
  args?: readonly string[];
}

/** The default RO system dirs a typical Linux runtime needs to exec. The
 *  caller filters to those that actually exist before passing them in. */
export const DEFAULT_RO_SYSTEM_DIRS: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc",
];

const DEFAULT_TMPFS_BYTES = 64 * 1024 * 1024;

/**
 * Compute the absolute, normalized `.ezcorp/data` path that MUST NOT be
 * reachable from inside the jail.
 */
export function forbiddenDataDir(projectRoot: string): string {
  return resolve(projectRoot, ".ezcorp", "data");
}

/**
 * Assert that a host path is NOT inside (and is not an ancestor of) the
 * forbidden `.ezcorp/data` dir. Throws if it is. Used by the builder to
 * fail CLOSED if a caller ever tries to bind a path that would expose
 * the DB/secret — a defense against a future refactor re-opening the hole.
 */
export function assertOutsideDataDir(path: string, projectRoot: string): void {
  const forbidden = forbiddenDataDir(projectRoot);
  const abs = resolve(path);
  // `abs` is forbidden if it IS the data dir, is UNDER it, or is an
  // ANCESTOR of it (binding `/` or the project root would re-expose it).
  if (abs === forbidden) {
    throw new Error(`preview jail: refusing to bind the forbidden data dir: ${abs}`);
  }
  if (abs.startsWith(forbidden + sep)) {
    throw new Error(`preview jail: refusing to bind a path under the data dir: ${abs}`);
  }
  if (forbidden.startsWith(abs + sep) || abs === sep) {
    throw new Error(
      `preview jail: refusing to bind an ancestor of the data dir (would expose it): ${abs}`,
    );
  }
}

/**
 * Build the bwrap argv for an untrusted preview process. PURE — returns
 * the full argument vector (excluding the leading `bwrap`); the caller /
 * launcher prepends `bwrap` and execs.
 *
 * Invariants (also asserted by tests):
 *   - NO `--bind / /` ever appears.
 *   - The work dir is the only `--bind` (rw); everything else is
 *     `--ro-bind` or tmpfs.
 *   - No bound path is the data dir, under it, or an ancestor of it.
 *   - `--unshare-all` drops the child into fresh namespaces; the outer
 *     `unshare -U -m` (launcher) already created the user+mount ns, but
 *     `--unshare-all` here additionally isolates ipc/pid/uts/cgroup.
 *   - `--die-with-parent` so the child can't outlive the host process.
 *   - `--new-session` to defend against TIOCSTI terminal injection.
 */
export function buildPreviewJailBwrapArgs(input: PreviewJailInput): string[] {
  if (!input.workDir) throw new Error("preview jail: workDir is required");
  if (!input.projectRoot) throw new Error("preview jail: projectRoot is required");
  if (!input.command) throw new Error("preview jail: command is required");

  const workDir = resolve(input.workDir);
  // Fail closed if the work dir would expose the data dir.
  assertOutsideDataDir(workDir, input.projectRoot);

  const roDirs = input.roSystemDirs ?? DEFAULT_RO_SYSTEM_DIRS;
  // Defense-in-depth: refuse any RO dir that overlaps the data dir.
  for (const d of roDirs) assertOutsideDataDir(d, input.projectRoot);

  const args: string[] = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--proc", "/proc",
    "--dev", "/dev",
    // Private tmpfs at /tmp — `--size` MUST precede `--tmpfs` (bwrap is a
    // sequential state machine; reversal silently drops the cap).
    "--size", String(input.tmpfsBytes ?? DEFAULT_TMPFS_BYTES),
    "--tmpfs", "/tmp",
  ];

  // Read-only system dirs.
  for (const d of roDirs) {
    args.push("--ro-bind", d, d);
  }

  // The single writable bind: the conversation work dir.
  args.push("--bind", workDir, workDir);
  // chdir into it so relative paths resolve there.
  args.push("--chdir", workDir);

  if (input.seccompFd != null) {
    args.push("--seccomp", String(input.seccompFd));
  }

  args.push("--", input.command, ...(input.args ?? []));
  return args;
}

/**
 * Assert (for tests + as a runtime guard) that a built argv NEVER
 * contains the catch-all `--bind / /` and exposes nothing under the data
 * dir. Returns the argv unchanged on success; throws otherwise.
 */
export function assertJailArgsSafe(args: readonly string[], projectRoot: string): readonly string[] {
  const forbidden = forbiddenDataDir(projectRoot);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--bind" || a === "--ro-bind") && args[i + 1] === "/" ) {
      throw new Error("preview jail: argv contains a root bind ('/') — hole not closed");
    }
    if (a === "--bind" || a === "--ro-bind") {
      const src = args[i + 1];
      if (src && (src === forbidden || src.startsWith(forbidden + sep))) {
        throw new Error(`preview jail: argv binds the forbidden data dir: ${src}`);
      }
    }
  }
  return args;
}
