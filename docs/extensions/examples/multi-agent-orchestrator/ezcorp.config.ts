import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "multi-agent-orchestrator",
  version: "1.0.0",
  description: "Plan complex development tasks with a focused assistant",
  author: {
    name: "EZCorp",
  },
  agent: {
    prompt: "Break complex development tasks into clear, ordered plans.",
    category: "Development",
  },
  permissions: {},
});
