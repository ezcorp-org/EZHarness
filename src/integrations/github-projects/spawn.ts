/**
 * Spawn bridge: turn an approved proposal into a harness conversation + run.
 *   ──  OWNED BY AGENT B.
 *
 * Phase 0 STUB: the two exported signatures below are the FROZEN contract that
 * Agent D's approve/dismiss API routes + Hub actions call. Agent B replaces the
 * bodies. Invariants Agent B must uphold (see the approved plan):
 *   - Derive projectId FROM THE LINK, never from caller input.
 *   - createConversation(projectId, …) + executor.streamChat(…) with the
 *     permissionMode pinned to a NON-yolo, PDP-gated mode (never inherit the
 *     platform default).
 *   - Treat the ticket title/body as untrusted prompt-injection input.
 *   - Enforce the per-project concurrency cap (countActiveProposalsForProject).
 *   - Subscribe run:complete/run:error to move the proposal running→done|failed.
 */
import type { GithubProjectsProposal } from "../../db/schema";

/** Who is approving: a real user (Hub/API click) or the daemon (auto-spawn). */
export type ProposalActor = { kind: "user"; userId: string } | { kind: "auto" };

/**
 * Approve a pending proposal (or auto-spawn one): spawn the conversation + run,
 * stamp the proposal with conversationId/agentRunId, return the updated row.
 */
export async function approveProposal(
  _proposalId: string,
  _actor: ProposalActor,
): Promise<GithubProjectsProposal> {
  throw new Error(
    "github-projects: approveProposal() not implemented yet (Agent B owns spawn.ts)",
  );
}

/** Dismiss a pending proposal without spawning (Hub/API). */
export async function dismissProposal(
  _proposalId: string,
  _userId: string,
): Promise<GithubProjectsProposal> {
  throw new Error(
    "github-projects: dismissProposal() not implemented yet (Agent B owns spawn.ts)",
  );
}
