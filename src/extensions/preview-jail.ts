/**
 * Filesystem jail bind-set builder for untrusted preview processes
 * (Secure User-Site Preview / Port Exposure, Phase 1 — see
 * tasks/preview-port-exposure.md §3.1 + the threat-model row "Untrusted
 * server reads .ezcorp/data off disk").
 *
 * ── Why this exists ──
 * The original MCP jail (`mcp-launcher.sh`) exec'd `bwrap --bind / /`:
 * the child saw the WHOLE host filesystem, including
 * `<projectRoot>/.ezcorp/data` (the PGlite DB + the encrypted JWT
 * secret). A DYNAMIC preview is an arbitrary dev server — raw, untrusted
 * code. With `--bind / /` it can read the DB + secret directly. That
 * hole MUST be closed before any dynamic server runs. MCP servers are
 * the SAME threat class (arbitrary external binaries — the SDK
 * module-poisoning does NOT apply to them), so the CRITICAL MCP
 * filesystem-confinement fix reuses this builder: see
 * `buildMcpJailBwrapArgs` below + `mcp-sandbox.ts`'s strict
 * (EZCORP_MCP_REQUIRE_SANDBOX=1) leg, and the always-on
 * `EZCORP_MCP_DATA_DIR` tmpfs mask in the launcher's default branch.
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
import { realpathSync } from "node:fs";

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
  /** Omit the `--size` cap on the private `/tmp` tmpfs. Required on hosts
   *  whose `bwrap` is the SETUID-root wrapper (e.g. NixOS, where
   *  unprivileged user namespaces are disabled at the sysctl level so
   *  bwrap must run setuid): in setuid mode bwrap REFUSES `--size`
   *  ("The --size option is not permitted in setuid mode") and aborts the
   *  whole jail. Dropping `--size` keeps every security-relevant bind /
   *  namespace flag intact — it only forfeits the tmpfs size CAP (a
   *  defense-in-depth DoS guard; the real memory bound is the prlimit
   *  `--rss` on the inner command). Without it, `/tmp` falls back to
   *  bwrap's default (half of RAM). */
  omitTmpfsSize?: boolean;
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
 * Canonicalize a host path with `realpath` (mirrors the double-realpath
 * approach in `preview-proxy.ts`) so the data-dir exclusion compares
 * REAL paths, not lexical strings. A `workDir` that is a symlink (or has
 * a symlinked ancestor) pointing into `.ezcorp/data` defeats the lexical
 * `resolve()`-prefix check — bwrap would then `--bind` the real target,
 * exposing the DB/secret inside the jail. Resolving the link first closes
 * that escape.
 *
 * Fail CLOSED: if the path does not exist (so its real target can't be
 * known), throw rather than silently binding an unverified path. The
 * launcher is expected to create the work dir before building the argv.
 */
export function canonicalizeJailPath(path: string, label: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    throw new Error(
      `preview jail: ${label} does not exist or is not resolvable (fail-closed): ${path}`,
    );
  }
}

/** Options that differentiate the PREVIEW jail from the MCP jail. */
interface JailVariantOptions {
  /** Preview servers get `--unshare-all` (fresh net/ipc/pid/uts/cgroup
   *  namespaces). MCP jails MUST NOT: the MCP reaches its per-instance
   *  forward proxy on HOST loopback (so no `--unshare-net` — Phase 7
   *  fix-pass C2), and the seccomp soak reader matches journalctl
   *  `pid=` rows against the HOST PID namespace (so no `--unshare-pid`
   *  — Plan 55 Pitfall 3). The outer `unshare -U -m --map-root-user`
   *  already provides the user+mount namespaces for both variants. */
  unshareAll: boolean;
  /** Directories created (`--dir`) inside the jail AFTER the private
   *  /tmp tmpfs is mounted. Each MUST live under /tmp — anywhere else
   *  the mkdir would write through a host bind. Used to re-create the
   *  per-extension TMPDIR that the tmpfs swap hides. */
  tmpDirs?: readonly string[];
}

/**
 * Shared bind-set core for both jail variants. PURE — returns the full
 * argument vector (excluding the leading `bwrap`); the caller / launcher
 * prepends `bwrap` and execs.
 *
 * Invariants (also asserted by tests):
 *   - NO `--bind / /` ever appears.
 *   - The work dir is the only `--bind` (rw); everything else is
 *     `--ro-bind` or tmpfs.
 *   - No bound path is the data dir, under it, or an ancestor of it.
 *   - `--die-with-parent` so the child can't outlive the host process.
 *   - `--new-session` to defend against TIOCSTI terminal injection.
 */
