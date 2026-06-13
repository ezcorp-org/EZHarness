import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "ez-code",
  version: "0.1.0",
  description:
    "Warren-style control plane for ephemeral coding-agent runs: dispatch / steer / cancel / list runs from a live Hub dashboard, with cron triggers, branch→PR automation, and persistent agent memory + task queue — operating on the active EZCorp project.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  category: "Development",
  tags: ["hub", "pages", "orchestration", "agents", "control-plane"],

  tools: [
    {
      name: "dispatch_run",
      description:
        "Dispatch an ephemeral coding-agent run on the active project. Spawns a " +
        "sub-agent assignment, persists a run record, and surfaces it live on the " +
        "ez-code Hub dashboard. Returns the run id; subscribe to the dashboard to " +
        "watch status. Optionally enable autonomous self-continuation.",
      inputSchema: {
        type: "object",
        properties: {
          agentName: {
            type: "string",
            description:
              "Name of the agent config to dispatch (e.g. 'coder', 'reviewer').",
          },
          task: {
            type: "string",
            description: "The task prompt the dispatched agent should work on.",
          },
          title: {
            type: "string",
            description: "Optional short label for the run (shown in the dashboard).",
          },
          autonomousContinuation: {
            type: "boolean",
            description:
              "When true, the run self-continues toward its objective until it " +
              "emits a done/blocked sentinel (default false).",
          },
        },
        required: ["agentName", "task"],
      },
    },
    {
      name: "list_runs",
      description:
        "List the coding-agent runs this extension has dispatched, newest first, " +
        "with their current status and latest event.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max runs to return (default 50).",
          },
        },
      },
    },
    {
      name: "steer_run",
      description:
        "Inject a steering message into a dispatched run's sub-conversation, " +
        "nudging the agent mid-flight. Records the steer on the run's event log.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", description: "The run id to steer." },
          message: {
            type: "string",
            description: "The steering instruction to append to the run.",
          },
          parentMessageId: {
            type: "string",
            description:
              "Optional id of the message to anchor the steer to (host requires " +
              "a valid parent in the run's sub-conversation).",
          },
        },
        required: ["runId", "message"],
      },
    },
    {
      name: "cancel_run",
      description:
        "Cancel a live dispatched run (host enforces ownership). Updates the run " +
        "record to cancelled and refreshes the dashboard.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", description: "The run id to cancel." },
        },
        required: ["runId"],
      },
    },
  ],

  // Hub page declaration (Extension Pages Hub). Declaring the page IS the
  // grant — the dashboard tab appears at /hub/ext:ez-code:dashboard once
  // the extension is enabled.
  pages: [
    {
      id: "dashboard",
      title: "ez-code",
      icon: "Rabbit",
      description:
        "Dispatched coding-agent runs — status badges, a live run table, and per-run steer/cancel/PR actions, refreshed via pushPage on every task:assignment_update.",
    },
  ],

  permissions: {
    // Dispatch sub-agent runs (Warren's headline primitive).
    spawnAgents: { maxPerHour: 30, maxConcurrent: 6 },
    // Subscribe to run lifecycle updates so the dashboard tracks status
    // live. The dashboard's per-run action buttons (steer/cancel/open-pr,
    // wired in B2/B3) reuse this allowlist — the page-tree validator drops
    // any action node naming an undeclared event.
    eventSubscriptions: [
      "task:assignment_update",
      "ez-code:steer",
      "ez-code:cancel",
      "ez-code:open-pr",
    ],
    // steer_run injects a turn into a run's sub-conversation via the
    // `ezcorp/append-message` reverse RPC. The host always forces
    // `excluded: true`; `excludedDefault` is reserved for a future tier.
    appendMessages: { excludedDefault: true },
    // Self-tracked run records + event logs (v1 gap: extensions cannot read
    // agent_runs through the SDK, so we persist our own run history).
    storage: true,
    // B3 branch→PR automation runs git/gh under the per-run jailed
    // workspace (ez-sandbox Seam B), scoped to the active project.
    filesystem: ["$CWD"],
  },

  resources: {
    memory: "128MB",
  },
});
