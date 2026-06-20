/**
 * Landlock pre-exec shim (Phase A2).
 *
 * Landlock is per-process (an in-process syscall sequence), so it cannot be
 * expressed as a bwrap-style argv prefix. This shim bridges the gap: every
 * spawn site that wants the `landlock` tier invokes
 *
 *   bun <this-shim> -- <inner-cmd> [inner-args...]
 *
 * with the serialized jail spec passed in the `EZCORP_LANDLOCK_SPEC` env var
 * (JSON of `LandlockJailSpec`). The shim:
 *   1. parses + applies the Landlock jail to ITSELF, then
 *   2. spawns the inner command, which INHERITS the restrictions (Landlock
 *      rules survive fork/execve), wiring through stdio + exit code.
 *
 * Fail-closed: a missing/invalid spec, an unsupported kernel, or a failed
 * `restrict_self` aborts WITHOUT running the inner command. The whole point
 * is that the child must never run un-jailed.
 *
 * Kept dependency-light (only landlock.ts) so it stays cheap to `bun` as a
 * subprocess entrypoint.
 */

import { applyLandlockJailSpec, type LandlockJailSpec } from "./landlock";

export const LANDLOCK_SPEC_ENV = "EZCORP_LANDLOCK_SPEC";

/**
 * Resolve the inner command from the shim's own argv slice (everything AFTER
 * `bun <shim>`).
 *
 * The `--` separator in `bun <shim> -- <cmd>` is CONSUMED by Bun's CLI
 * parser (it never reaches `Bun.argv`), so the slice we receive is just the
 * inner command + args. We still honor an explicit leading `--` if present
 * (e.g. when invoked via `execvp` directly, bypassing Bun's parser) so the
 * function is robust either way.
 */
export function parseShimArgv(argv: readonly string[]): {
  command: string;
  args: string[];
} {
  const sep = argv.indexOf("--");
  const inner = sep >= 0 ? argv.slice(sep + 1) : argv.slice();
  if (inner.length === 0) {
    throw new Error("landlock-shim: no inner command");
  }
  return { command: inner[0]!, args: inner.slice(1) };
}

/** Parse the jail spec from the env var. Fail-closed on missing/invalid. */
export function parseSpecFromEnv(
  env: Record<string, string | undefined>,
): LandlockJailSpec {
  const raw = env[LANDLOCK_SPEC_ENV];
  if (!raw) {
    throw new Error(`landlock-shim: ${LANDLOCK_SPEC_ENV} env var is required`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`landlock-shim: ${LANDLOCK_SPEC_ENV} is not valid JSON`);
  }
  const spec = parsed as Partial<LandlockJailSpec>;
  if (!Array.isArray(spec.ro) || !Array.isArray(spec.rw)) {
    throw new Error(`landlock-shim: malformed spec (need ro[] and rw[])`);
  }
  // Preserve the optional read-only "root" list (data-dir-ancestor-exempt) so
  // the in-process jail grants the git repo root — dropping it here was why
  // jailed git couldn't open `.`.
  return {
    ro: spec.ro,
    rw: spec.rw,
    ...(Array.isArray(spec.list) ? { list: spec.list } : {}),
  };
}

/**
 * Run the shim: apply the jail, then exec the inner command. Returns the
 * inner command's exit code. Separated from the module top-level so it is
 * unit-testable (the entrypoint guard below calls it only when run directly).
 */
export async function runShim(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const { command, args } = parseShimArgv(argv);
  const spec = parseSpecFromEnv(env);

  // Chdir into the granted workspace BEFORE applying the jail. The shim (and
  // the inner command it spawns) inherits the host process's cwd — for a
  // bundled server that's wherever the host was launched (e.g. `web/`), which
  // is NOT in the jail's allowlist. Landlock then denies the inner `bun` even
  // reading `.`, so it aborts at startup with "CouldntReadCurrentDirectory"
  // before running any extension code. The bwrap tier avoids this with
  // `--chdir <workDir>`; the landlock tier needs the same move. `rw[0]` is the
  // workspace dir (always present + writable per buildLandlockJailSpec), so
  // landing there gives the child a readable, in-jail cwd. Best-effort: a
  // chdir failure is non-fatal (the jail still applies; the child may still
  // run if its real cwd happens to be granted).
  const workspace = spec.rw[0];
  let chdired = false;
  if (workspace) {
    try {
      process.chdir(workspace);
      chdired = true;
    } catch {
      // Non-fatal — fall through; the jail below is still applied. The
      // child then inherits the host cwd (and the explicit `cwd` below is
      // NOT set, so a non-existent workspace can't break the spawn itself).
    }
  }

  // Apply BEFORE spawning — fail-closed: if this throws, the inner command
  // never runs.
  applyLandlockJailSpec(spec);

  // The child inherits the Landlock restrictions (they survive execve).
  // Strip our spec env var so nested spawns don't accidentally re-shim.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k !== LANDLOCK_SPEC_ENV && v != null) childEnv[k] = v;
  }

  const proc = Bun.spawn([command, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: childEnv,
    // Pin cwd to the granted workspace ONLY when we actually chdir'd into it
    // (it exists + is reachable). If the workspace was missing the chdir
    // failed above; passing a non-existent `cwd` here would make the spawn
    // itself ENOENT instead of running the (jailed) command, so we leave it
    // inherited in that case.
    ...(chdired ? { cwd: workspace! } : {}),
  });
  return await proc.exited;
}

// Entrypoint guard: only run when invoked directly as `bun landlock-shim.ts`.
if (import.meta.main) {
  runShim(Bun.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`landlock-shim: ${err?.message ?? err}`);
      process.exit(127);
    });
}
