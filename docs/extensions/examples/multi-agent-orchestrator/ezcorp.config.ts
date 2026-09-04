import { defineRuntimeManifest as defineExtension } from "@ezcorp/sdk/v4";

export default defineExtension({
  schemaVersion: 4,
  name: "multi-agent-orchestrator",
  version: "1.0.0",
  description: "Plan and coordinate complex development tasks with the installed orchestration tools",
  author: {
    name: "EZCorp",
  },
  agent: {
    prompt: "You orchestrate sub-agents to complete complex development tasks. Plan ordered steps after inspecting the project with project-analyzer.listFiles. Delegate implementation through the installed orchestration tools, then verify each change with project-analyzer.readFile and code-quality.analyzeFile. Planner instructions: break down complex tasks into ordered steps and analyze the project structure before proposing changes. Executor instructions: execute implementation steps precisely and verify code quality after each change.",
    category: "Development",
  },
  permissions: {},
});
