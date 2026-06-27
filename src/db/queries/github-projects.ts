import { and, desc, eq, inArray } from "drizzle-orm";
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
 * `github_projects_links` is 1:1 with an EZCorp project (UNIQUE(project_id)).
 * `github_projects_proposals` is the queue + idempotency unit: every insert
 * goes through `insertProposalIfNew` which relies on the UNIQUE(dedupe_key)
 * index + `ON CONFLICT DO NOTHING`, so poll re-detection / card churn can
 * never double-create a proposal (the daemon's anti-spawn-storm guarantee).
 *
 * SECURITY: callers MUST derive `projectId` server-side (from the conversation
 * or the link), never from sandbox/tool input — these functions trust their
 * arguments.
 */

// ── Links ──────────────────────────────────────────────────────────────────

export async function getLinkByProjectId(
  projectId: string,
): Promise<GithubProjectsLink | null> {
  if (!projectId) return null;
  const db = getDb();
  const rows = (await db
    .select()
    .from(githubProjectsLinks)
    .where(eq(githubProjectsLinks.projectId, projectId))) as GithubProjectsLink[];
  return rows[0] ?? null;
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
 * Create or replace the board connection for a project (connect flow). The
 * UNIQUE(project_id) constraint means a re-connect overwrites the prior board.
 */
export async function upsertLink(
  input: NewGithubProjectsLink,
): Promise<GithubProjectsLink> {
  const db = getDb();
  const rows = (await db
    .insert(githubProjectsLinks)
    .values(input)
    .onConflictDoUpdate({
      target: githubProjectsLinks.projectId,
      set: {
        boardNodeId: input.boardNodeId,
        boardUrl: input.boardUrl,
        boardTitle: input.boardTitle ?? "",
        ownerLogin: input.ownerLogin ?? "",
        statusFieldId: input.statusFieldId ?? null,
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
  patch: Partial<
    Pick<
      NewGithubProjectsLink,
      "columnActionMap" | "pollIntervalSec" | "enabled" | "authMode"
    >
  >,
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
  patch: Partial<
    Pick<
      NewGithubProjectsProposal,
      | "status"
      | "conversationId"
      | "agentRunId"
      | "decidedAt"
      | "decidedByUserId"
      | "finishedAt"
      | "error"
    >
  >,
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
