import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "multi-agent-orchestrator",
  version: "1.0.0",
  description: "Orchestrate complex development tasks with a planning assistant",
  author: {
    name: "EZCorp",
  },
  agent: {
    prompt: "You orchestrate sub-agents to complete complex development tasks.",
    category: "Development",
  },
  permissions: {},
});
