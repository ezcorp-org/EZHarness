import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../connection";
import {
  githubProjectsLinks,
  githubProjectsProposals,
  type GithubProjectsLink,
  type GithubProjectsProposal,
  type NewGithubProjectsLink,
  type NewGithubProjectsProposal,
} from "../schema";
import {
  GITHUB_ACTIVE_STATUSES,
  type GithubProposalStatus,
} from "../../integrations/github-projects/types";

/**
 * github-projects integration — DB CRUD primitives (Phase 0 contract).
 *
 * `github_projects_links` is many-per-project: an EZCorp project connects to N
 * boards, each board only once (UNIQUE(project_id, board_node_id)).
 * `github_projects_proposals` is the queue + idempotency unit: every insert
 * goes through `insertProposalIfNew` which relies on the UNIQUE(dedupe_key)
 * index + `ON CONFLICT DO NOTHING`, so poll re-detection / card churn can
 * never double-create a proposal (the daemon's anti-spawn-storm guarantee).
 *
 * SECURITY: callers MUST derive `projectId` server-side (from the conversation
 * or the link), never from sandbox/tool input — these functions trust their
 * arguments.
 */

// Patch shapes for the partial updates. Declared as module-level type aliases
// (not inline multi-line generics in the function signatures) so Bun's
// --coverage never emits drifting per-line DA records for the type-continuation
// lines — a pure type declaration compiles to nothing and is never line-counted.
type LinkUpdatePatch = Partial<Pick<NewGithubProjectsLink, "columnActionMap" | "pollIntervalSec" | "enabled" | "authMode" | "defaultModel" | "defaultPermissionMode" | "statusOptions" | "statusFieldId">>;
type ProposalUpdatePatch = Partial<Pick<NewGithubProjectsProposal, "status" | "conversationId" | "agentRunId" | "decidedAt" | "decidedByUserId" | "finishedAt" | "error">>;

// ── Links ──────────────────────────────────────────────────────────────────

/**
 * The FIRST board linked to a project (oldest by createdAt), or null. A project
 * may now link MANY boards; this convenience is used only where a single board
 * is unambiguous (e.g. the single-board fallback in board derivation). Callers
 * that must address a specific board use `getLinkById` / `listLinksByProjectId`.
 */
export async function getLinkByProjectId(
  projectId: string,
): Promise<GithubProjectsLink | null> {
  if (!projectId) return null;
  const db = getDb();
  const rows = (await db
    .select()
    .from(githubProjectsLinks)
    .where(eq(githubProjectsLinks.projectId, projectId))
    .orderBy(asc(githubProjectsLinks.createdAt))) as GithubProjectsLink[];
  return rows[0] ?? null;
}

/** Every board linked to a project, oldest first (stable card order). */
export async function listLinksByProjectId(
  projectId: string,
): Promise<GithubProjectsLink[]> {
  if (!projectId) return [];
  const db = getDb();
  return (await db
    .select()
    .from(githubProjectsLinks)
    .where(eq(githubProjectsLinks.projectId, projectId))
    .orderBy(asc(githubProjectsLinks.createdAt))) as GithubProjectsLink[];
}

export async function getLinkById(linkId: string): Promise<GithubProjectsLink | null> {
  if (!linkId) return null;
  const db = getDb();
  const rows = (await db
    .select()
    .from(githubProjectsLinks)
    .where(eq(githubProjectsLinks.id, linkId))) as GithubProjectsLink[];
  return rows[0] ?? null;
}

/** Every link the daemon should poll this tick (enabled only — paused skipped). */
export async function listEnabledLinks(): Promise<GithubProjectsLink[]> {
  const db = getDb();
  return (await db
    .select()
    .from(githubProjectsLinks)
    .where(eq(githubProjectsLinks.enabled, true))) as GithubProjectsLink[];
}

/**
 * Connect a board to a project (connect flow). Keyed on
 * (project_id, board_node_id): re-connecting the SAME board UPDATES that board's
 * row (refreshes metadata/columns, resets transient poll state); connecting a
 * DIFFERENT board INSERTS a new row — so a project accrues many boards.
 */
export async function upsertLink(
  input: NewGithubProjectsLink,
): Promise<GithubProjectsLink> {
  const db = getDb();
  const rows = (await db
    .insert(githubProjectsLinks)
    .values(input)
    .onConflictDoUpdate({
      target: [githubProjectsLinks.projectId, githubProjectsLinks.boardNodeId],
      set: {
        boardNodeId: input.boardNodeId,
        boardUrl: input.boardUrl,
        boardTitle: input.boardTitle ?? "",
        ownerLogin: input.ownerLogin ?? "",
        statusFieldId: input.statusFieldId ?? null,
        // A (re)connect refreshes the board's columns so the editor stays in sync.
        statusOptions: input.statusOptions ?? [],
        defaultModel: input.defaultModel ?? null,
        defaultPermissionMode: input.defaultPermissionMode ?? null,
        authMode: input.authMode ?? "pat",
        columnActionMap: input.columnActionMap ?? {},
        enabled: input.enabled ?? true,
        pollIntervalSec: input.pollIntervalSec ?? 60,
        // A fresh connect resets transient poll state.
        pollCursor: null,
        lastError: null,
        lastErrorAt: null,
        updatedAt: new Date(),
      },
    })
    .returning()) as GithubProjectsLink[];
  const row = rows[0];
  if (!row) throw new Error("upsertLink: insert returned no row");
  return row;
}

/** Partial update of user-editable link fields (column map, interval, pause). */
export async function updateLink(
  linkId: string,
  patch: LinkUpdatePatch,
): Promise<GithubProjectsLink | null> {
  const db = getDb();
  const rows = (await db
    .update(githubProjectsLinks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(githubProjectsLinks.id, linkId))
    .returning()) as GithubProjectsLink[];
  return rows[0] ?? null;
}

