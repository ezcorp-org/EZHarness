// ── Nested jail for mutating git ops (spec §8) ──────────────────────
//
// Mutating pipeline git (commit + push) runs UNDER the host's landlock shim:
// the spawn is `bun <shim> -- git …` with the PURE jail inputs handed over in
// the `EZCORP_LANDLOCK_SPEC_RAW` env var. The shim — a fresh process OUTSIDE
// the sandbox preload's poisoning — resolves them via `buildLandlockJailSpec`
// (realpath canonicalization + deny-by-default + the `.ezcorp/data`
// assertion), applies the jail to itself, and execs git, which inherits the
// restrictions. Read-only ops (rev-parse, diff, ls-remote, fetch) stay on the
// plain host runner.
//
// WHY the handoff (drive-3 push-step blocker): this module loads inside the
// SANDBOXED subprocess, where `node:fs`/`node:child_process` are poisoned at
// import. The previous design lazily imported the host's sandbox builders
// (`build-sandbox-argv`, `capability-probe`) — but their static `node:fs`
// imports die under the poisoning the moment the dynamic import evaluates
// ("Extension sandbox: 'fs module' blocked"), and under a landlock-tier jail
// the `src/**` files aren't even readable. So the subprocess side is now
// PURE STRING ASSEMBLY from two host-baked env vars (subprocess.ts
// buildSpawnEnv): `EZCORP_SANDBOX_TIER` (the host's probed tier) and
// `EZCORP_SANDBOX_SHIM` (the shim's absolute path, whose dir the host also
// RO-grants in the subprocess jail so the nested `bun <shim>` can read it).
//
// The jail's rw set is ONLY the detached worktree + the gate bare repo (which
// holds the shared object store the worktree commits into) + `/dev` — NEVER
// the project root. The project root is passed solely as the forbidden
// `.ezcorp/data` anchor. Containment is asserted (read AND write,
// realpath-based) by the landlock-tier test in jail.test.ts.
//
// Tier mapping: "landlock" AND "bwrap" both ride the landlock shim (a
// bwrap-capable host is landlock-usable by definition — selectTier requires
// it), since the bwrap argv builder needs fs the subprocess doesn't have.
// "advisory" (or a missing handoff) is a plain spawn — the documented
// status-quo where the platform itself has no OS jail to offer.

import type { ShellResult, ShellRunner } from "./shell";
// Type-only: ELIDED at runtime (bun strips it), so the shim's fs imports
// never enter this module's load graph. The contract stays type-checked.
import type { RawLandlockSpecInput } from "../../../../../src/extensions/sandbox/landlock-shim";

/** The raw-spec env var name — string literal kept in sync with the shim's
 *  `LANDLOCK_RAW_SPEC_ENV` (a VALUE import would drag in the poisoned fs
 *  graph; the literal IS the contract, like ez-code's agent-name literals). */
export const RAW_SPEC_ENV = "EZCORP_LANDLOCK_SPEC_RAW";

/**
 * The jail's read-write grant set for a run: the worktree (workspace) + the gate
 * bare repo (shared objects/refs the worktree writes) + `/dev`. The project root
 * is deliberately absent. Pure.
 */
export function jailRwPaths(worktree: string, gateDir: string): string[] {
  return [worktree, gateDir, "/dev"];
}

/** One nested-jail spawn, fully assembled: the argv to spawn + the env
 *  additions to merge. `jailed` is false on the advisory/missing-handoff
 *  passthrough (plain spawn). */
export interface JailInvocation {
  argv: string[];
  env: Record<string, string>;
  jailed: boolean;
}

/**
 * Assemble the nested-jail invocation for one mutating-git command. PURE —
 * reads only its arguments; the host-baked tier + shim path come in via
 * `env` (the subprocess's `process.env` in production, injected in tests).
 *
 * landlock/bwrap + a shim path → `[bun, shim, -- , …cmd]` with the RAW spec
 * (workspace = cwd, rw += gate repo + /dev, forbidden anchor = projectRoot)
 * for the shim to resolve fail-closed. Anything else → the bare command
 * (advisory passthrough).
 */
export function buildJailInvocation(
  cmd: readonly string[],
  cwd: string,
  gateDir: string,
  projectRoot: string,
  env: Record<string, string | undefined>,
  bunPath: string,
): JailInvocation {
  const tier = env.EZCORP_SANDBOX_TIER;
  const shim = env.EZCORP_SANDBOX_SHIM;
  if ((tier !== "landlock" && tier !== "bwrap") || !shim) {
    return { argv: [...cmd], env: {}, jailed: false };
  }
  const rwPaths = jailRwPaths(cwd, gateDir);
  const rawSpec: RawLandlockSpecInput = {
    workspaceDir: rwPaths[0]!,
    projectRoot,
    rwPaths: rwPaths.slice(1),
  };
  return {
    argv: [bunPath, shim, "--", ...cmd],
    env: { [RAW_SPEC_ENV]: JSON.stringify(rawSpec) },
    jailed: true,
  };
}

/**
 * A ShellRunner that runs each command jailed to `[cwd, gateDir, /dev]` with the
 * project root as the forbidden-data anchor. Use for commit + push only; every
 * read-only op stays on the plain host runner. `stdin` is intentionally
 * unsupported — no mutating git op the pipeline runs pipes stdin.
 */
export function makeJailedShell(gateDir: string, projectRoot: string): ShellRunner {
  return async (cmd, cwd): Promise<ShellResult> => {
    const built = buildJailInvocation(
      cmd,
      cwd,
      gateDir,
      projectRoot,
      process.env,
      // The subprocess's own interpreter — the nested `bun <shim>` must not
      // depend on PATH resolution inside the jail. Not poisoned (a plain
      // process property, no fs).
      process.execPath || "bun",
    );
    const proc = Bun.spawn(built.argv, {
      cwd,
      // Keep the jailed git hermetic + non-interactive: no host global config
      // (an `[include]` the jail denies would make git fatal), no credential
      // prompt (a push must fail loudly, never hang on a TTY read).
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        ...built.env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  };
}
