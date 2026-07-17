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
 * Runs `cmd` in `cwd`, optionally feeding `stdin` and extra `env` (merged over
 * the process env — the gh runner injects GH_TOKEN this way). Injectable so
 * tests drive git deterministically against a throwaway repo without a real
 * host spawn.
 */
export type ShellRunner = (
  cmd: string[],
  cwd: string,
  opts?: { stdin?: string; env?: Record<string, string> },
) => Promise<ShellResult>;

/**
 * Production runner — a plain host `Bun.spawn`. Subprocesses run OUTSIDE the
 * sandbox preload's `node:fs` poisoning, so this is the supported way to touch
 * git + the filesystem from extension code. `GIT_CONFIG_GLOBAL=/dev/null` keeps
 * every `git` invocation hermetic (no `~/.gitconfig` include-file surprises).
 * NOTE: unlike ez-code's jailed runner, this runner is DELIBERATELY UNJAILED —
 * M0 shells git directly on the host with no ez-sandbox containment (the nested
 * jail lands in M1+ per spec §6); the hermetic global-config pin is the only
 * hardening here.
 *
 * MISSING-EXECUTABLE = exit 127, NOT a throw: `Bun.spawn` throws synchronously
 * (ENOENT) when the argv[0] binary is not on PATH. A real shell reports "command
 * not found" as exit 127 and keeps running; this runner mirrors that so a caller
 * probing an optional tool sees a non-zero ShellResult instead of an exception.
 * The pr/ci steps depend on this: `gh` is NOT in the base image, so
 * `GitHubHost.available()` (a `gh auth status` probe) must SKIP-not-fail — a
 * synchronous throw here would instead propagate to `advance` → `failRun` and
 * fail every GitHub-upstream gate run. (A missing `git` also maps to 127, which
 * surfaces as ordinary non-zero git results the steps already handle.)
 */
export const productionHostRunner: ShellRunner = async (cmd, cwd, opts) => {
  // A local factory so `ReturnType<typeof startProc>` keeps Bun's precise
  // Subprocess typing (stdin/stdout FileSink/ReadableStream) inferred from the
  // options literal — annotating `proc: ReturnType<typeof Bun.spawn>` directly
  // would widen the stdio fields to their default `number` union.
  const startProc = () =>
    Bun.spawn(cmd, {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...opts?.env },
      stdin: opts?.stdin !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  let proc: ReturnType<typeof startProc>;
  try {
    proc = startProc();
  } catch (err) {
    // ENOENT (missing binary) or an unreadable cwd — 127, the shell convention
    // for "command not found", so the runner boundary never throws.
    const detail = err instanceof Error ? err.message : String(err);
    return { exitCode: 127, stdout: "", stderr: `${cmd[0]}: ${detail}` };
  }
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
