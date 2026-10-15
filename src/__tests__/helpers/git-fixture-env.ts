import { withoutGitContext } from "./scratch-git";

/**
 * Keep disposable Git repositories independent of a caller's hook context.
 *
 * The GIT_* strip is the one definition in `@ezcorp/sdk/git` (W18 hygiene
 * GC5), never a second loop here; this helper only adds the global and
 * system config redirection a fixture needs.
 */
export function fixtureGitEnv(ambient: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { ...withoutGitContext(ambient), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
}
