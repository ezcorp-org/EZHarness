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
  return { ro: spec.ro, rw: spec.rw };
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