function buildJailArgsCore(
  input: PreviewJailInput,
  variant: JailVariantOptions,
): string[] {
  if (!input.workDir) throw new Error("preview jail: workDir is required");
  if (!input.projectRoot) throw new Error("preview jail: projectRoot is required");
  if (!input.command) throw new Error("preview jail: command is required");

  // Canonicalize via realpath BEFORE the exclusion assertion: a symlinked
  // workDir (or a symlinked ancestor) pointing into `.ezcorp/data` would
  // pass the lexical prefix check yet bind the real DB/secret dir. Resolve
  // the link first, then assert on the REAL path. Fails closed if missing.
  const workDir = canonicalizeJailPath(input.workDir, "workDir");
  assertOutsideDataDir(workDir, input.projectRoot);

  const inputRoDirs = input.roSystemDirs ?? DEFAULT_RO_SYSTEM_DIRS;
  // Defense-in-depth: canonicalize each RO dir too (fail-closed if a dir
  // doesn't exist) and refuse any that overlaps the data dir after the
  // symlink is resolved.
  const roDirs = inputRoDirs.map((d) => canonicalizeJailPath(d, "roSystemDir"));
  for (const d of roDirs) assertOutsideDataDir(d, input.projectRoot);

  const args: string[] = [
    ...(variant.unshareAll ? ["--unshare-all"] : []),
    "--die-with-parent",
    "--new-session",
    "--proc", "/proc",
    "--dev", "/dev",
    // Private tmpfs at /tmp. `--size` MUST precede `--tmpfs` (bwrap is a
    // sequential state machine; reversal silently drops the cap). On a
    // setuid-root bwrap (`omitTmpfsSize`) the `--size` flag is rejected
    // and aborts the jail, so emit a bare `--tmpfs /tmp` (default size)
    // instead — every other confinement flag is unchanged.
    ...(input.omitTmpfsSize
      ? (["--tmpfs", "/tmp"] as const)
      : ([
          "--size",
          String(input.tmpfsBytes ?? DEFAULT_TMPFS_BYTES),
          "--tmpfs",
          "/tmp",
        ] as const)),
  ];

  // `--dir` mkdirs inside the jail — AFTER the /tmp tmpfs so each target
  // lands on the private tmpfs, never on a host bind. Fail CLOSED on any
  // path that is not strictly under /tmp.
  for (const d of variant.tmpDirs ?? []) {
    const abs = resolve(d);
    if (!abs.startsWith("/tmp" + sep)) {
      throw new Error(
        `preview jail: --dir target must live under the private /tmp tmpfs: ${d}`,
      );
    }
    args.push("--dir", abs);
  }

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
 * Build the bwrap argv for an untrusted preview process (dynamic dev
 * server). Adds `--unshare-all` on top of the shared core: previews
 * don't need the host network namespace, so they get fresh
 * net/ipc/pid/uts/cgroup namespaces too.
 */
export function buildPreviewJailBwrapArgs(input: PreviewJailInput): string[] {
  return buildJailArgsCore(input, { unshareAll: true });
}

export interface McpJailInput extends PreviewJailInput {
  /** Dirs re-created (`--dir`) inside the private /tmp tmpfs — used for
   *  the per-extension TMPDIR (`/tmp/ezcorp-ext/<id>`) that the tmpfs
   *  swap hides. Each MUST be under /tmp (fail-closed otherwise). */
  tmpDirs?: readonly string[];
}

/**
 * Build the bwrap argv for an UNTRUSTED stdio MCP server — the CRITICAL
 * filesystem-confinement fix replacing the launcher's `--bind / /`
 * envelope (which exposed the PGlite DB + JWT secret, `~/.ssh`, `.env`,
 * … to arbitrary external MCP binaries).
 *
 * Identical minimal bind set to the preview jail (ONE rw work dir,
 * ro-bind system dirs, private tmpfs /tmp, NOTHING under `.ezcorp/data`),
 * with two MCP-specific differences:
 *   - NO `--unshare-all`: the MCP must share the HOST network namespace
 *     to reach its loopback forward proxy (Phase 7 fix-pass C2) and the
 *     HOST PID namespace so the seccomp soak reader's journalctl `pid=`
 *     filter matches (Plan 55 Pitfall 3). User+mount isolation comes
 *     from the launcher's outer `unshare -U -m --map-root-user`.
 *   - optional `tmpDirs` re-created inside the fresh /tmp tmpfs.
 *
 * Consumed by `mcp-sandbox.ts` under EZCORP_MCP_REQUIRE_SANDBOX=1; the
 * launcher execs the result verbatim via its EZCORP_MCP_FS_JAIL=1
 * branch (same exec-verbatim contract as EZCORP_PREVIEW_JAIL).
 */
export function buildMcpJailBwrapArgs(input: McpJailInput): string[] {
  const { tmpDirs, ...rest } = input;
  return buildJailArgsCore(rest, { unshareAll: false, tmpDirs });
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
