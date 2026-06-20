/**
 * Landlock ruleset/jail-spec builder (Phase A2).
 *
 * Landlock is a PER-PROCESS LSM applied via an in-process syscall sequence,
 * NOT an argv prefix like bwrap (see Phase A1 findings). So the durable seam
 * is a two-part design:
 *
 *   1. `buildLandlockJailSpec(...)` — a PURE function that resolves the
 *      read-only / read-write allowlist for a run, asserts deny-by-default
 *      and that nothing under `.ezcorp/data` is ever granted, and returns a
 *      serializable `LandlockJailSpec`.
 *   2. `applyLandlockJailSpec(spec)` — applies that spec to the CURRENT
 *      process via the A1 FFI helpers (`applyReadOnlyJail`). Invoked by the
 *      pre-exec shim (`landlock-shim.ts`) which `buildSandboxArgv` prepends
 *      on the `landlock` tier.
 *
 * The forbidden-path invariant reuses `preview-jail.ts`'s `assertOutsideDataDir`
 * (DRY — one definition of "never expose the DB/secret dir").
 */

import { resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { assertOutsideDataDir, forbiddenDataDir } from "../preview-jail";
import { applyReadWriteJail, landlockAbiVersion } from "./landlock-ffi";

/**
 * Canonicalize a grant path to its REAL location (following symlinks) before
 * it is checked against the data-dir invariant. A lexical `resolve()` alone is
 * NOT enough: Landlock rules bind the kernel inode, so a symlink whose target
 * is `.ezcorp/data` would pass a lexical `assertOutsideDataDir` yet have the
 * kernel grant the real data-dir inode (a READ leak of the DB + JWT secret).
 * Realpath-resolving here closes that — parity with the bwrap tier's
 * `canonicalizeJailPath`. A path that does not exist yet cannot be a symlink
 * into the data dir (and the kernel cannot grant a non-existent inode), so we
 * fall back to the lexical resolve rather than fail-closed — keeping the tier's
 * tolerance for distro-absent runtime RO dirs (e.g. `/lib64`, `/nix`).
 */
function canonicalizeForJail(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Conventional read-only system dirs a runtime needs to exec. The shim
 *  skips any that don't exist on the host (distro-portable). `/nix` covers
 *  the NixOS dev host; it's a no-op in the Debian container. */
export const DEFAULT_RUNTIME_RO_DIRS: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc",
  "/proc",
  "/dev",
  "/nix",
];

export interface LandlockJailInput {
  /** The single writable workspace dir for the run (rw). */
  workspaceDir: string;
  /** Project root — used ONLY to compute the forbidden `.ezcorp/data` path
   *  for the deny invariant. */
  projectRoot: string;
  /** Extra read-only paths (runtime libs, caches). Each is asserted to be
   *  outside `.ezcorp/data`. Defaults to the conventional runtime RO set. */
  roPaths?: readonly string[];
  /** Extra read-write paths beyond the workspace (e.g. a private TMPDIR).
   *  Each is asserted to be outside `.ezcorp/data`. */
  rwPaths?: readonly string[];
  /** "Root" paths granted READ-ONLY, EXEMPT from the data-dir-ancestor
   *  assertion. Used for a git repo root that CONTAINS `.ezcorp/data`: git
   *  must read/scan the whole working tree, so the root is read-only (the
   *  jailed process therefore cannot WRITE under `.ezcorp/data`). Landlock is
   *  additive, so rw children add write to their subtree while the ungranted
   *  `.ezcorp/data` stays read-only (write denied). A list path may BE an
   *  ancestor of `.ezcorp/data` (that's the point) but must not be the data
   *  dir or under it. */
  listPaths?: readonly string[];
}

/**
 * A fully-resolved, serializable Landlock jail spec. The shim reconstructs
 * it from JSON (via env) and feeds it to `applyLandlockJailSpec`.
 *
 * The `rw` and `ro` sets are enforced DIFFERENTLY at apply time: `rw` paths
 * receive a write-inclusive access grant (read/exec/write/make/remove/
 * truncate, masked to the kernel ABI) so a jailed process can edit files
 * and run git inside its workspace; `ro` paths receive read/exec only.
 * Every path in neither set loses all access. Landlock's path-beneath rules
 * support this per-path distinction via the granted access bitmask.
 */
export interface LandlockJailSpec {
  /** Read-only allowlist (system dirs + extra ro paths). */
  ro: string[];
  /** Read-write allowlist (the workspace + extra rw paths). */
  rw: string[];
  /** Read-only "root" allowlist (data-dir-ancestor-exempt). Optional —
   *  absent on the common case; present for the git-repo-root jail. */
  list?: string[];
}

/**
 * PURE builder. Resolves + canonicalizes the allowlist, asserts:
 *   - a workspace dir is present (deny-by-default has something to allow),
 *   - NO granted path is `.ezcorp/data`, under it, or an ancestor of it.
 * Returns the serializable spec. Throws (fail-closed) on any violation.
 */
export function buildLandlockJailSpec(input: LandlockJailInput): LandlockJailSpec {
  if (!input.workspaceDir) {
    throw new Error("landlock: workspaceDir is required");
  }
  if (!input.projectRoot) {
    throw new Error("landlock: projectRoot is required");
  }

  const rwInputs = [input.workspaceDir, ...(input.rwPaths ?? [])];
  const roInputs = input.roPaths ?? DEFAULT_RUNTIME_RO_DIRS;

  const rw = rwInputs.map((p) => resolve(p));
  const ro = roInputs.map((p) => resolve(p));
  const list = (input.listPaths ?? []).map((p) => resolve(p));

  // Deny-by-default invariant: the DB/secret dir must NEVER be reachable for
  // READ or WRITE through any rw/ro grant. List-only paths are EXEMPT from
  // the ancestor check (a repo root that contains `.ezcorp/data` is the whole
  // point — list-only grants traverse, NOT file-read, so the DB stays
  // unreadable), but a list path must not itself BE the data dir or under it.
  //
  // The assertions run against the REAL (symlink-resolved) path via
  // `canonicalizeForJail`: Landlock binds the kernel inode, so a grant that is
  // a symlink whose target is `.ezcorp/data` would pass a purely-lexical check
  // yet have the kernel grant the real data-dir inode. We keep the GRANT
  // lexical (the kernel resolves to the same inode at rule-add time, and we've
  // proven that inode is outside the data dir) so legitimate system-dir grants
  // are byte-for-byte unchanged.
  for (const p of [...rw, ...ro]) {
    assertOutsideDataDir(canonicalizeForJail(p), input.projectRoot);
  }
  for (const p of list) {
    assertListPathNotInsideDataDir(canonicalizeForJail(p), input.projectRoot);
  }

  return { ro, rw, ...(list.length > 0 ? { list } : {}) };
}

/** A list-only path may be an ANCESTOR of `.ezcorp/data` (intended) but must
 *  not BE the data dir or live UNDER it. */
function assertListPathNotInsideDataDir(path: string, projectRoot: string): void {
  const forbidden = forbiddenDataDir(projectRoot);
  const abs = resolve(path);
  if (abs === forbidden || abs.startsWith(forbidden + sep)) {
    throw new Error(
      `landlock: refusing a list path that IS or is UNDER the data dir: ${abs}`,
    );
  }
}

/**
 * Apply a built jail spec to the CURRENT process. `spec.rw` paths get a
 * WRITE-inclusive grant (read/exec/write/make/remove/truncate, masked to
 * the kernel ABI) so the jailed process can edit files + run git in its
 * workspace; `spec.ro` paths get read/exec only. Everything else loses all
 * access. Throws if Landlock is unsupported here (fail-closed — the caller
 * must have tier-gated first).
 *
 * Landlock ENFORCES every access in the handled set: a handled-but-ungranted
 * access is DENIED (it is NOT governed by ordinary file permissions). So the
 * rw/ro distinction is load-bearing — granting only READ on the workspace
 * would make every write EACCES.
 *
 * Used by the pre-exec shim AFTER it has parsed the spec and BEFORE it
 * execs the inner command.
 */
export function applyLandlockJailSpec(spec: LandlockJailSpec): void {
  const abi = landlockAbiVersion();
  if (abi < 1) {
    throw new Error(`landlock: not supported here (ABI=${abi})`);
  }
  // Distro-portable: the FFI helper skips non-existent allow paths.
  applyReadWriteJail(spec.rw, spec.ro, abi, spec.list ?? []);
}
