/**
 * POST /api/integrations/github-projects/proposals/[id]/dismiss
 *
 * Dismiss a pending board-move proposal WITHOUT spawning. Stamped with the
 * dismissing user.
 *
 * The caller must be authed (`extensions` scope) AND the proposal must belong
 * to a project they can reach — a missing/foreign proposal is an opaque 404.
 * RBAC: `approve-runs` — checked after the opaque proposal resolution (an
 * unauthorized probe of a nonexistent id still sees 404, never 403).
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { authGithubRoute, resolveProposal, requireGithubScope, publicProposalView } from "../../../_shared";
import {
  dismissProposal,
  GithubProposalNotPendingError,
} from "$server/integrations/github-projects/spawn";
import { getGithubProjectsEmit } from "$server/integrations/github-projects/bus-registry";
import { GITHUB_PROJECTS_EVENT } from "$server/integrations/github-projects/types";
import { extensionLogger } from "$server/logger";

const log = extensionLogger("github-projects", "api.dismiss");

export const POST: RequestHandler = async ({ locals, params }) => {
  const auth = authGithubRoute(locals);
  if ("error" in auth) return auth.error;
  const { user } = auth;

  const res = await resolveProposal(params.id);
  if ("error" in res) return res.error;
  const { proposal } = res;

  // RBAC (after the opaque proposal 404): dismissing is an `approve-runs`
  // action on the proposal's project.
  const denied = await requireGithubScope(locals, proposal.projectId, "approve-runs");
  if (denied) return denied;

  // Only a pending proposal can be dismissed; decided/terminal ones are a 409.
  if (proposal.status !== "pending") {
    return errorJson(409, `Proposal is already ${proposal.status}`);
  }

  let updated;
  try {
    updated = await dismissProposal(proposal.id, user.id);
  } catch (err) {
    // The atomic claim inside dismissProposal is the real gate; losing a
    // race past the fast-path above lands here and must 409 like it.
    if (err instanceof GithubProposalNotPendingError) {
      return errorJson(409, err.message);
    }
    log.warn("dismiss failed", {
      proposalId: proposal.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorJson(500, "Failed to dismiss proposal");
  }

  getGithubProjectsEmit()?.(GITHUB_PROJECTS_EVENT, { projectId: proposal.projectId });

  return json({ proposal: publicProposalView(updated) });
};
