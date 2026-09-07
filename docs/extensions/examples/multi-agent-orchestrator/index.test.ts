import { test, expect } from "bun:test";

test("manifest parses as valid JSON with schemaVersion 2", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  expect(manifest.schemaVersion).toBe(2);
  expect(manifest.name).toBe("multi-agent-orchestrator");
});

test("manifest has agent field", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  expect(manifest.agent).toBeDefined();
  expect(manifest.agent.prompt).toContain("ordered plans");
  expect(manifest.agent.category).toBe("Development");
});

test("manifest has only the supported agent declaration", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  expect("subAgents" in manifest).toBe(false);
  expect(manifest.permissions).toEqual({});
});

test("manifest has no entrypoint (manifest-only extension)", async () => {
  const manifest = ((await import(import.meta.dir + "/ezcorp.config.ts")).default);
  expect(manifest.entrypoint).toBeUndefined();
});
