// repo-activity-notify — the reference "check → notify" trust-probe manifest.
//
// Declares the two triggers the loop wires (an hourly cron + an on-demand
// manual tool) and the grants a read-only notify loop needs: storage (the
// run store + the durable check cursor), shell (the deterministic `git`
// HEAD read in `check`), appendMessages (the one-line notice), and a
// filesystem path for the artifact mirror. There is NO `llm` grant and NO
// `spawnAgents` grant — this loop never reaches a model.

import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "repo-activity-notify",
  version: "1.0.0",
  description:
    "Reference check-stage trust probe — a read-only loop that notices new git commits (deterministic git-cursor check, no LLM) and appends a one-line notice to its wired conversation plus an artifact mirror.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  category: "Examples",
  tags: ["loop", "check", "example", "reference"],
  // Cron + manual loop — stay resident so the hourly fire isn't dropped on idle.
  persistent: true,

  settings: {
    enabled: {
      type: "boolean",
      label: "Enabled",
      description: "Notice new commits on the active repo.",
      default: true,
    },
    repo_path: {
      type: "text",
      label: "Repository path (override)",
      description: "Absolute path to the git repo to watch. Defaults to the active project.",
      default: "",
    },
    conversation_id: {
      type: "text",
      label: "Notify conversation id",
      description: "Conversation the one-line notice is appended to. Blank = artifact-only.",
      default: "",
    },
  },

  tools: [
    {
      name: "check_repo_activity",
      description:
        "Run the repo-activity-notify loop on demand: check for new commits since the last run and, if any, append a one-line notice + write an artifact.",
      inputSchema: { type: "object", properties: {} },
    },
  ],

  permissions: {
    // Self-tracked run records + the durable check cursor.
    storage: true,
    // The check reads git HEAD via `git log -1` (deterministic, read-only).
    shell: true,
    // The notice is an excluded role:extension turn (host forces excluded).
    appendMessages: { excludedDefault: true },
    // The artifact mirror lands under .ezcorp/extension-data/repo-activity-notify/.
    filesystem: ["$CWD"],
    // The hourly sweep.
    schedule: { crons: ["0 * * * *"] },
  },

  resources: { memory: "128MB" },
});
