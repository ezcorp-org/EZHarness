/**
 * progress.ts — HOST-DETERMINISTIC ticket write-back helpers.
 *
 * Pure builders + best-effort side-effects for posting comments and moving
 * cards on GitHub when a board-triggered run starts, completes, or fails.
 *
 * Design rules:
 *   - Side-effect functions NEVER throw — they swallow + log warn and return
 *     a boolean indicating whether the operation succeeded.
 *   - The GitHub auth token is NEVER logged (the security invariant from auth.ts).
 *   - The GitHub client + auth resolver are injected via `deps` so all paths are
 *     pure-unit-testable with fakes and no network traffic.
 *   - No audit-log writes here — observability is logging only.
 */
import { extensionLogger } from "../../logger";
import { createGithubClient } from "./client";
import { resolveLinkAuth } from "./auth";
import type { GithubClient } from "./types";
import type { GithubProjectsLink, GithubProjectsProposal } from "../../db/schema";
import type { GithubColumnAction } from "./types";

const log = extensionLogger("github-projects", "progress");

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Map a proposal action to a present-continuous verb for display strings. */
export function actionVerb(action: "plan" | "execute"): "planning" | "implementing" {
  return action === "execute" ? "implementing" : "planning";
}

/**
 * Build the start-of-run comment body posted when a board-triggered run is
 * launched (best-effort; written by the HOST, not the LLM).
 */
export function buildStartComment(proposal: GithubProjectsProposal): string {
  const verb = actionVerb(proposal.action);
  return `🤖 EZCorp started **${verb}** this ticket.`;
}

/**
 * Build the done-run comment body. Includes an optional summary block (trimmed
 * to `summarize` limits) and a PR link when the run output mentions one.
 */
export function buildDoneComment(
  proposal: GithubProjectsProposal,
  opts: { summary?: string; prUrl?: string } = {},
): string {
  const heading =
    proposal.action === "execute" ? "✅ **Work complete.**" : "✅ **Plan ready.**";
  const parts: string[] = [heading];
  if (opts.summary) {
    parts.push("", opts.summary);
  }
  if (opts.prUrl) {
    parts.push("", `Pull request: ${opts.prUrl}`);
  }
  return parts.join("\n");
}

/**
 * Build the failure-run comment body. Includes the error message when
 * available.
 */
export function buildFailedComment(
  _proposal: GithubProjectsProposal,
  error?: string,
): string {
  const detail = error ? `: ${error}` : "";
  return `❌ Run failed${detail}`;
}

/**
 * Extract the first GitHub pull-request URL from arbitrary text.
 * Handles null/undefined input (returns null).
 * Pattern: https://github.com/<owner>/<repo>/pull/<n>
 */
export function extractPrUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/);
  return match ? match[0] : null;
}

/**
 * Trim whitespace and truncate to `max` characters with a trailing ellipsis
 * when the text exceeds the cap. Blank / whitespace-only input → "".
 */
export function summarize(text: string | null | undefined, max = 600): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max) + "…";
}

// ── Dependency injection seam ───────────────────────────────────────────────

export interface ProgressDeps {
  /** The GitHub client to use. Default: `createGithubClient()`. */
  client?: GithubClient;
  /**
   * Auth resolver. Default: `resolveLinkAuth`.
   * Accepts the same signature so tests can inject a fixed token.
   */
  resolveAuth?: (link: Pick<GithubProjectsLink, "authMode" | "projectId">) => Promise<{ mode: string; token: string }>;
}

// ── Side-effect functions ───────────────────────────────────────────────────

/**
 * Post a comment on the card's underlying issue/PR (if any).
 *
 * - Returns false (no-op) when `proposal.contentNodeId` is null — draft cards
 *   with no linked issue don't support comments.
 * - Returns false (swallowed) on any auth or network error; logs warn (NO token).
 * - Returns true on success.
 */
export async function postTicketComment(
  link: GithubProjectsLink,
  proposal: GithubProjectsProposal,
  body: string,
  deps: ProgressDeps = {},
): Promise<boolean> {
  if (!proposal.contentNodeId) {
    log.debug("postTicketComment: skipping draft card (no contentNodeId)", {
      proposalId: proposal.id,
    });
    return false;
  }
  try {
    const auth = await (deps.resolveAuth ?? resolveLinkAuth)(link);
    const client = deps.client ?? createGithubClient();
    await client.addComment(auth as never, proposal.contentNodeId, body);
    log.info("postTicketComment: comment posted", { proposalId: proposal.id });
    return true;
  } catch (err) {
    log.warn("postTicketComment: failed (swallowed)", {
      proposalId: proposal.id,
      error: String(err),
      // Never log the token — only log the error message.
    });
    return false;
  }
}

/**
 * Move the card to the `doneStatusOptionId` column defined on the triggering
 * column action (if any).
 *
 * - Returns false (no-op) when `column` is undefined or has no
 *   `doneStatusOptionId` set.
 * - Returns false (swallowed) on any error; logs warn.
 * - Returns true on success.
 */
export async function moveCardOnDone(
  link: GithubProjectsLink,
  proposal: GithubProjectsProposal,
  column: GithubColumnAction | undefined,
  deps: ProgressDeps = {},
): Promise<boolean> {
  if (!column?.doneStatusOptionId) {
    return false;
  }
  try {
    const auth = await (deps.resolveAuth ?? resolveLinkAuth)(link);
    const client = deps.client ?? createGithubClient();
    await client.setItemStatus(link.boardNodeId, auth as never, proposal.itemNodeId, column.doneStatusOptionId);
    log.info("moveCardOnDone: card moved", {
      proposalId: proposal.id,
      doneStatusOptionId: column.doneStatusOptionId,
    });
    return true;
  } catch (err) {
    log.warn("moveCardOnDone: failed (swallowed)", {
      proposalId: proposal.id,
      error: String(err),
    });
    return false;
  }
}
