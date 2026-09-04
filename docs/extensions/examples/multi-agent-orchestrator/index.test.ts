import { expect, test } from "bun:test";
import manifest from "./ezcorp.config";

test("preserves planner and executor guidance in supported agent metadata", () => {
  expect(manifest.schemaVersion).toBe(4);
  expect(manifest.agent.category).toBe("Development");
  expect(manifest.agent.prompt).toContain("Planner instructions");
  expect(manifest.agent.prompt).toContain("Executor instructions");
  expect(manifest.agent.prompt).toContain("project-analyzer.listFiles");
  expect(manifest.agent.prompt).toContain("code-quality.analyzeFile");
  expect("subAgents" in manifest).toBe(false);
  expect(manifest.permissions).toEqual({});
});
