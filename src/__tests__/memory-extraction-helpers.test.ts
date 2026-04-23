import { test, expect, describe } from "bun:test";
import {
  EXTRACTION_MODELS,
  getExtractionModel,
  EXTRACTION_SYSTEM_PROMPT,
} from "../memory/extraction";

describe("EXTRACTION_MODELS map", () => {
  test("contains entries for the three supported providers", () => {
    expect(EXTRACTION_MODELS).toHaveProperty("anthropic");
    expect(EXTRACTION_MODELS).toHaveProperty("openai");
    expect(EXTRACTION_MODELS).toHaveProperty("google");
  });

  test("all provider entries map to non-empty model strings", () => {
    for (const [provider, model] of Object.entries(EXTRACTION_MODELS)) {
      expect(typeof provider).toBe("string");
      expect(typeof model).toBe("string");
      expect(model.length).toBeGreaterThan(0);
    }
  });

  test("anthropic model is a Claude Haiku variant", () => {
    expect(EXTRACTION_MODELS.anthropic).toMatch(/claude.*haiku/i);
  });

  test("openai model is a mini variant (cheapest tier)", () => {
    expect(EXTRACTION_MODELS.openai).toMatch(/mini/);
  });

  test("google model is a flash-lite variant (cheapest tier)", () => {
    expect(EXTRACTION_MODELS.google).toMatch(/flash-lite/);
  });
});

describe("getExtractionModel", () => {
  test("returns matching model for each known provider", () => {
    for (const provider of Object.keys(EXTRACTION_MODELS)) {
      const r = getExtractionModel(provider);
      expect(r.provider).toBe(provider);
      expect(r.model).toBe(EXTRACTION_MODELS[provider]!);
    }
  });

  test("falls back to google flash-lite for unknown provider", () => {
    const r = getExtractionModel("totally-fake-provider");
    expect(r.provider).toBe("google");
    expect(r.model).toBe("gemini-2.0-flash-lite");
  });

  test("falls back to google for empty string provider", () => {
    const r = getExtractionModel("");
    expect(r.provider).toBe("google");
    expect(r.model).toBe("gemini-2.0-flash-lite");
  });

  test("is case-sensitive (mis-cased provider name falls back)", () => {
    // EXTRACTION_MODELS keys are lowercase — upper-case lookups miss.
    const r = getExtractionModel("Anthropic");
    expect(r.provider).toBe("google");
  });

  test("returns plain object (not a reference into EXTRACTION_MODELS)", () => {
    const r = getExtractionModel("anthropic");
    // Mutating the returned object must not mutate the exported map.
    r.model = "mutated";
    expect(EXTRACTION_MODELS.anthropic).not.toBe("mutated");
  });
});

describe("EXTRACTION_SYSTEM_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof EXTRACTION_SYSTEM_PROMPT).toBe("string");
    expect(EXTRACTION_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  test("names all four memory categories for the LLM", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("preferences");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("biographical");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("technical");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("decisions_goals");
  });

  test("names all three confidence levels", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("high");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("medium");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("low");
  });

  test("requests JSON array output with empty-array fallback", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("JSON array");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("[]");
  });

  test("instructs the LLM NOT to extract transient info", () => {
    // Ensures the prompt still carries the do-not-extract guardrail.
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/Do NOT|not extract/i);
  });

  test("includes messageIds field instruction", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("messageIds");
  });
});
