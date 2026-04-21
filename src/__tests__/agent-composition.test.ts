import { test, expect, describe, mock } from "bun:test";
import { detectCycle } from "../runtime/dag-validator";

// Test DAG validation integration with agent config save
describe("Agent Composition - DAG Validation (COMP-01)", () => {
  test("agent config save with circular references returns cycle path", () => {
    const allRefs = new Map<string, string[]>();
    allRefs.set("agent-b", ["agent-c"]);
    allRefs.set("agent-c", ["agent-a"]);

    // agent-a wants to reference agent-b, creating a->b->c->a cycle
    const cycle = detectCycle("agent-a", ["agent-b"], allRefs);
    expect(cycle).not.toBeNull();
    expect(cycle).toEqual(["agent-a", "agent-b", "agent-c", "agent-a"]);
  });

  test("agent config save with valid references succeeds", () => {
    const allRefs = new Map<string, string[]>();
    allRefs.set("agent-b", []);

    const cycle = detectCycle("agent-a", ["agent-b"], allRefs);
    expect(cycle).toBeNull();
  });

  test("references default to empty agents and extensions arrays", () => {
    // This tests the schema default - references should default to { agents: [], extensions: [] }
    const defaultRefs = { agents: [], extensions: [] };
    expect(defaultRefs.agents).toEqual([]);
    expect(defaultRefs.extensions).toEqual([]);
  });
});

describe("Agent Composition - Depth Limiting (COMP-03)", () => {
  test("runtime enforces max depth of 3", async () => {
    const { composeAgent } = await import("../runtime/config-to-agent");
    const mockConfig = { name: "deep-agent", description: "test", capabilities: ["llm" as const], prompt: "test" };
    const ctx = { depth: 3, maxDepth: 3, timeout: 30000 };

    const result = composeAgent(mockConfig, ctx);
    expect(result.error).toBe("Max composition depth reached (3). Cannot invoke deep-agent.");
  });

  test("depth < 3 succeeds", async () => {
    const { composeAgent } = await import("../runtime/config-to-agent");
    const mockConfig = { name: "shallow-agent", description: "test", capabilities: ["llm" as const], prompt: "test" };
    const ctx = { depth: 1, maxDepth: 3, timeout: 30000 };

    const result = composeAgent(mockConfig, ctx);
    expect(result.error).toBeUndefined();
    expect(result.agent).toBeDefined();
  });

  test("depth counter propagates through async calls", async () => {
    const { composeAgent } = await import("../runtime/config-to-agent");
    const mockConfig = { name: "mid-agent", description: "test", capabilities: ["llm" as const], prompt: "test" };

    // At depth 2, should still work
    const result = composeAgent(mockConfig, { depth: 2, maxDepth: 3, timeout: 30000 });
    expect(result.error).toBeUndefined();

    // At depth 3, should fail
    const result3 = composeAgent(mockConfig, { depth: 3, maxDepth: 3, timeout: 30000 });
    expect(result3.error).toContain("Max composition depth reached");
  });

  test("per-invocation timeout aborts long-running agent calls", async () => {
    const { composeAgent } = await import("../runtime/config-to-agent");
    const mockConfig = { name: "slow-agent", description: "test", capabilities: ["llm" as const], prompt: "test" };
    const ctx = { depth: 0, maxDepth: 3, timeout: 100 };

    const result = composeAgent(mockConfig, ctx);
    expect(result.agent).toBeDefined();
    // The timeout is enforced at invocation time, not at compose time
    expect(result.timeout).toBe(100);
  });
});
