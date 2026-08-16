/**
 * POST /api/integrations/github-projects/proposals/[id]/approve
 *
 * Approve a pending board-move proposal: spawn the conversation + run via the
 * spawn bridge, stamped with the approving user.
 *
 * The caller must be authed (`extensions` scope) AND the proposal must belong
 * to a project they can reach — a missing/foreign proposal is an opaque 404.
 * RBAC: `approve-runs` — checked after the opaque proposal resolution (an
 * unauthorized probe of a nonexistent id still sees 404, never 403).
 *
 * AND IT IS A RUN-START ROUTE (`RUN_START_ROUTES`), which it shipped absent
 * from: `approveProposal` creates a conversation and launches
 * `executor.streamChat` fire-and-forget, one cross-file hop away, so no run
 * primitive is nameable in this file and the surface walker could not see it.
 * `authGithubRoute` gates on `requireScope + requireAuth`, NOT on a session, so
 * a Bearer key reaches here — and the spawned run's permission mode defaults to
 * `yolo` (every tool call auto-approved) with no `toolRestriction`. Boundary 3
 * is therefore the ONLY layer standing between a policied key and the run's
 * `invoke_agent`/`run_workflow`: `tools/filter.ts` `keep()` preserves
 * orchestration, and `forceDenyOrchestration` is what strips it.
 *
 * Derived HERE, at the route — the only layer that knows the requesting
 * principal, and the side that caught Boundary 3 shipping inert — and threaded
 * down through the spawn bridge's `ApproveDeps` seam into the same `streamChat`
 * call. `{}` for a cookie session and for an unpolicied key.
 *
 * Boundary 2 is NOT wired, deliberately, and the route is absent from
 * `MODE_GUARDED_RUN_START_ROUTES` for the same reason as the briefing pair:
 * `approveProposal` CREATES the conversation the run executes on and sets no
 * `mode_id`, so `mayUseMode` would read a constant `null` and refuse every
 * locked key — a constant dressed up as a mode check. A locked key is refused
 * where the refusal is honest instead: at mint (`validateToolPolicy`) and, for
 * keys minted before that rule, at Boundary 1 (`lockedModeRunStartDenial`).
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { authGithubRoute, resolveProposal, requireGithubScope, publicProposalView } from "../../../_shared";
import {
  approveProposal,
  GithubProposalNotPendingError,
} from "$server/integrations/github-projects/spawn";
import { runStartToolPolicyOptions } from "$server/auth/tool-policy";
import { getGithubProjectsEmit } from "$server/integrations/github-projects/bus-registry";
import { GITHUB_PROJECTS_EVENT } from "$server/integrations/github-projects/types";
import { extensionLogger } from "$server/logger";

const log = extensionLogger("github-projects", "api.approve");

export const POST: RequestHandler = async ({ locals, params }) => {
  const auth = authGithubRoute(locals);
  if ("error" in auth) return auth.error;
  const { user } = auth;

  const res = await resolveProposal(params.id);
  if ("error" in res) return res.error;
  const { proposal } = res;

  // RBAC (after the opaque proposal 404): approving is an `approve-runs`
  // action on the proposal's project.
  const denied = await requireGithubScope(locals, proposal.projectId, "approve-runs");
  if (denied) return denied;

  // Only a pending proposal can be approved; decided/terminal ones are a 409.
  if (proposal.status !== "pending") {
    return errorJson(409, `Proposal is already ${proposal.status}`);
  }

  let updated: Awaited<ReturnType<typeof approveProposal>>;
  try {
    updated = await approveProposal(
      proposal.id,
      { kind: "user", userId: user.id },
      { toolPolicyOptions: runStartToolPolicyOptions(locals.apiKeyToolPolicy) },
    );
  } catch (err) {
    // The atomic claim inside approveProposal is the real gate; losing a
    // race past the fast-path above lands here and must 409 like it.
    if (err instanceof GithubProposalNotPendingError) {
      return errorJson(409, err.message);
    }
    log.warn("approve failed", {
      proposalId: proposal.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorJson(500, "Failed to approve proposal");
  }

  getGithubProjectsEmit()?.(GITHUB_PROJECTS_EVENT, { projectId: proposal.projectId });

  return json({ proposal: publicProposalView(updated) });
};
