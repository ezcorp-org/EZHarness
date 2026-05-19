import { defineExtension } from "../../../../src/extensions/sdk/define";

// Static manifest schema for the `invoke_agent` tool. The per-turn
// `agentConfigId` enum is runtime-scoped (derived from the mentioned
// agents on each parent turn) and cannot live in a static manifest, so
// the host's `wireOrchestrationToolsForTurn` helper (commit 4) injects
// it via `extensionToAgentTool`'s `schemaOverride` seam at wire time.
// The manifest schema below is the unconstrained shape — valid on its
// own, tightened per-turn by the host.
const INVOKE_AGENT_SCHEMA = {
  type: "object",
  properties: {
    agentConfigId: {
      type: "string",
      description:
        "The ID of the agent to invoke. Must be one of the agents available for this turn.",
    },
    task: {
      type: "string",
      description: "A clear description of what the agent should do.",
    },
    autonomous: {
      type: "boolean",
      description:
        "When true, the sub-agent autonomously re-prompts itself toward the task until it self-reports completion or hits the cycle cap. Use for open-ended work; omit for a single bounded turn.",
    },
    maxCycles: {
      type: "number",
      description:
        "Cap on autonomous self-continuation cycles (only meaningful when `autonomous` is true). Defaults to 8.",
    },
  },
  required: ["agentConfigId", "task"],
} as const;

export default defineExtension({
  schemaVersion: 2,
  name: "orchestration",
  // Phase 2 of the ask-user migration: the legacy `ask_human` tool
  // and its `orchestrator:human_response` subscription have been
  // removed. The new `ask-user` bundled extension owns the
  // human-in-the-loop surface. This is a permission-shrinking
  // change — the S9 re-approval gate keys on
  // `[network, filesystem, shell, env, storage, lifecycleHooks]`,
  // NOT `eventSubscriptions`, so dropping the subscription does
  // not auto-disable existing installs.
  version: "1.2.0",
  description:
    "Multi-agent orchestration primitives. Provides `invoke_agent` for delegating to a sub-agent within a conversation.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  persistent: true,
  tools: [
    {
      name: "invoke_agent",
      description:
        "Invoke a specialized agent to handle a task. The agent runs as an independent sub-conversation and returns its response. You can call this tool multiple times in parallel for independent tasks.",
      inputSchema: INVOKE_AGENT_SCHEMA as Record<string, unknown>,
    },
  ],
  permissions: {
    agentConfig: "read",
    spawnAgents: { maxPerHour: 500, maxConcurrent: 25 },
    // `task:assignment_update` — required by `invoke_agent`'s two-hop
    //   bridge (Phase 4).
    eventSubscriptions: ["task:assignment_update"],
  },
});
