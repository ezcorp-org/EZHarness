// ── Nested jail for mutating git ops (spec §8) ──────────────────────
//
// Mutating pipeline git (commit + push) runs UNDER the host's ez-sandbox jail
// (`buildSandboxArgv`, Seam B) — exactly the ez-code precedent
// (docs/extensions/examples/ez-code/index.ts makeProductionShell). Read-only ops
// (rev-parse, diff, ls-remote, fetch) stay on the plain host runner.
//
// The jail's rw set is ONLY the detached worktree + the gate bare repo (which
// holds the shared object store the worktree commits into) + `/dev` — NEVER the
// project root. The project root is passed solely so the builder can compute the
// forbidden `<projectRoot>/.ezcorp/data` path and assert no grant reaches it: the
// platform DB + JWT secret (a sibling of `.ezcorp/extension-data`, where the gate
// repo lives) stay unreadable from inside the jail. Containment is asserted
// (read AND write, realpath-based) by the landlock-tier test.
//
// Like ez-code, the sandbox layer is dynamically imported ONLY when a jailed
// command actually runs, so its static `node:fs` / `node:child_process` imports
// never enter this extension's module-load graph under the subprocess preload
// poison.

import type { ShellResult, ShellRunner } from "./shell";
import type { buildSandboxArgv as BuildSandboxArgvFn } from "../../../../../src/extensions/sandbox/build-sandbox-argv";
import type { getSandboxTier as GetSandboxTierFn } from "../../../../../src/extensions/sandbox/capability-probe";

/**
 * The jail's read-write grant set for a run: the worktree (workspace) + the gate
 * bare repo (shared objects/refs the worktree writes) + `/dev`. The project root
 * is deliberately absent. Pure.
 */
export function jailRwPaths(worktree: string, gateDir: string): string[] {
  return [worktree, gateDir, "/dev"];
}

/**
 * A ShellRunner that runs each command jailed to `[cwd, gateDir, /dev]` with the
 * project root as the forbidden-data anchor. Use for commit + push only; every
 * read-only op stays on the plain host runner. `stdin` is intentionally
 * unsupported — no mutating git op the pipeline runs pipes stdin.
 */
export function makeJailedShell(gateDir: string, projectRoot: string): ShellRunner {
  return async (cmd, cwd): Promise<ShellResult> => {
    const [{ buildSandboxArgv }, { getSandboxTier }] = (await Promise.all([
      import("../../../../../src/extensions/sandbox/build-sandbox-argv"),
      import("../../../../../src/extensions/sandbox/capability-probe"),
    ])) as [
      { buildSandboxArgv: typeof BuildSandboxArgvFn },
      { getSandboxTier: typeof GetSandboxTierFn },
    ];
    const rwPaths = jailRwPaths(cwd, gateDir);
    const built = buildSandboxArgv({
      tier: getSandboxTier(),
      workspaceDir: rwPaths[0]!,
      projectRoot,
      rwPaths: rwPaths.slice(1),
      command: cmd[0]!,
      args: cmd.slice(1),
    });
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
