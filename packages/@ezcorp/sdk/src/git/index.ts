/**
 * The one production definition of the git-context-isolation rule.
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
