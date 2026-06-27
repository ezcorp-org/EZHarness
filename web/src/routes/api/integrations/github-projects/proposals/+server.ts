/**
 * GET /api/integrations/github-projects/proposals?projectId=…[&status=active|history]
 *
 * List a project's board-move proposals for the Hub / settings UI. Splits into
 * `active` (pending/approved/spawned/running) and `history` (terminal) so the
 * caller can render the two sections without re-deriving the lifecycle bands.
 *
 * Authed: `extensions` scope + session/key user.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { authGithubRoute, resolveProject, publicProposalView } from "../_shared";
import { listProposalsByProject } from "$server/db/queries/github-projects";
import {
  GITHUB_ACTIVE_STATUSES,
  GITHUB_TERMINAL_STATUSES,
} from "$server/integrations/github-projects/types";

export const GET: RequestHandler = async ({ locals, url }) => {
  const auth = authGithubRoute(locals);
  if ("error" in auth) return auth.error;

  const projectRes = await resolveProject(url.searchParams.get("projectId"));
  if ("error" in projectRes) return projectRes.error;
  const { projectId } = projectRes;

  const filter = url.searchParams.get("status");
  if (filter === "active") {
    const rows = await listProposalsByProject(projectId, {
      statuses: [...GITHUB_ACTIVE_STATUSES],
    });
    return json({ proposals: rows.map(publicProposalView) });
  }
  if (filter === "history") {
    const rows = await listProposalsByProject(projectId, {
      statuses: [...GITHUB_TERMINAL_STATUSES],
    });
    return json({ proposals: rows.map(publicProposalView) });
  }

  // Default: everything, pre-split into the two bands for the UI.
  const all = await listProposalsByProject(projectId);
  const activeSet = new Set<string>(GITHUB_ACTIVE_STATUSES);
  return json({
    active: all.filter((p) => activeSet.has(p.status)).map(publicProposalView),
    history: all.filter((p) => !activeSet.has(p.status)).map(publicProposalView),
  });
};
