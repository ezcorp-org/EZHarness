import { test, expect } from "bun:test";

test("manifest parses as valid JSON with schemaVersion 2", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  expect(manifest.schemaVersion).toBe(2);
  expect(manifest.name).toBe("multi-agent-orchestrator");
});

test("manifest has agent field", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  expect(manifest.agent).toBeDefined();
  expect(manifest.agent.prompt).toContain("orchestrate");
  expect(manifest.agent.category).toBe("Development");
});

test("manifest has subAgents array with 2 agents", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  expect(manifest.subAgents).toBeArray();
  expect(manifest.subAgents).toHaveLength(2);
});

test("each subAgent has name, prompt, and tools", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  for (const agent of manifest.subAgents) {
    expect(agent.name).toBeString();
    expect(agent.prompt).toBeString();
    expect(agent.tools).toBeArray();
    expect(agent.tools.length).toBeGreaterThan(0);
  }
});

test("planner has project-analyzer.listFiles tool", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  const planner = manifest.subAgents.find((a: { name: string }) => a.name === "planner");
  expect(planner.tools).toContain("project-analyzer.listFiles");
});

test("executor has code-quality and project-analyzer tools", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  const executor = manifest.subAgents.find((a: { name: string }) => a.name === "executor");
  expect(executor.tools).toContain("code-quality.analyzeFile");
  expect(executor.tools).toContain("project-analyzer.readFile");
});

test("manifest has no entrypoint (manifest-only extension)", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  expect(manifest.entrypoint).toBeUndefined();
});
