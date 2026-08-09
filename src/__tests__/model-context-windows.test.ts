import { describe, expect, test } from "bun:test";
import {
  FALLBACK_CONTEXT_WINDOW,
  capForModel,
  describeWindowCorrection,
  normalizeModelId,
  resolveContextWindow,
} from "../runtime/routing/model-context-windows";

describe("normalizeModelId", () => {
  test("passes a bare id through, lowercased and trimmed", () => {
    expect(normalizeModelId("  Claude-Sonnet-4-5  ")).toBe("claude-sonnet-4-5");
  });

  test("strips a vendor prefix", () => {
    expect(normalizeModelId("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4.5");
  });

  test("strips a variant suffix after the colon", () => {
    expect(normalizeModelId("anthropic/claude-sonnet-4.5:batch")).toBe("claude-sonnet-4.5");
    expect(normalizeModelId("qwen/qwen3-coder:free")).toBe("qwen3-coder");
  });

  test("strips a bedrock region prefix", () => {
    expect(normalizeModelId("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
      "claude-sonnet-4-5-20250929",
    );
    expect(normalizeModelId("global.anthropic.claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  test("leaves an unrecognised shape alone", () => {
    expect(normalizeModelId("gpt-5-codex")).toBe("gpt-5-codex");
  });

  test("keeps the suffix when the slash is the last structure", () => {
    expect(normalizeModelId("openrouter/auto")).toBe("auto");
  });
});

describe("capForModel — Sonnet 4/4.5 correction", () => {
  // The whole point of the table: these are the ids the installed catalog
  // overstates at 1M.
  test.each([
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-sonnet-4.5:batch",
    "claude-sonnet-4",
    "anthropic/claude-sonnet-4",
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  ])("caps %s to 200k", (id) => {
    expect(capForModel(id, 1_000_000)).toBe(200_000);
  });

  // The correction must never touch the models that really are 1M, or it
  // would trade an over-trim bug for an under-trim one.
  test.each([
    "claude-sonnet-4-6",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-sonnet-4.6:batch",
    "claude-sonnet-5",
    "anthropic/claude-sonnet-5",
    "claude-opus-4-5",
    "claude-haiku-4-5",
    "gemini-2.5-pro",
  ])("leaves %s untouched", (id) => {
    expect(capForModel(id, 1_000_000)).toBe(1_000_000);
  });

  test("is a ceiling, never an assignment — a smaller declared window survives", () => {
    expect(capForModel("claude-sonnet-4-5", 200_000)).toBe(200_000);
    expect(capForModel("claude-sonnet-4-5", 128_000)).toBe(128_000);
  });

  test("caps github-copilot's larger sonnet-4 number down, never up", () => {
    expect(capForModel("claude-sonnet-4", 216_000)).toBe(200_000);
  });
});

describe("resolveContextWindow", () => {
  test("a declared window is used and is NOT estimated", () => {
    expect(resolveContextWindow("anthropic", "claude-opus-4-5", 200_000)).toEqual({
      contextWindow: 200_000,
      estimated: false,
    });
  });

  test("a corrected window is still not estimated — it is more certain, not less", () => {
    expect(resolveContextWindow("anthropic", "claude-sonnet-4-5", 1_000_000)).toEqual({
      contextWindow: 200_000,
      estimated: false,
    });
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ] as const)("falls back and marks estimated for %s", (_label, declared) => {
    expect(resolveContextWindow("openai", "gpt-5-codex", declared)).toEqual({
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      estimated: true,
    });
  });

  test("Infinity specifically does not leak through as a window", () => {
    // A non-finite window makes computeInputBudget produce NaN, which disables
    // every `<= budget` comparison downstream.
    const { contextWindow } = resolveContextWindow("x", "y", Number.POSITIVE_INFINITY);
    expect(Number.isFinite(contextWindow)).toBe(true);
  });
});

describe("describeWindowCorrection", () => {
  test("explains a correction that fired, naming both numbers", () => {
    const msg = describeWindowCorrection("claude-sonnet-4-5", 1_000_000);
    expect(msg).toContain("claude-sonnet-4-5");
    expect(msg).toContain("1,000,000");
    expect(msg).toContain("200,000");
    expect(msg).toContain("context-1m beta header");
  });

  test("is null when the declared window is already at the cap", () => {
    expect(describeWindowCorrection("claude-sonnet-4-5", 200_000)).toBeNull();
  });

  test("is null when the declared window is below the cap", () => {
    expect(describeWindowCorrection("claude-sonnet-4-5", 128_000)).toBeNull();
  });

  test("is null for a model with no correction", () => {
    expect(describeWindowCorrection("claude-sonnet-5", 1_000_000)).toBeNull();
  });
});
