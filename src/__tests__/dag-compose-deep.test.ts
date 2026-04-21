import { test, expect, describe } from "bun:test";
import { detectCycle } from "../runtime/dag-validator";
import { composeAgent, type CompositionContext } from "../runtime/config-to-agent";

// ── detectCycle ─────────────────────────────────────────────────────

describe("detectCycle", () => {
  test("empty graph, no cycle", () => {
    const allRefs = new Map<string, string[]>();
    expect(detectCycle("A", [], allRefs)).toBeNull();
  });

  test("no cycles in simple chain A->B->C", () => {
    const allRefs = new Map([["B", ["C"]], ["C", []]]);
    expect(detectCycle("A", ["B"], allRefs)).toBeNull();
  });

  test("self-reference A->A", () => {
    const allRefs = new Map<string, string[]>();
    const cycle = detectCycle("A", ["A"], allRefs);
    expect(cycle).not.toBeNull();
    expect(cycle).toEqual(["A", "A"]);
  });

  test("two-node cycle A->B->A", () => {
    const allRefs = new Map([["B", ["A"]]]);
    const cycle = detectCycle("A", ["B"], allRefs);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("A");
    expect(cycle).toContain("B");
  });

  test("three-node cycle A->B->C->A", () => {
    const allRefs = new Map([["B", ["C"]], ["C", ["A"]]]);
    const cycle = detectCycle("A", ["B"], allRefs);
    expect(cycle).not.toBeNull();
    expect(cycle![0]).toBe("A");
    expect(cycle![cycle!.length - 1]).toBe("A");
  });

  test("disconnected graph — no false positives", () => {
    const allRefs = new Map([["B", ["C"]], ["C", []], ["D", ["E"]], ["E", []]]);
    expect(detectCycle("A", ["B"], allRefs)).toBeNull();
  });

  test("restores original map state after check", () => {
    const allRefs = new Map([["A", ["X"]], ["B", []]]);
    detectCycle("A", ["B"], allRefs);
    expect(allRefs.get("A")).toEqual(["X"]);
  });

  test("restores map when node was not previously present", () => {
    const allRefs = new Map<string, string[]>();
    detectCycle("NEW", ["X"], allRefs);
    expect(allRefs.has("NEW")).toBe(false);
  });

  test("empty references array — no cycle", () => {
    const allRefs = new Map([["A", ["B"]], ["B", []]]);
    expect(detectCycle("A", [], allRefs)).toBeNull();
  });
});

// ── composeAgent ────────────────────────────────────────────────────

describe("composeAgent", () => {
  const baseConfig = { name: "test", description: "d", capabilities: ["llm" as const], prompt: "p" };

  test("returns agent at depth 0 (default)", () => {
    const result = composeAgent(baseConfig);
    expect(result.agent).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  test("returns error object (not throw) when depth >= maxDepth", () => {
    const ctx: CompositionContext = { depth: 3, maxDepth: 3, timeout: 5000 };
    const result = composeAgent(baseConfig, ctx);
    expect(result.error).toContain("Max composition depth");
    expect(result.agent).toBeUndefined();
  });

  test("default maxDepth is 3", () => {
    const ctx: CompositionContext = { depth: 2, maxDepth: 3, timeout: 5000 };
    const ok = composeAgent(baseConfig, ctx);
    expect(ok.agent).toBeDefined();

    const fail = composeAgent(baseConfig, { depth: 3, maxDepth: 3, timeout: 5000 });
    expect(fail.error).toBeDefined();
  });

  test("returns timeout value", () => {
    const result = composeAgent(baseConfig);
    expect(result.timeout).toBe(30_000);
  });

  test("custom timeout propagates", () => {
    const ctx: CompositionContext = { depth: 0, maxDepth: 3, timeout: 10_000 };
    const result = composeAgent(baseConfig, ctx);
    expect(result.timeout).toBe(10_000);
  });

  test("error message includes agent name", () => {
    const ctx: CompositionContext = { depth: 5, maxDepth: 3, timeout: 5000 };
    const result = composeAgent({ ...baseConfig, name: "myAgent" }, ctx);
    expect(result.error).toContain("myAgent");
  });
});
