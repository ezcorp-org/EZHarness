import { test, expect } from "bun:test";

async function loadConfig() {
  return (await import(import.meta.dir + "/ezcorp.config.ts")).default;
}

test("config exports a valid object", async () => {
  const manifest = await loadConfig();
  expect(manifest).toBeDefined();
});

test("schemaVersion is 2 (number)", async () => {
  const manifest = await loadConfig();
  expect(manifest.schemaVersion).toBe(2);
  expect(typeof manifest.schemaVersion).toBe("number");
});

test("has required agent fields", async () => {
  const manifest = await loadConfig();
  expect(manifest.agent).toBeDefined();
  expect(manifest.agent.prompt).toBeTypeOf("string");
  expect(manifest.agent.category).toBe("Research");
  expect(manifest.agent.capabilities).toContain("web-search");
  expect(manifest.agent.capabilities).toContain("summarization");
});

test("has modelRequirements", async () => {
  const manifest = await loadConfig();
  const reqs = manifest.agent.modelRequirements;
  expect(reqs).toBeDefined();
  expect(reqs.tier).toBeTypeOf("string");
  expect(reqs.contextWindow).toBe(32000);
});

test("has temperature", async () => {
  const manifest = await loadConfig();
  expect(manifest.agent.temperature).toBe(0.3);
});

test("has no entrypoint (agent-only)", async () => {
  const manifest = await loadConfig();
  expect(manifest.entrypoint).toBeUndefined();
  expect(manifest.tools).toBeUndefined();
});

test("exampleConversations have user/assistant turns", async () => {
  const manifest = await loadConfig();
  const examples = manifest.agent.exampleConversations;
  expect(examples).toHaveLength(2);

  for (const example of examples) {
    expect(example.title).toBeTypeOf("string");
    expect(example.messages.length).toBeGreaterThanOrEqual(2);

    const roles = example.messages.map((m: { role: string }) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
  }
});
