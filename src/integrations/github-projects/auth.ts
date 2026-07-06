/**
 * Host-only credential resolution for a github-projects board link.
 *
 * A link authenticates one of two ways:
 *   - `pat`: a fine-grained Personal Access Token written at connect time to the
 *     scope-isolated secrets store (project-scoped, no userId — the daemon and
 *     any project member share one board credential). With multi-board projects
 *     a board may carry an OPTIONAL per-board override token; the resolution is
 *     per-board override (`apiToken:<linkId>`) first, else the SHARED project
 *     token (`apiToken`). Backward-compatible: a board with no override keeps
 *     working via the shared fallback.
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

/** Secret name for a board's OPTIONAL per-board PAT override (keyed by link id).
 *  The SHARED project token lives at the bare `apiToken` name. */
export function boardTokenName(linkId: string): string {
  return `apiToken:${linkId}`;
}

/** Default host resolver: Bun's tagged-template shell runs `gh auth token`. */
export async function defaultGhAuthToken(): Promise<string> {
  return await Bun.$`gh auth token`.text();
}

/**
 * Resolve the host-only bearer for a link. For `gh` mode the (injectable)
 * `ghAuthToken` resolver supplies the token; for `pat` mode it comes from the
 * secrets store — the board's per-board override (`apiToken:<linkId>`) if
 * present, else the shared project token (`apiToken`). Throws `GithubAuthError`
 * when no usable credential is available (empty `gh` output, or neither token
 * stored).
 */
export async function resolveLinkAuth(
  link: Pick<GithubProjectsLink, "id" | "authMode" | "projectId">,
  ghAuthToken: GhAuthTokenResolver = defaultGhAuthToken,
): Promise<GithubAuth> {
  if (link.authMode === "gh") {
    const token = (await ghAuthToken()).trim();
    if (!token) throw new GithubAuthError("gh auth token returned empty output");
    return { mode: "gh", token };
  }
  // Per-board override wins over the shared project token (back-compat fallback).
  const override = await getSecret("github-projects", link.projectId, boardTokenName(link.id));
  const token = override ?? (await getSecret("github-projects", link.projectId, "apiToken"));
  if (!token) throw new GithubAuthError("no PAT stored for board or project");
  return { mode: "pat", token };
}
