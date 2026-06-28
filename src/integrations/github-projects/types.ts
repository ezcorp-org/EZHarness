/**
 * github-projects integration — the FROZEN shared contract.
 *
 * This file is the single source of truth for the cross-module interfaces of
 * the GitHub Projects integration (Phase 0). It is imported by `db/schema.ts`
 * (a few enum-ish types) and by every integration module, so it MUST NOT import
 * from `db/schema` (that would create a cycle). Row types (`GithubProjectsLink`,
 * `GithubProjectsProposal`) are inferred in `db/schema.ts` and imported FROM
 * there by callers — not re-declared here.
 *
 * Security invariants encoded here (see the approved plan):
 *   - The GitHub token is HOST-ONLY. No sandbox/subprocess type carries it.
 *   - Reverse-RPC params NEVER carry a board id — the host derives the board
 *     from the conversation's projectId (confused-deputy fix).
 *   - Spawned runs are pinned to a non-`yolo`, PDP-gated permission mode.
 */

// ── Column → action mapping (stored on the link row) ───────────────────────

/** What a triggering column does: plan the work, or execute it. */
export type GithubProposalAction = "plan" | "execute";

/**
 * Permission mode a board-triggered run may use. NEVER `yolo`/`bypassPermissions`
 * for these runs — the spawn bridge pins one of these explicitly so a board move
 * can never inherit the platform default (yolo) and auto-run tools unprompted.
 */
export type GithubSpawnPermissionMode = "default" | "plan" | "acceptEdits";

/** What one Status-field option (column) does when a card enters it. */
export interface GithubColumnAction {
  action: GithubProposalAction;
  /** Agent config name to dispatch (omit → default agent for the action). */
  agentName?: string;
  /**
   * true  = auto-spawn the run the moment a card enters this column
   *         (per-board opt-in; surfaced with a loud warning in the UI).
   * false = create a PENDING proposal the user approves on the Hub (default).
   */
  autoSpawn: boolean;
  /** Permission mode for the spawned run. Defaults to "default" (PDP-gated). */
  permissionMode?: GithubSpawnPermissionMode;
  /**
   * Status option id to move the card into when a board-triggered run for this
   * column COMPLETES successfully (e.g. a "plan" column → an "In review" option).
   * Must be one of the board's Status options (validated host-side). Omit = leave
   * the card where it is. Stored in the existing `columnActionMap` jsonb, so no
   * schema/migration change.
   */
  doneStatusOptionId?: string;
}

/** statusOptionId → action. Options absent from this map never trigger. */
export type GithubColumnActionMap = Record<string, GithubColumnAction>;

/** Lifecycle of a proposal (the queue unit). */
export type GithubProposalStatus =
  | "pending"
  | "approved"
  | "spawned"
  | "running"
  | "done"
  | "failed"
  | "dismissed"
  | "cancelled";

// ── Auth (host-only) ───────────────────────────────────────────────────────

export type GithubAuthMode = "pat" | "gh";

/** Resolved bearer credential. Constructed and used ONLY in trusted host code. */
export interface GithubAuth {
  mode: GithubAuthMode;
  /** Decrypted PAT, or the output of `gh auth token`. Never logged, never to sandbox. */
  token: string;
}

// ── GitHub client surface (Agent A implements `client.ts`) ─────────────────
// Every call pins its request origin to https://api.github.com (SSRF guard).

export interface GithubStatusOption {
  id: string;
  name: string;
}

/** Output of resolveBoardFromUrl — the connect flow's resolution step. */
export interface GithubBoardRef {
  boardNodeId: string; // PVT_…
  title: string;
  ownerLogin: string;
  statusFieldId: string;
  statusOptions: GithubStatusOption[];
}

/** A board item (card) as the poller sees it. */
export interface GithubBoardItem {
  itemNodeId: string;
  contentNodeId: string | null; // issue/draft node id (null for some drafts)
  title: string;
  url: string | null;
  statusOptionId: string | null; // null = no Status set
  statusName: string | null;
  updatedAt: string; // ISO 8601 — the cursor high-water source
}

export interface GithubFetchPage {
  items: GithubBoardItem[];
  /** Merged per-item updatedAt high-water marks (the next poll cursor). */
  cursor: Record<string, string>;
}

/** Result of validating an auth token against a board. */
export interface GithubAuthValidation {
  ok: boolean;
  scopes: string[]; // best-effort, from x-oauth-scopes header
  missingScopes: string[]; // named for the UI
  error?: string;
}

