/**
 * POST /api/integrations/github-projects/proposals/[id]/rerun
 *
 * Re-run a TERMINAL (done/failed/dismissed/cancelled) proposal: create a
 * fresh PENDING proposal for the same card + trigger via the spawn bridge.
 * NO run is spawned here — the normal approval gate applies to the new row.
 *
 * The caller must be authed (`extensions` scope) AND the proposal must belong
 * to a project they can reach — a missing/foreign proposal is an opaque 404.
 * RBAC: `approve-runs` — checked after the opaque proposal resolution (an
 * unauthorized probe of a nonexistent id still sees 404, never 403).
 * A still-active proposal is a 409, as is a card that already holds an active
 * proposal (the single-active-per-card index arbitrates atomically).
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { authGithubRoute, resolveProposal, requireGithubScope, publicProposalView } from "../../../_shared";
import {
  rerunProposal,
  GithubProposalNotRerunnableError,
  GithubCardBusyError,
} from "$server/integrations/github-projects/spawn";
import { getGithubProjectsEmit } from "$server/integrations/github-projects/bus-registry";
import {
  GITHUB_PROJECTS_EVENT,
  GITHUB_TERMINAL_STATUSES,
} from "$server/integrations/github-projects/types";
import { extensionLogger } from "$server/logger";

const log = extensionLogger("github-projects", "api.rerun");

export const POST: RequestHandler = async ({ locals, params }) => {
  const auth = authGithubRoute(locals);
  if ("error" in auth) return auth.error;
  const { user } = auth;

  const res = await resolveProposal(params.id);
  if ("error" in res) return res.error;
  const { proposal } = res;

  // RBAC (after the opaque proposal 404): re-running is an `approve-runs`
  // action on the proposal's project.
  const denied = await requireGithubScope(locals, proposal.projectId, "approve-runs");
  if (denied) return denied;

  // Only a TERMINAL proposal can be re-run; an active one is a 409. The
  // atomic insert inside rerunProposal is the real gate; this fails cheaply.
  if (!GITHUB_TERMINAL_STATUSES.includes(proposal.status)) {
    return errorJson(409, `Proposal is still ${proposal.status} — only a finished proposal can be re-run`);
  }

  let fresh;
  try {
    fresh = await rerunProposal(proposal.id, { kind: "user", userId: user.id });
  } catch (err) {
    // Losing a race past the fast-path above (the proposal churned, or the
    // card re-triggered and holds a fresh active proposal) lands here → 409.
    if (err instanceof GithubProposalNotRerunnableError || err instanceof GithubCardBusyError) {
      return errorJson(409, err.message);
    }
    log.warn("rerun failed", {
      proposalId: proposal.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorJson(500, "Failed to re-run proposal");
  }

  getGithubProjectsEmit()?.(GITHUB_PROJECTS_EVENT, { projectId: proposal.projectId });

  return json({ proposal: publicProposalView(fresh) });
};
