/**
 * Host-only credential resolution for a github-projects board link.
 *
 * A link authenticates one of two ways:
 *   - `pat`: a fine-grained Personal Access Token written at connect time to the
 *     scope-isolated secrets store (project-scoped, no userId — the daemon and
 *     any project member share one board credential).
 *   - `gh`:  the host's `gh` CLI identity, resolved on demand via `gh auth token`.
 *
 * Both collapse to a single resolved bearer (`GithubAuth`). This resolver is the
 * ONE place that mapping lives — shared by the poller daemon (per sweep) and the
 * `link/refresh-columns` route (re-fetch the board's Status columns without the
 * user re-pasting their PAT). The token is HOST-ONLY: never logged, never echoed.
 */
import { getSecret } from "../../extensions/secrets-store";
import { GithubAuthError, type GithubAuth } from "./types";
import type { GithubProjectsLink } from "../../db/schema";

/** Resolver for the host's `gh auth token`. Injected so callers/tests stay pure. */
export type GhAuthTokenResolver = () => Promise<string>;

/** Default host resolver: Bun's tagged-template shell runs `gh auth token`. */
export async function defaultGhAuthToken(): Promise<string> {
  return await Bun.$`gh auth token`.text();
}

/**
 * Resolve the host-only bearer for a link. For `gh` mode the (injectable)
 * `ghAuthToken` resolver supplies the token; for `pat` mode it comes from the
 * secrets store at the link's project scope. Throws `GithubAuthError` when no
 * usable credential is available (empty `gh` output, or no stored PAT).
 */
export async function resolveLinkAuth(
  link: Pick<GithubProjectsLink, "authMode" | "projectId">,
  ghAuthToken: GhAuthTokenResolver = defaultGhAuthToken,
): Promise<GithubAuth> {
  if (link.authMode === "gh") {
    const token = (await ghAuthToken()).trim();
    if (!token) throw new GithubAuthError("gh auth token returned empty output");
    return { mode: "gh", token };
  }
  const token = await getSecret("github-projects", link.projectId, "apiToken");
  if (!token) throw new GithubAuthError("no PAT stored for project");
  return { mode: "pat", token };
}
