/**
 * Shared helpers for the github-projects integration API routes.
 *
 * Every route in this folder is session/key authed (`extensions` scope) and
 * acts on an EZCorp project that the caller can access. Projects in EZCorp are
 * instance-scoped (no per-user owner column — the single-operator / team
 * model), so "can access" reduces to: authenticated AND the project exists.
 * These helpers pin that contract in one place so the six handlers below stay
 * DRY and consistent (a 404 for a missing project/link/proposal is never an
 * enumeration oracle — same opaque shape as the rest of the API).
 *
 * SECURITY: handlers MUST resolve the board/link from the SERVER-derived
 * projectId, never trust a board id or link id smuggled in by a caller for a
 * project they can't reach. The token is NEVER echoed back in any response.
 */
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getProject } from "$server/db/queries/projects";
import {
  getLinkByProjectId,
  getProposalById,
} from "$server/db/queries/github-projects";
import type { AuthUser } from "$server/auth/types";
import type { GithubProjectsLink, GithubProjectsProposal } from "$server/db/schema";

/** App.Locals slice these helpers read (auth + key scopes). */
export type GithubRouteLocals = {
  user?: AuthUser;
  apiKeyScopes?: import("$lib/server/security/api-keys").ApiKeyScope[];
};

/** Gate on the `extensions` scope + a real session/key user. Returns the
 *  authed user, or a Response to short-circuit the handler with. */
export function authGithubRoute(
  locals: GithubRouteLocals,
): { user: AuthUser } | { error: Response } {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return { error: scopeErr };
  try {
    return { user: requireAuth(locals) };
  } catch (resp) {
    // requireAuth throws a Response (401) — surface it as an early return.
    return { error: resp as Response };
  }
}

/** Resolve a project the caller may act on. 400 when missing, 404 when the
 *  project doesn't exist (opaque — no membership oracle). */
export async function resolveProject(
  projectId: string | null | undefined,
): Promise<{ projectId: string } | { error: Response }> {
  if (!projectId || typeof projectId !== "string") {
    return { error: errorJson(400, "projectId is required") };
  }
  const project = await getProject(projectId);
  if (!project) return { error: errorJson(404, "Project not found") };
  return { projectId };
}

/** Resolve the (single) board link for a project, or a 404. */
export async function resolveLink(
  projectId: string,
): Promise<{ link: GithubProjectsLink } | { error: Response }> {
  const link = await getLinkByProjectId(projectId);
  if (!link) return { error: errorJson(404, "No GitHub board linked to this project") };
  return { link };
}

/** Resolve a proposal AND assert it belongs to an accessible project. A
 *  proposal for a non-existent project, or a missing proposal, is an opaque
 *  404 — never a 403 oracle that confirms the id exists elsewhere. */
export async function resolveProposal(
  proposalId: string | undefined,
): Promise<{ proposal: GithubProjectsProposal } | { error: Response }> {
  if (!proposalId) return { error: errorJson(404, "Proposal not found") };
  const proposal = await getProposalById(proposalId);
  if (!proposal) return { error: errorJson(404, "Proposal not found") };
  const project = await getProject(proposal.projectId);
  if (!project) return { error: errorJson(404, "Proposal not found") };
  return { proposal };
}

/** Public (token-free) shape of a link for GET/PATCH responses. The encrypted
 *  PAT lives in settings and is NEVER part of any link row or response. */
export function publicLinkView(link: GithubProjectsLink) {
  return {
    id: link.id,
    projectId: link.projectId,
    boardUrl: link.boardUrl,
    boardTitle: link.boardTitle,
    ownerLogin: link.ownerLogin,
    boardNodeId: link.boardNodeId,
    statusFieldId: link.statusFieldId,
    // The board's columns (id+name), so the editor renders named, complete
    // columns after a reload — not just the saved map's option-id keys.
    statusOptions: link.statusOptions,
    authMode: link.authMode,
    columnActionMap: link.columnActionMap,
    pollIntervalSec: link.pollIntervalSec,
    enabled: link.enabled,
    lastPolledAt: link.lastPolledAt,
    lastError: link.lastError,
    lastErrorAt: link.lastErrorAt,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

/** Public shape of a proposal row (no secrets present on proposals). */
export function publicProposalView(p: GithubProjectsProposal) {
  return {
    id: p.id,
    projectId: p.projectId,
    linkId: p.linkId,
    itemNodeId: p.itemNodeId,
    statusOptionId: p.statusOptionId,
    statusName: p.statusName,
    action: p.action,
    title: p.title,
    ticketUrl: p.ticketUrl,
    status: p.status,
    conversationId: p.conversationId,
    agentRunId: p.agentRunId,
    proposedAt: p.proposedAt,
    decidedAt: p.decidedAt,
    decidedByUserId: p.decidedByUserId,
    finishedAt: p.finishedAt,
    error: p.error,
  };
}
