/**
 * GitHub Projects poller daemon.  ──  OWNED BY AGENT B.
 *
 * Phase 0 STUB. Agent B implements the singleton + wires it into
 * src/startup/background-timers.ts (env kill-switch
 * EZCORP_DISABLE_GITHUB_PROJECTS_DAEMON; add a mock.module stub in its test and
 * fix sibling daemon-count assertions). Each tick, for every enabled link:
 * fetch board items since the cursor, detect Status transitions into mapped
 * triggering options, upsert proposals via insertProposalIfNew (ON CONFLICT DO
 * NOTHING), auto-spawn the autoSpawn ones, advance the cursor, and on
 * 401/404/rate-limit set last_error + back off (degrade — never crash the loop
 * or starve other links). Emits GITHUB_PROJECTS_EVENT to refresh the Hub.
 */

export class GithubProjectsDaemon {
  start(): void {
    throw new Error(
      "github-projects: GithubProjectsDaemon.start() not implemented yet (Agent B owns daemon.ts)",
    );
  }

  async stop(): Promise<void> {
    /* no-op until implemented */
  }

  /** Single poll sweep across all enabled links. Exposed for tests. */
  async pollOnce(): Promise<void> {
    throw new Error(
      "github-projects: GithubProjectsDaemon.pollOnce() not implemented yet (Agent B owns daemon.ts)",
    );
  }
}

let singleton: GithubProjectsDaemon | null = null;

export function getGithubProjectsDaemon(): GithubProjectsDaemon {
  if (!singleton) singleton = new GithubProjectsDaemon();
  return singleton;
}
