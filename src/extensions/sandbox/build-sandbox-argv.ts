/**
 * `buildSandboxArgv` — the single DRY isolation seam (Phase A2).
 *
 * Every spawn site (MCP — Seam C, extension subprocess — Seam A, per-run
 * agent shell — Seam B) wraps its inner command through this builder, which
 * emits a tier-appropriate argv that prepends isolation in front of the
 * inner `command + args`:
 *
 *   - "bwrap"    → a bwrap argv prefix (reuses preview-jail.ts's minimal
 *                  bind-set builder — ONE rw workspace, ro-bind system dirs,
 *                  private /tmp, NOTHING under .ezcorp/data). Adds /proc +
 *                  PID hiding on top of the fs jail.
 *   - "landlock" → `bun <landlock-shim> -- <inner...>` with the jail spec in
 *                  the EZCORP_LANDLOCK_SPEC env var. Landlock is per-process,
 *                  so the shim applies it in-process then execs the inner
 *                  command (which inherits the restrictions). This is the
 *                  tier that works inside the Docker app container (Phase A1).
 *   - "advisory" → no OS isolation prefix (the documented status-quo: SDK
 *                  module-poisoning only). The inner command runs as-is.
 *
 * DENY-BY-DEFAULT, always: every tier asserts that no granted path is
 * `.ezcorp/data`, under it, or an ancestor of it (the leak the whole effort
 * closes). The bwrap leg delegates to preview-jail's assertions; the
 * landlock leg delegates to `buildLandlockJailSpec`.
 *
 * The builder returns BOTH the argv and the env additions a spawn site must
 * merge in (the landlock tier needs EZCORP_LANDLOCK_SPEC). Pure + fully
 * unit-tested — no spawning.
 */

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { SandboxTier } from "./capability-probe";
import {
  buildLandlockJailSpec,
  DEFAULT_RUNTIME_RO_DIRS,
  type LandlockJailSpec,
} from "./landlock";
import { LANDLOCK_SPEC_ENV } from "./landlock-shim";
import { buildMcpJailBwrapArgs } from "../preview-jail";

export interface SandboxArgvInput {
  /** Resolved tier (from the capability probe). */
  tier: SandboxTier;
  /** The single writable workspace dir for the run (rw). */
  workspaceDir: string;
  /** Project root — used ONLY to compute the forbidden `.ezcorp/data` path. */
  projectRoot: string;
  /** The inner command to isolate. */
  command: string;
  /** The inner command's args. */
  args?: readonly string[];
  /** Extra read-only paths (runtime libs). Defaults to the conventional set. */
  roPaths?: readonly string[];
  /** Extra read-write paths beyond the workspace (e.g. a private TMPDIR). */
  rwPaths?: readonly string[];
  /** LIST-only paths (landlock tier): traverse + enumerate, no file-read.
   *  Used to grant a git repo root that contains `.ezcorp/data` — see
   *  buildLandlockJailSpec. No effect on the bwrap/advisory tiers. */
  listPaths?: readonly string[];
  /** Optional seccomp FD index for the bwrap leg (`--seccomp <fd>`). */
  seccompFd?: number | null;
  /** Override the path to the Bun runtime (defaults to "bun"). */
  bunPath?: string;
  /** Override the landlock shim path (defaults to the colocated shim). */
  shimPath?: string;
}

export interface SandboxArgvResult {
  /** The full argv to spawn (isolation prefix + inner command). */
  argv: string[];
  /** Env additions the spawn site MUST merge into the child's env. */
  env: Record<string, string>;
  /** The resolved Landlock spec (landlock tier only; null otherwise). */
  landlockSpec: LandlockJailSpec | null;
  /** Echo of the tier actually applied. */
  tier: SandboxTier;
}

/** Resolve the colocated shim path (works under bun + after bundling). */
function defaultShimPath(): string {
  return fileURLToPath(new URL("./landlock-shim.ts", import.meta.url));
}

/**
 * Build the isolation argv for a spawn site. PURE — returns argv + env; the
 * caller spawns. Throws (fail-closed) if a granted path would expose
 * `.ezcorp/data`.
 */
export function buildSandboxArgv(input: SandboxArgvInput): SandboxArgvResult {
  if (!input.command) throw new Error("buildSandboxArgv: command is required");

  const inner = [input.command, ...(input.args ?? [])];

  switch (input.tier) {
    case "advisory": {
      // No OS isolation — documented status-quo. Still no .ezcorp/data
      // exposure to ADD because we add no binds; the inner command runs as-is.
      return { argv: inner, env: {}, landlockSpec: null, tier: "advisory" };
    }

    case "landlock": {
      const spec = buildLandlockJailSpec({
        workspaceDir: input.workspaceDir,
        projectRoot: input.projectRoot,
        roPaths: input.roPaths,
        rwPaths: input.rwPaths,
        ...(input.listPaths ? { listPaths: input.listPaths } : {}),
      });
      const bun = input.bunPath ?? "bun";
      const shim = input.shimPath ?? defaultShimPath();
      const argv = [bun, shim, "--", ...inner];
      return {
        argv,
        env: { [LANDLOCK_SPEC_ENV]: JSON.stringify(spec) },
        landlockSpec: spec,
        tier: "landlock",
      };
    }

    case "bwrap": {
      // Reuse the MCP jail bind-set (minimal: ONE rw workspace, ro-bind
      // system dirs, private /tmp, NOTHING under .ezcorp/data — asserted by
      // the builder itself). The builder canonicalizes + fails closed on a
      // path that would expose the data dir.
      // preview-jail canonicalizes (realpath) each RO dir and FAILS CLOSED
      // on a missing one. The conventional RO set is distro-portable
      // (e.g. /nix only on NixOS, /lib64 not everywhere), so filter to the
      // dirs that actually exist before handing them over — a missing
      // optional system dir is a no-op, not a hard error.
      const roDirs = (input.roPaths ?? DEFAULT_RUNTIME_RO_DIRS).filter((d) =>
        existsSync(d),
      );
      const jailArgs = buildMcpJailBwrapArgs({
        workDir: input.workspaceDir,
        projectRoot: input.projectRoot,
        roSystemDirs: roDirs,
        seccompFd: input.seccompFd ?? null,
        command: input.command,
        args: input.args,
      });
      return {
        argv: ["bwrap", ...jailArgs],
        env: {},
        landlockSpec: null,
        tier: "bwrap",
      };
    }

    default: {
      // Exhaustiveness guard — a new tier must be handled explicitly.
      const _never: never = input.tier;
      throw new Error(`buildSandboxArgv: unhandled tier ${String(_never)}`);
    }
  }
}
