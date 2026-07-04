/**
 * Shared helpers for the github-projects integration API routes.
 *
 * Every route in this folder is session/key authed (`extensions` scope) and
 * acts on an EZCorp project that the caller can access. Projects in EZCorp are
 * instance-scoped (no per-user owner column — the single-operator / team
 * model), so "can access" reduces to: authenticated AND the project exists.
 * On top of that, every handler enforces an extension-RBAC scope via
 * `requireGithubScope` (GET link/proposals → `use`; connect / PATCH / DELETE
 * link / refresh-columns → `configure`, connect additionally `secrets` when a
 * token is written; approve/dismiss/rerun → `approve-runs`). Non-admin members
 * are deny-by-default; admins implicitly hold every scope.
 * These helpers pin that contract in one place so the six handlers below stay
 * DRY and consistent (a 404 for a missing project/link/proposal is never an
 * enumeration oracle — same opaque shape as the rest of the API; the RBAC 403
 * is only ever emitted AFTER the opaque resolution steps).
 *
 * SECURITY: handlers MUST resolve the board/link from the SERVER-derived
 * projectId, never trust a board id or link id smuggled in by a caller for a
 * project they can't reach. The token is NEVER echoed back in any response.
 */
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { hasExtensionScope } from "$server/auth/extension-rbac";
import { PERMISSION_MODES } from "$lib/permission-mode";
import { getProject } from "$server/db/queries/projects";
import {
  getLinkById,
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

/** The extension id every github-projects route's RBAC check is keyed by. */
const GITHUB_PROJECTS_EXTENSION_ID = "github-projects";

/**
 * Require an extension-RBAC scope on the acting user for THIS project.
 * Returns `null` when allowed, or a 403 `errorJson` NAMING the missing scope
 * (mirroring `authGithubRoute`'s early-return error style).
 *
 * Ordering contract: call AFTER `authGithubRoute` and AFTER the project /
 * link / proposal resolution, so the opaque-404 semantics stay first — an
 * unauthorized caller probing a nonexistent id still sees the same 404 as
 * everyone else, never a 403 oracle confirming the id exists.
 *
 * Deny-by-default (spec 2026-07-03): non-admin members hold NO scopes until
 * an `extension_rbac_grants` row says otherwise; admins implicitly hold every
 * scope and pass WITHOUT a DB hit (the core resolver's admin sentinel).
 */
export async function requireGithubScope(
  locals: GithubRouteLocals,
  projectId: string,
  scope: string,
): Promise<Response | null> {
  const user = locals.user;
  // authGithubRoute() must have run first; fail closed if it somehow didn't.
  if (!user) return errorJson(401, "Authentication required");
  const allowed = await hasExtensionScope(user, {
    projectId,
    extensionId: GITHUB_PROJECTS_EXTENSION_ID,
    scope,
  });
  if (allowed) return null;
  return errorJson(403, `Missing extension scope '${scope}' for github-projects`);
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

/** Resolve a SPECIFIC board link by id, asserting it belongs to `projectId`.
 *  A missing link, or a link owned by a different project, is the SAME opaque
 *  404 (never a cross-project oracle confirming the link id exists elsewhere). */
export async function resolveLinkForProject(
  projectId: string,
  linkId: string | null | undefined,
): Promise<{ link: GithubProjectsLink } | { error: Response }> {
  if (!linkId || typeof linkId !== "string") {
    return { error: errorJson(400, "linkId is required") };
  }
  const link = await getLinkById(linkId);
  if (!link || link.projectId !== projectId) {
    return { error: errorJson(404, "No GitHub board linked to this project") };
  }
  return { link };
}

/** Token scope for connect: a `board` token is stored as a per-board override
 *  (`apiToken:<linkId>`); the default `shared` token is the project's `apiToken`.
 *  Default `shared`; only the two known strings are accepted (else an error). */
export function parseTokenScope(
  raw: unknown,
): { scope: "shared" | "board" } | { error: string } {
  if (raw === undefined || raw === null || raw === "shared") return { scope: "shared" };
  if (raw === "board") return { scope: "board" };
  return { error: "tokenScope must be 'shared' or 'board'" };
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

/** Validate an untrusted `defaultModel` body field: null/undefined/"" -> {value:null}
 *  (instance default); a "<provider>:<model>" string -> {value:raw}; anything else -> {error}. */
export function parseDefaultModelInput(raw: unknown): { value: string | null } | { error: string } {
  if (raw === null || raw === undefined || raw === "") return { value: null };
  if (typeof raw !== "string") return { error: "defaultModel must be a string, null, or empty" };
  const i = raw.indexOf(":");
  if (i <= 0 || i === raw.length - 1) return { error: "defaultModel must be '<provider>:<model>'" };
  return { value: raw };
}

/** Validate an untrusted `defaultPermissionMode` body field: null/undefined/"" ->
 *  {value:null} (board spawns fall back to 'yolo'); one of the chat PERMISSION_MODES
 *  ("ask" | "auto-edit" | "yolo") -> {value:raw}; anything else -> {error}. Reuses
 *  the single chat permission-mode list ($lib/permission-mode) — no second list. */
export function parsePermissionModeInput(raw: unknown): { value: string | null } | { error: string } {
  if (raw === null || raw === undefined || raw === "") return { value: null };
  if (typeof raw !== "string" || !(PERMISSION_MODES as string[]).includes(raw)) {
    return { error: `defaultPermissionMode must be one of: ${PERMISSION_MODES.join(", ")}` };
  }
  return { value: raw };
}

/** Public (token-free) shape of a link for GET/PATCH responses. The encrypted
 *  PAT lives in the secrets store and is NEVER part of any link row or response.
 *  `hasTokenOverride` is the boolean presence of a per-board override token
 *  (resolved by the caller via hasSecret) — never the token itself. The owner
 *  AVATAR is derived CLIENT-SIDE from `ownerLogin` (no backend field). */
export function publicLinkView(link: GithubProjectsLink, hasTokenOverride = false) {
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
    // Per-board default model for spawned runs ("<provider>:<model>") or null.
    defaultModel: link.defaultModel ?? null,
    // Per-board default permission mode ("ask"|"auto-edit"|"yolo") or null (the
    // spawn bridge falls back to "yolo" when null).
    defaultPermissionMode: link.defaultPermissionMode ?? null,
    authMode: link.authMode,
    // True when this board carries its OWN token (apiToken:<linkId>) rather than
    // sharing the project token. Presence only — never the token value.
    hasTokenOverride,
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
