// ── Shell runner — the single subprocess seam ────────────────────────
//
// Every git + filesystem operation this extension performs runs through ONE
// injectable `ShellRunner`. In production it is `productionHostRunner` (a thin
// `Bun.spawn` wrapper); tests inject a runner that drives a throwaway git repo
// on a real filesystem, so the git logic is exercised end-to-end.
//
// Why a shell (not `node:fs`)? Like ez-code, this module loads inside the
// sandboxed subprocess, where `src/extensions/runtime/sandbox-preload.ts`
// poisons `node:fs` / `Bun.file` at module load. Subprocesses spawned via
// `Bun.spawn` run OUTSIDE that poisoning, so all IO is shell-driven — no
// `node:fs` import ever enters this module's load graph.

/** Result of running one command. */
export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `cmd` in `cwd`, optionally feeding `stdin`. Injectable so tests drive
 * git deterministically against a throwaway repo without a real host spawn.
 */
export type ShellRunner = (
  cmd: string[],
  cwd: string,
  opts?: { stdin?: string },
) => Promise<ShellResult>;

/**
 * Production runner — a plain host `Bun.spawn`. Subprocesses run OUTSIDE the
 * sandbox preload's `node:fs` poisoning, so this is the supported way to touch
 * git + the filesystem from extension code. `GIT_CONFIG_GLOBAL=/dev/null` keeps
 * every `git` invocation hermetic (no `~/.gitconfig` include-file surprises),
 * exactly as ez-code's jailed runner does.
 */
export const productionHostRunner: ShellRunner = async (cmd, cwd, opts) => {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    stdin: opts?.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts?.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

/**
 * Shell-quote a single token for safe interpolation into a `sh -c` string:
 * wrap in single quotes and escape embedded single quotes. Used so paths and
 * file contents (which can carry spaces / shell metacharacters / newlines)
 * survive the `sh -c` pipelines below. Pure.
 */
export function shQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}
