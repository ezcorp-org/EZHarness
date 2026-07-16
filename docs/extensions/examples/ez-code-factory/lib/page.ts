// ── Dashboard tree — pure builder ────────────────────────────────────
//
// The Hub page renders one row per gate run (id, branch, head SHA, status).
// This module is pure: it maps run records to a declarative page tree the host
// renders as native Svelte. No user-specific data is emitted — the tree is the
// SHARED (cross-user cached) Hub page, and gate runs live in the global scope.

import { PageBuilder } from "@ezcorp/sdk/runtime";
import type { HubPageTree } from "@ezcorp/sdk/runtime";
import type { RunRecord, RunStatus } from "./runs";

/** Human badge per run status. */
export const STATUS_BADGE: Record<RunStatus, string> = {
  created: "◌ created",
  worktree_ready: "▶ worktree",
  running: "● running",
  awaiting_approval: "⏸ awaiting approval",
  completed: "✓ completed",
  failed: "✗ failed",
  aborted: "⊘ aborted",
};

/** Statuses that count as "active" (in-flight) on the dashboard. */
const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "created",
  "worktree_ready",
  "running",
  "awaiting_approval",
]);

/** Short head-SHA for the table (first 8 chars). Pure. */
export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/**
 * Build the dashboard tree from a run list (newest first). Pure — no IO. An
 * empty list renders a call-to-action pointing at `init_gate`.
 */
export function buildDashboard(runs: RunRecord[]): HubPageTree {
  const active = runs.filter((r) => ACTIVE_STATUSES.has(r.status)).length;
  const completed = runs.filter((r) => r.status === "completed").length;
  const failed = runs.filter((r) => r.status === "failed" || r.status === "aborted").length;

  const page = new PageBuilder("ez-code-factory")
    .markdownBlock(
      "Runs created by `git push gate <branch>`. Each push lands in the local " +
        "gate repo, whose post-receive hook triggers this extension to record a " +
        "run and materialize a disposable worktree.",
    )
    .stats([
      { label: "Total runs", value: String(runs.length) },
      { label: "Active", value: String(active) },
      { label: "Completed", value: String(completed) },
      { label: "Failed", value: String(failed) },
    ]);

  if (runs.length === 0) {
    page.emptyState(
      "No gate runs yet",
      "Run the `init_gate` tool on this project, then `git push gate <branch>` to intercept a push.",
    );
    return page.build();
  }

  page.table(
    ["Run", "Branch", "Head", "Status", "Updated"],
    runs.map((r) => ({
      cells: [
        r.id,
        r.branch,
        shortSha(r.headSha),
        STATUS_BADGE[r.status],
        r.updatedAt.slice(0, 16).replace("T", " "),
      ],
    })),
  );

  return page.build();
}
