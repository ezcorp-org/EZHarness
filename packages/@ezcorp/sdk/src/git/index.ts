/**
 * The one production definition of the git-context-isolation rule — as TWO
 * named classes a production git spawn must pick exactly one of (validator-3's
 * finding, item C2, W18 hygiene): {@link withoutGitContext} for a spawn that
 * targets an explicit repository the caller names (a clone URL, an
 * `ls-remote` URL, a `-C <path>`/`cwd` the caller chose), and
 * {@link currentRepositoryGitContext} for a spawn that must operate on the
 * repository AS INVOKED (a gate/coverage script walking the checkout its own
 * caller already established, a hook helper that needs the staged-not-
 * committed view). Stripping `GIT_*` in the second class is not merely
 * unneeded — it is wrong, and doing so was a real regression: six gate
 * scripts converted to `withoutGitContext()` under the first draft of this
 * rule (before the class split existed) broke ten tests that poison the
 * environment specifically to prove those scripts pick up the STAGED
 * repository state, not a plain `cwd`-discovered one.
 *
 * Three of those six (`gate-integrity.ts`, `git-output.ts`,
 * `check-visual-evidence.ts`) do NOT import `currentRepositoryGitContext`
 * from here — each carries its own LOCAL, identically-named copy instead,
 * with a comment explaining why. All three get copied (whole-file, via
 * `cpSync`/`copyFileSync`) into a bare scratch fixture by their own tests,
 * specifically to prove they behave correctly with NO `node_modules` at
 * all; a workspace-package import cannot resolve there. Since the function
 * is a one-line identity, the duplication carries no drift risk, and using
 * the same name keeps the repo-wide git-spawn guard
 * (`src/__tests__/git-spawn-context-guard.test.ts`) able to recognize the
 * call as declared class-B either way.
 *
 * Git exports `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`,
 * `GIT_OBJECT_DIRECTORY`, `GIT_PREFIX` and friends to every process a hook
 * runs. Those variables, once inherited, override an explicit `-C <path>` /
 * `cwd` — git prefers them over repository discovery — so a child `git`
 * command silently acts on the HOOK's repository instead of the one its
 * caller asked for, rather than failing loudly. This is a real, previously
 * incidented failure mode in this repo: on 2026-09-24, a test invoked by the
 * pre-commit hook inherited that context and re-initialised the shared
 * repository as bare, writing its fixture identity into the shared config
 * (see `src/__tests__/helpers/scratch-git.ts` and
 * `scripts/lib/hook-lib.sh`'s `without_git_context()`, the shell-side sibling
 * of this same rule).
 *
 * `withoutGitContext` is deliberately narrow: it drops every `GIT_*`-prefixed
 * variable and nothing else. It does not touch `HOME`, `XDG_CONFIG_HOME`, or
 * disable the host's global/system git config — a caller that also needs
 * that stronger, full isolation (a test building a scratch repository from
 * nothing, where no real identity or config should ever be visible) layers
 * it on top itself (see `isolatedGitEnv` in `../test/filesystem.ts`). Kept
 * this narrow, a production caller that also depends on the host's
 * transport/auth configuration (an `insteadOf` URL rewrite, a configured
 * credential helper, a container's `safe.directory` entry in system config)
 * keeps working exactly as before — only the repository-redirection vector
 * is defended against, which is the one concrete, previously-exploited
 * threat this rule exists for.
 *
 * Every host-side git subprocess wrapper in this monorepo delegates to this
 * one definition rather than reimplementing the strip loop: production
 * (`src/extensions/git.ts`'s `gitExec()`, `scripts/unlanded-branches.ts`'s
 * `realGit()`, `docs/extensions/examples/docs-updater/index.ts`'s hermetic
 * git env) and test helpers alike (`../test/filesystem.ts`'s
 * `isolatedGitEnv()`, `src/__tests__/helpers/scratch-git.ts`'s
 * `withoutGitContext` re-export). Test helpers delegate to this production
 * module; this module never depends on any test helper.
 */
export function withoutGitContext(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !name.startsWith("GIT_")) out[name] = value;
  }
  return out;
}

/**
 * The OTHER git-spawn class (item C2, W18 hygiene — validator-3's finding):
 * a caller that must operate on the repository AS INVOKED, not on some
 * explicit target it names itself. A pre-commit hook script that inspects
 * STAGED content needs `GIT_INDEX_FILE`; a coverage/boundary/gate script
 * that walks `git diff`/`git ls-files` against the checkout the CALLER
 * already established needs whatever repository context that caller set
 * up. `withoutGitContext()` here would be WRONG, not merely unnecessary —
 * it would silently redirect the spawn onto plain cwd-based repository
 * discovery instead of the invoking context the caller deliberately built
 * (this repo's own `scripts/check-boundaries.ts`, `check-visual-evidence.ts`,
 * `gate-integrity.ts`, `git-output.ts`, `git-worktree-clean.ts`, and
 * `verify-browser-coverage-receipt.ts` all fit this class — each operates on
 * `REPO_ROOT`/a given `repoRoot` AS the current checkout is, never on some
 * OTHER named repository).
 *
 * This function is a DECLARATION, not a transformation: it returns `env`
 * completely unchanged. Its only purpose is to be the one, named,
 * walker-recognized way to say "yes, this git spawn's env is deliberately
 * the invoking context" — so the repo-wide guard
 * (`src/__tests__/git-spawn-context-guard.test.ts`) can tell a genuine,
 * declared class-B spawn apart from a class-A spawn (see
 * {@link withoutGitContext}) that simply forgot to strip. Every git spawn
 * in production code must call exactly one of these two functions, by name
 * — the guard fails on a spawn that calls neither, exactly as it did on an
 * omitted `env` key or a bare `{...process.env}` passthrough before this
 * class existed.
 */
export function currentRepositoryGitContext(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return env;
}
