import { test, expect, describe } from "bun:test";
import { composeAgent, type CompositionContext } from "../runtime/config-to-agent";

const configs = {
  researcher: {
    name: "researcher",
    description: "Researches topics",
    capabilities: ["llm" as const],
    prompt: "You are a researcher.",
  },
  writer: {
    name: "writer",
    description: "Writes content",
    capabilities: ["llm" as const],
    prompt: "You are a writer.",
  },
  reviewer: {
    name: "reviewer",
    description: "Reviews content",
    capabilities: ["llm" as const],
    prompt: "You are a reviewer.",
  },
  summarizer: {
    name: "summarizer",
    description: "Summarizes content",
    capabilities: ["llm" as const],
    prompt: "You are a summarizer.",
  },
};

function ctxAt(depth: number, maxDepth = 3, timeout = 30_000): CompositionContext {
  return { depth, maxDepth, timeout };
}

describe("composeAgent", () => {
  // ── Unit Tests ──────────────────────────────────────────────────────

  test("compose at depth 0 succeeds", () => {
    const result = composeAgent(configs.researcher, ctxAt(0));
    expect(result.agent).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  test("compose at depth 1 succeeds", () => {
    const result = composeAgent(configs.writer, ctxAt(1));
    expect(result.agent).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  test("compose at depth 2 succeeds", () => {
    const result = composeAgent(configs.reviewer, ctxAt(2));
    expect(result.agent).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  test("compose at depth 3 (maxDepth=3) returns error", () => {
    const result = composeAgent(configs.summarizer, ctxAt(3, 3));
    expect(result.agent).toBeUndefined();
    expect(result.error).toContain("Max composition depth reached (3)");
    expect(result.error).toContain("summarizer");
  });

  test("custom maxDepth(5) — depth 4 succeeds, depth 5 fails", () => {
    const r1 = composeAgent(configs.researcher, ctxAt(4, 5));
    expect(r1.agent).toBeDefined();
    expect(r1.error).toBeUndefined();

    const r2 = composeAgent(configs.researcher, ctxAt(5, 5));
    expect(r2.agent).toBeUndefined();
    expect(r2.error).toContain("Max composition depth reached (5)");
  });

  test("default context (no ctx) succeeds with defaults", () => {
    const result = composeAgent(configs.researcher);
    expect(result.agent).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.timeout).toBe(30_000);
  });

  test("timeout value propagates correctly", () => {
    const result = composeAgent(configs.researcher, ctxAt(0, 3, 60_000));
    expect(result.timeout).toBe(60_000);
  });

  test("error message includes agent name", () => {
    const result = composeAgent(configs.writer, ctxAt(3, 3));
    expect(result.error).toContain("writer");
  });

  test("returned agent has correct name/description/capabilities", () => {
    const result = composeAgent(configs.researcher, ctxAt(0));
    const agent = result.agent!;
    expect(agent.name).toBe("researcher");
    expect(agent.description).toBe("Researches topics");
    expect(agent.capabilities).toEqual(["llm"]);
  });

  test("multiple agents composed at same depth level", () => {
    const r1 = composeAgent(configs.researcher, ctxAt(1));
    const r2 = composeAgent(configs.writer, ctxAt(1));
    const r3 = composeAgent(configs.reviewer, ctxAt(1));

    expect(r1.agent).toBeDefined();
    expect(r2.agent).toBeDefined();
    expect(r3.agent).toBeDefined();
    expect(r1.agent!.name).toBe("researcher");
    expect(r2.agent!.name).toBe("writer");
    expect(r3.agent!.name).toBe("reviewer");
  });

  test("agent execute function exists and is callable", () => {
    const result = composeAgent(configs.researcher, ctxAt(0));
    expect(typeof result.agent!.execute).toBe("function");
  });

  // ── Integration Test ────────────────────────────────────────────────

  describe("chained composition pipeline", () => {
    test("researcher(0) -> writer(1) -> reviewer(2) succeed, summarizer(3) fails", () => {
      const r0 = composeAgent(configs.researcher, ctxAt(0));
      expect(r0.agent).toBeDefined();

      const r1 = composeAgent(configs.writer, ctxAt(1));
      expect(r1.agent).toBeDefined();

      const r2 = composeAgent(configs.reviewer, ctxAt(2));
      expect(r2.agent).toBeDefined();

      const r3 = composeAgent(configs.summarizer, ctxAt(3));
      expect(r3.agent).toBeUndefined();
      expect(r3.error).toContain("Max composition depth reached");
      expect(r3.error).toContain("summarizer");
    });
  });
});
