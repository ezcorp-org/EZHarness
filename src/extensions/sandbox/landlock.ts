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

import { resolve } from "node:path";
import { assertOutsideDataDir } from "../preview-jail";
import { applyReadOnlyJail, landlockAbiVersion } from "./landlock-ffi";

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
}

/**
 * A fully-resolved, serializable Landlock jail spec. The shim reconstructs
 * it from JSON (via env) and feeds it to `applyLandlockJailSpec`.
 *
 * NOTE: ABI v1 path-beneath rules cannot express "read-only vs read-write"
 * per-path beyond the access-bit subset; the A1 FFI helper grants the
 * read/exec subset on every allowlisted path. We still track `rw` vs `ro`
 * separately so a future ABI-aware builder (write access on rw paths only)
 * is a drop-in upgrade — and so the deny assertions cover BOTH sets today.
 */
export interface LandlockJailSpec {
  /** Read-only allowlist (system dirs + extra ro paths). */
  ro: string[];
  /** Read-write allowlist (the workspace + extra rw paths). */
  rw: string[];
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

  // Deny-by-default invariant: the DB/secret dir must NEVER be reachable
  // through ANY granted path (rw or ro). Reuses the single source of truth
  // from preview-jail.ts.
  for (const p of [...rw, ...ro]) {
    assertOutsideDataDir(p, input.projectRoot);
  }

  return { ro, rw };
}

/**
 * Apply a built jail spec to the CURRENT process. Read/exec is granted on
 * the union of ro+rw; everything else loses access. Throws if Landlock is
 * unsupported here (fail-closed — the caller must have tier-gated first).
 *
 * Used by the pre-exec shim AFTER it has parsed the spec and BEFORE it
 * execs the inner command.
 */
export function applyLandlockJailSpec(spec: LandlockJailSpec): void {
  const abi = landlockAbiVersion();
  if (abi < 1) {
    throw new Error(`landlock: not supported here (ABI=${abi})`);
  }
  // The A1 FFI helper grants the read/exec subset on each path and skips
  // non-existent entries (distro-portable). rw paths are included so the
  // workspace stays reachable; write access itself is governed by ordinary
  // file permissions until an ABI-aware write-grant lands.
  applyReadOnlyJail([...spec.rw, ...spec.ro], abi);
}
