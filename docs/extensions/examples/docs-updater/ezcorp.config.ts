// docs-updater — the flagship proactive PR-drafter manifest.
//
// The honest scoping (council decision #8): it DRAFTS a docs PR, a human
// APPROVES, and on the `/repo` self-dev mount the merge stays MANUAL on
// GitHub (auto-merge is deliberately disabled there — respected, never
// worked around). On a non-`/repo` target, approve→merge is permitted
// (settings-driven; used by Phase 8's autonomous-merge demo).
//
// The loop is a full `defineLoop`: a daily cron + on-demand manual tool
// trigger; a deterministic git-cursor `check` (sandboxed `git`, NO LLM);
// a DEFERRED `act` that spawns a coding agent; an `onComplete` that turns
// the agent's completion into a `proposal` (kind `pr`); and a Hub dashboard
// whose per-run approve/decline row actions resolve the proposal through
// the primitive-owned `approveRun`/`declineRun`.
//
// Grants are minimal + purpose-scoped: storage (run store + the check
// cursor + labels), shell (the git-cursor check + the sandboxed `gh`
// pipeline), spawnAgents (the deferred coding agent), filesystem ($CWD —
// the artifact mirror + reading the repo `.git`), network (api.github.com
// for `gh`), a daily cron, the approve/decline page-action events, the
// deferred-completion event, loopEvents (the content-free approval nudges),
// and one Hub page.

import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "docs-updater",
  version: "1.0.0",
  description:
    "Flagship proactive PR-drafter: on new merged commits it dispatches a coding agent to update README / docs, drafts a pull request, and parks it for human approval. On the /repo self-dev mount the merge stays manual on GitHub; on other targets approve can merge (settings).",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  category: "Development",
  tags: ["loop", "approval", "pr", "docs", "flagship"],
  // Cron + manual loop — stay resident so the daily fire isn't dropped on idle
  // and the in-memory finalize/discard closures survive between park + approve.
  persistent: true,

  settings: {
    enabled: {
      type: "boolean",
      label: "Enabled",
      description: "Draft docs PRs when new commits land on the watched repo.",
      default: true,
    },
    repo_path: {
      type: "text",
      label: "Repository path (override)",
      description:
        "Absolute path to the git repo to watch + draft against. Blank = the active project (EZCORP_PROJECT_ROOT), e.g. the /repo self-dev mount.",
      default: "",
    },
    agent_name: {
      type: "text",
      label: "Coding agent",
      description: "Name of the agent config dispatched to update the docs.",
      default: "coder",
    },
    write_paths: {
      type: "text",
      label: "Docs write scope",
      description:
        "Comma-separated path prefixes the drafted PR may touch (the write-scope jail). A PR that changes anything outside these is refused at approval — grants, not prompt hope.",
      default: "README.md,docs/",
    },
    auto_merge: {
      type: "boolean",
      label: "Merge on approve (non-/repo only)",
      description:
        "When ON, approving a PR on a NON-/repo target also merges it. IGNORED on the /repo self-dev mount, where merge always stays manual on GitHub.",
      default: false,
    },
  },

  tools: [
    {
      name: "run_docs_update",
      description:
        "Run docs-updater on demand: check for new commits since the last review and, if any, dispatch a coding agent to draft a docs PR for approval.",
      inputSchema: { type: "object", properties: {} },
    },
  ],

  // Hub page declaration (Extension Pages Hub). Declaring the page IS the
  // grant — the dashboard tab appears at /hub/ext:docs-updater:dashboard.
  // Its per-run approve/decline buttons dispatch the eventSubscriptions
  // events below; the page-tree validator drops any action naming an
  // undeclared event.
  pages: [
    {
      id: "dashboard",
      title: "docs-updater",
      icon: "FileText",
      description:
        "Drafted docs PRs — status badges, a live run table, and per-run Approve / Decline actions that resolve the proposal through the loop primitive.",
    },
  ],

  permissions: {
    // Self-tracked run records + the durable check cursor + the LOCKED
    // approval-label store.
    storage: true,
    // The git-cursor check reads git HEAD; the sandboxed `gh` pipeline marks
    // / merges / closes the PR at approval time.
    shell: true,
    // The deferred `act` dispatches a coding agent to update the docs.
    spawnAgents: { maxPerHour: 12, maxConcurrent: 2 },
    // The artifact mirror lands under .ezcorp/extension-data/docs-updater/;
    // the `gh` pipeline reads the repo's `.git` to resolve the PR ($CWD).
    filesystem: ["$CWD"],
    // `gh` reaches the GitHub API (and git push over https).
    network: ["api.github.com"],
    // The content-free approval nudges (loops:approval_pending / _resolved).
    loopEvents: true,
    // Subscribe to the deferred agent's completion + the dashboard's per-run
    // approve/decline buttons. The page-tree validator drops any action node
    // naming an event not in this allowlist.
    eventSubscriptions: [
      "task:assignment_update",
      "docs-updater:approve",
      "docs-updater:decline",
    ],
    // The daily sweep. The host refuses any cron not listed here.
    schedule: {
      crons: ["0 6 * * *"],
      maxRunsPerDay: 4,
      purpose:
        "Daily docs-updater sweep — check for new commits and, if any, draft a docs PR for approval.",
    },
  },

  resources: { memory: "128MB" },
});
