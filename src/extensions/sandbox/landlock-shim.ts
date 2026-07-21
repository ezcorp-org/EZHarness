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

import { applyLandlockJailSpec, buildLandlockJailSpec, type LandlockJailSpec } from "./landlock";

export const LANDLOCK_SPEC_ENV = "EZCORP_LANDLOCK_SPEC";

/**
 * RAW (unresolved) jail-spec input env var — the SANDBOXED-SUBPROCESS handoff.
 *
 * A poisoned extension subprocess (sandbox-preload denies `node:fs`) cannot
 * run `buildLandlockJailSpec` itself: the spec builder realpath-canonicalizes
 * every grant (a SECURITY step — symlink→data-dir leak) and that needs fs.
 * So a nested-jail spawn site inside the subprocess (e.g. ez-code-factory's
 * mutating-git shell) passes the PURE inputs here instead, and THIS shim —
 * a fresh process, outside the poisoning — resolves them via
 * `buildLandlockJailSpec` (realpath + deny-by-default + data-dir assertion)
 * before applying. Fail-closed like everything else in this file: a
 * malformed raw input aborts without running the inner command.
 *
 * `LANDLOCK_SPEC_ENV` (a pre-resolved spec from a host-side builder) wins
 * when both are present — the raw path is only the subprocess-side fallback.
 */
export const LANDLOCK_RAW_SPEC_ENV = "EZCORP_LANDLOCK_SPEC_RAW";

/** The PURE inputs a sandboxed spawn site may pass via
 *  {@link LANDLOCK_RAW_SPEC_ENV} — mirrors `buildLandlockJailSpec`'s input.
 *  Imported TYPE-ONLY by sandboxed extension code (erased at runtime, so it
 *  never drags this module's fs imports into a poisoned load graph). */
export interface RawLandlockSpecInput {
  /** The run's writable workspace (rw, first grant). */
  workspaceDir: string;
  /** Project root — the forbidden `.ezcorp/data` anchor (never granted). */
  projectRoot: string;
  roPaths?: string[];
  rwPaths?: string[];
  listPaths?: string[];
  traversePaths?: string[];
}

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

/** Parse + resolve a RAW spec input (see {@link LANDLOCK_RAW_SPEC_ENV}).
 *  Fail-closed on malformed JSON / missing required fields; the resolution
 *  itself (`buildLandlockJailSpec`) fail-closes on any grant that would
 *  expose `.ezcorp/data`. */
export function resolveRawSpecFromEnv(raw: string): LandlockJailSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`landlock-shim: ${LANDLOCK_RAW_SPEC_ENV} is not valid JSON`);
  }
  const input = parsed as Partial<RawLandlockSpecInput>;
  if (typeof input.workspaceDir !== "string" || !input.workspaceDir.trim()) {
    throw new Error(`landlock-shim: raw spec needs a workspaceDir`);
  }
  if (typeof input.projectRoot !== "string" || !input.projectRoot.trim()) {
    throw new Error(`landlock-shim: raw spec needs a projectRoot`);
  }
  return buildLandlockJailSpec({
    workspaceDir: input.workspaceDir,
    projectRoot: input.projectRoot,
    ...(Array.isArray(input.roPaths) ? { roPaths: input.roPaths } : {}),
    ...(Array.isArray(input.rwPaths) ? { rwPaths: input.rwPaths } : {}),
    ...(Array.isArray(input.listPaths) ? { listPaths: input.listPaths } : {}),
    ...(Array.isArray(input.traversePaths) ? { traversePaths: input.traversePaths } : {}),
  });
}

/** Parse the jail spec from the env: a pre-resolved spec
 *  ({@link LANDLOCK_SPEC_ENV}) wins; else a RAW input
 *  ({@link LANDLOCK_RAW_SPEC_ENV}) is resolved here — the sandboxed-
 *  subprocess handoff. Fail-closed on missing/invalid. */
export function parseSpecFromEnv(
  env: Record<string, string | undefined>,
): LandlockJailSpec {
  const raw = env[LANDLOCK_SPEC_ENV];
  if (!raw) {
    const rawInput = env[LANDLOCK_RAW_SPEC_ENV];
    if (rawInput) return resolveRawSpecFromEnv(rawInput);
    throw new Error(
      `landlock-shim: ${LANDLOCK_SPEC_ENV} or ${LANDLOCK_RAW_SPEC_ENV} env var is required`,
    );
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
  // jailed git couldn't open `.`. The TRAVERSE list (READ_DIR-only project
  // root, so a workspace extension subprocess can walk the tree to its
  // `node_modules` imports) must survive the same round-trip — dropping it
  // here silently left the grant un-applied (the child then EACCES'd on
  // `openat(<projectRoot>, O_DIRECTORY)` and died at module-load).
  return {
    ro: spec.ro,
    rw: spec.rw,
    ...(Array.isArray(spec.list) ? { list: spec.list } : {}),
    ...(Array.isArray(spec.traverse) ? { traverse: spec.traverse } : {}),
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
  // Strip our spec env vars so nested spawns don't accidentally re-shim.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k !== LANDLOCK_SPEC_ENV && k !== LANDLOCK_RAW_SPEC_ENV && v != null) childEnv[k] = v;
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

/**
 * Entrypoint body: run the shim, exit with the inner command's code, and on
 * any failure log + exit 127. `exit`/`errLog` are injectable so the wiring is
 * unit-testable without terminating the test runner (the guard below uses the
 * real `process.exit`/`console.error`).
 */
export async function runShimMain(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  exit: (code: number) => void = process.exit,
  errLog: (msg: string) => void = console.error,
): Promise<void> {
  try {
    exit(await runShim(argv, env));
  } catch (err) {
    errLog(`landlock-shim: ${(err as { message?: string })?.message ?? err}`);
    exit(127);
  }
}

// Entrypoint guard: only run when invoked directly as `bun landlock-shim.ts`.
// Single-line so the guard itself is covered on import (the body only runs in
// a direct spawn, where it would jail the test runner — never in-process).
if (import.meta.main) void runShimMain(Bun.argv.slice(2), process.env);