export interface GithubCreateTicketInput {
  title: string;
  body?: string;
  statusName?: string;
}
export interface GithubUpdateTicketInput {
  itemNodeId: string;
  title?: string;
  body?: string;
  statusName?: string;
}
export interface GithubTicketRef {
  itemNodeId: string;
  contentNodeId: string | null;
  url: string | null;
  title: string;
}

/** The host GitHub client. Agent A implements `createGithubClient()` → this. */
export interface GithubClient {
  resolveBoardFromUrl(boardUrl: string, auth: GithubAuth): Promise<GithubBoardRef>;
  validateAuth(auth: GithubAuth, boardNodeId: string): Promise<GithubAuthValidation>;
  fetchBoardItems(
    boardNodeId: string,
    auth: GithubAuth,
    cursor: Record<string, string> | null,
  ): Promise<GithubFetchPage>;
  createIssueOnBoard(
    boardNodeId: string,
    auth: GithubAuth,
    input: GithubCreateTicketInput,
  ): Promise<GithubTicketRef>;
  updateItem(
    boardNodeId: string,
    auth: GithubAuth,
    input: GithubUpdateTicketInput,
  ): Promise<GithubTicketRef>;
  setItemStatus(
    boardNodeId: string,
    auth: GithubAuth,
    itemNodeId: string,
    statusOptionId: string,
  ): Promise<void>;
  archiveItem(boardNodeId: string, auth: GithubAuth, itemNodeId: string): Promise<void>;
  addComment(auth: GithubAuth, contentNodeId: string, body: string): Promise<void>;
}

/** Thrown by the client when a request would target a non-GitHub host (SSRF). */
export class GithubHostNotAllowedError extends Error {}
/** Thrown on 401 (revoked/invalid token) so the daemon can degrade + surface. */
export class GithubAuthError extends Error {}
/** Thrown on 404 (board/item gone) so the daemon can degrade + surface. */
export class GithubNotFoundError extends Error {}
/** Thrown on 403/secondary-rate-limit so the daemon can back off. */
export class GithubRateLimitError extends Error {
  retryAfterMs?: number;
}

// ── Reverse-RPC contract (Agent C's handler; bundled-only) ─────────────────
// The sandbox extension's ticket tools emit these. The handler derives
// projectId from the conversation and the board from the link — params NEVER
// carry a board id.

export const GITHUB_PROJECTS_RPC_PREFIX = "ezcorp/github-projects." as const;

export type GithubProjectsRpcVerb =
  | "list"
  | "create"
  | "update"
  | "move"
  | "archive"
  | "comment";

export interface GithubRpcListParams {
  status?: string;
  limit?: number;
}
export interface GithubRpcCreateParams {
  title: string;
  body?: string;
  statusName?: string;
}
export interface GithubRpcUpdateParams {
  itemNodeId: string;
  title?: string;
  body?: string;
}
export interface GithubRpcMoveParams {
  itemNodeId: string;
  statusName: string;
}
export interface GithubRpcArchiveParams {
  itemNodeId: string;
}
export interface GithubRpcCommentParams {
  itemNodeId: string;
  body: string;
}

// ── Shared constants + pure helpers ────────────────────────────────────────

/** GitHub API origin — the ONLY host the client may contact. */
export const GITHUB_API_ORIGIN = "https://api.github.com" as const;

/**
 * Server-derived idempotency key for a proposal. Deterministic + unique per
 * (project, item, target column, action) so poll re-detection / card churn
 * upsert ON CONFLICT and never double-spawn. NEVER accept this from a client.
 */
export function githubProposalDedupeKey(
  projectId: string,
  itemNodeId: string,
  statusOptionId: string,
  action: GithubProposalAction,
): string {
  return `${projectId}:${itemNodeId}:${statusOptionId}:${action}`;
}

/** The single runtime event name registered in runtime-event-names.ts. */
export const GITHUB_PROJECTS_EVENT = "github-projects:proposal-update" as const;

/** Proposal statuses considered "active work" (Hub Active section). */
export const GITHUB_ACTIVE_STATUSES: readonly GithubProposalStatus[] = [
  "pending",
  "approved",
  "spawned",
  "running",
] as const;

/** Proposal statuses considered terminal (Hub History section). */
export const GITHUB_TERMINAL_STATUSES: readonly GithubProposalStatus[] = [
  "done",
  "failed",
  "dismissed",
  "cancelled",
] as const;
