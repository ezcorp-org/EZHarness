import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "multi-agent-orchestrator",
  version: "1.0.0",
  description: "Orchestrate sub-agents to complete complex development tasks (forward-looking manifest shape)",
  author: {
    name: "EzCorp",
  },
  agent: {
    prompt: "You orchestrate sub-agents to complete complex development tasks.",
    category: "Development",
  },
  subAgents: [
    {
      name: "planner",
      prompt: "Break down complex tasks into ordered steps. Analyze the project structure before proposing changes.",
      tools: ["project-analyzer.listFiles"],
    },
    {
      name: "executor",
      prompt: "Execute implementation steps precisely. Verify code quality after each change.",
      tools: ["code-quality.analyzeFile", "project-analyzer.readFile"],
    },
  ],
  permissions: {},
});