/** Pause/resume polling without disconnecting (board + token retained). */
export async function setLinkEnabled(
  linkId: string,
  enabled: boolean,
): Promise<GithubProjectsLink | null> {
  return updateLink(linkId, { enabled });
}

/** Daemon writes back the advanced cursor + health after each poll. */
export async function updateLinkPollState(
  linkId: string,
  state: {
    pollCursor?: Record<string, string>;
    lastPolledAt?: Date;
    lastError?: string | null;
    lastErrorAt?: Date | null;
  },
): Promise<void> {
  const db = getDb();
  await db
    .update(githubProjectsLinks)
    .set({ ...state, updatedAt: new Date() })
    .where(eq(githubProjectsLinks.id, linkId));
}

/** Disconnect: drops the link (proposals CASCADE). Token purge is the caller's. */
export async function deleteLink(linkId: string): Promise<void> {
  const db = getDb();
  await db.delete(githubProjectsLinks).where(eq(githubProjectsLinks.id, linkId));
}

// ── Proposals ────────────────────────────────────────────────────────────────

/**
 * Idempotent insert. Returns the new row, or `null` when a proposal with the
 * same server-derived `dedupeKey` already exists (poll re-detection / churn).
 * This is THE anti-double-spawn guarantee — do not bypass it.
 */
export async function insertProposalIfNew(
  input: NewGithubProjectsProposal,
): Promise<GithubProjectsProposal | null> {
  const db = getDb();
  const rows = (await db
    .insert(githubProjectsProposals)
    .values(input)
    .onConflictDoNothing({ target: githubProjectsProposals.dedupeKey })
    .returning()) as GithubProjectsProposal[];
  return rows[0] ?? null;
}

export async function getProposalById(
  id: string,
): Promise<GithubProjectsProposal | null> {
  if (!id) return null;
  const db = getDb();
  const rows = (await db
    .select()
    .from(githubProjectsProposals)
    .where(eq(githubProjectsProposals.id, id))) as GithubProjectsProposal[];
  return rows[0] ?? null;
}

/** Hub queries: list a project's proposals, optionally filtered by status. */
export async function listProposalsByProject(
  projectId: string,
  opts: { statuses?: GithubProposalStatus[]; limit?: number } = {},
): Promise<GithubProjectsProposal[]> {
  if (!projectId) return [];
  const db = getDb();
  const where = opts.statuses?.length
    ? and(
        eq(githubProjectsProposals.projectId, projectId),
        inArray(githubProjectsProposals.status, opts.statuses),
      )
    : eq(githubProjectsProposals.projectId, projectId);
  let q = db
    .select()
    .from(githubProjectsProposals)
    .where(where)
    .orderBy(desc(githubProjectsProposals.proposedAt));
  if (opts.limit && opts.limit > 0) q = q.limit(opts.limit) as typeof q;
  return (await q) as GithubProjectsProposal[];
}

/** Concurrency-cap input: how many proposals are mid-flight for a project. */
export async function countActiveProposalsForProject(
  projectId: string,
): Promise<number> {
  const rows = await listProposalsByProject(projectId, {
    statuses: [...GITHUB_ACTIVE_STATUSES],
  });
  // "approved/spawned/running" are the truly mid-flight ones (pending is queued
  // but not yet consuming a run slot).
  return rows.filter((r) => r.status !== "pending").length;
}

/** Mutate a proposal's lifecycle fields (decide/spawn/finish). */
export async function updateProposal(
  id: string,
  patch: ProposalUpdatePatch,
): Promise<GithubProjectsProposal | null> {
  const db = getDb();
  const rows = (await db
    .update(githubProjectsProposals)
    .set(patch)
    .where(eq(githubProjectsProposals.id, id))
    .returning()) as GithubProjectsProposal[];
  return rows[0] ?? null;
}

/** Find the proposal owning a run (spawn bridge: run:complete → terminal). */
export async function getProposalByRunId(
  agentRunId: string,
): Promise<GithubProjectsProposal | null> {
  if (!agentRunId) return null;
  const db = getDb();
  const rows = (await db
    .select()
    .from(githubProjectsProposals)
    .where(eq(githubProjectsProposals.agentRunId, agentRunId))) as GithubProjectsProposal[];
  return rows[0] ?? null;
}

/**
 * Find the proposal whose spawned conversation is `conversationId`. The spawn
 * bridge stamps the conversation onto the proposal, so a spawned run's ticket
 * tools can resolve WHICH board the run belongs to (multi-board disambiguation):
 * the conversation → its proposal → `proposal.linkId`. Returns the newest match
 * when more than one proposal shares a conversation (none should, but be safe).
 */
export async function getProposalByConversationId(
  conversationId: string,
): Promise<GithubProjectsProposal | null> {
  if (!conversationId) return null;
  const db = getDb();
  const rows = (await db
    .select()
    .from(githubProjectsProposals)
    .where(eq(githubProjectsProposals.conversationId, conversationId))
    .orderBy(desc(githubProjectsProposals.proposedAt))) as GithubProjectsProposal[];
  return rows[0] ?? null;
}

/**
 * Disconnect lifecycle: mark every still-active proposal of a link as
 * `cancelled` so the Hub history is accurate and no orphaned run is "running".
 */
export async function cancelActiveProposalsForLink(linkId: string): Promise<number> {
  const db = getDb();
  const rows = (await db
    .update(githubProjectsProposals)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(
      and(
        eq(githubProjectsProposals.linkId, linkId),
        inArray(githubProjectsProposals.status, [...GITHUB_ACTIVE_STATUSES]),
      ),
    )
    .returning()) as GithubProjectsProposal[];
  return rows.length;
}
