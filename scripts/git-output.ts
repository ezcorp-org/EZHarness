/**
 * Dependency-free, fail-closed stdout reader for coverage-gate Git commands.
 *
 * Item C2 (W18 hygiene): both callers (`check-new-file-coverage.ts`,
 * `check-patch-coverage.ts`) pass `REPO_ROOT` and diff/list the CURRENT
 * checkout as invoked, not some other named repository, so this keeps the
 * invoking git context (`currentRepositoryGitContext()`, never
 * `withoutGitContext()` — stripping would be wrong here, not merely
 * unneeded, since these gates must see the checkout's own real state). Found
 * by the repo-wide git-spawn guard (src/__tests__/git-spawn-context-guard.test.ts).
 *
 * `currentRepositoryGitContext()` is a LOCAL copy of `@ezcorp/sdk/git`'s
 * function of the same name, deliberately not imported: this file stays
 * genuinely "dependency-free" (this docblock's own opening word, predating
 * this fix) because `scripts/check-patch-coverage-typeonly.test.ts` copies
 * it into a bare, `node_modules`-free scratch fixture, where a workspace-
 * package import cannot resolve — exactly the regression importing
 * `@ezcorp/sdk/git` here caused. The function is a one-line identity
 * (`return env` unchanged); duplicating it carries no real drift risk, and
 * the SAME name here is what lets the repo-wide guard still recognize this
 * as a declared class-B (current-repository) spawn.
 */
export function currentRepositoryGitContext(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return env;
}
export async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: currentRepositoryGitContext(process.env) });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${code}): ${err.trim()}`);
  return out;
}
