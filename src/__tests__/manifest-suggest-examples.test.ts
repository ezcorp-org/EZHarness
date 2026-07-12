/**
 * Composer-suggestion example phrasings (`suggestExamples`) — manifest
 * validation. Deliberately NOT co-located with ts-manifest-sdk-gaps.test.ts,
 * which `mock.module`s the manifest module; this suite exercises the REAL
 * validator.
 */
import { test, expect, describe } from "bun:test";
import {
  MAX_SUGGEST_EXAMPLE_LENGTH,
  MAX_SUGGEST_EXAMPLES,
  validateManifestV2,
  validateSuggestExamples,
} from "../extensions/manifest";

function collect(value: unknown, path = "suggestExamples"): string[] {
  const errors: string[] = [];
  validateSuggestExamples(path, value, errors);
  return errors;
}

describe("validateSuggestExamples (unit)", () => {
  test("caps are 5 entries / 120 chars", () => {
    expect(MAX_SUGGEST_EXAMPLES).toBe(5);
    expect(MAX_SUGGEST_EXAMPLE_LENGTH).toBe(120);
  });

  test("a valid list of up to 5 entries passes", () => {
    expect(collect(["search the web", "read this page", "find recent news"])).toEqual([]);
    expect(collect(["one two", "two three", "three four", "four five", "five six"])).toEqual([]);
  });

  test("non-array → single error", () => {
    expect(collect("not an array")).toEqual(["suggestExamples must be an array of strings"]);
    expect(collect({})).toEqual(["suggestExamples must be an array of strings"]);
  });

  test("more than 5 entries is rejected", () => {
    expect(collect(["a", "b", "c", "d", "e", "f"])).toContain(
      "suggestExamples must declare at most 5 entries",
    );
  });

  test("non-string entry is rejected with its index", () => {
    expect(collect(["ok phrasing", 42])).toContain("suggestExamples[1] must be a string");
  });

  test("empty / whitespace-only entry is rejected", () => {
    expect(collect(["   "])).toContain("suggestExamples[0] must be a non-empty string");
    expect(collect([""])).toContain("suggestExamples[0] must be a non-empty string");
  });

  test("boundary: 120 chars passes, 121 fails", () => {
    expect(collect(["x".repeat(MAX_SUGGEST_EXAMPLE_LENGTH)])).toEqual([]);
    expect(collect(["x".repeat(MAX_SUGGEST_EXAMPLE_LENGTH + 1)])).toContain(
      "suggestExamples[0] must be at most 120 characters",
    );
  });

  test("length is measured AFTER trimming", () => {
    // 120 non-space chars wrapped in spaces → trims to 120 → passes.
    expect(collect([`  ${"x".repeat(MAX_SUGGEST_EXAMPLE_LENGTH)}  `])).toEqual([]);
  });

  test("duplicates after trimming are rejected", () => {
    expect(collect(["clean up", "  clean up  "])).toContain(
      'suggestExamples[1] "clean up" is a duplicate',
    );
  });

  test("control characters are rejected (NUL could otherwise forge the embedding cache's NUL-delimited tool keys)", () => {
    expect(collect(["clean\u0000up downloads"])).toContain(
      "suggestExamples[0] must not contain control characters",
    );
    expect(collect(["tab\there"])).toContain(
      "suggestExamples[0] must not contain control characters",
    );
    expect(collect(["line\nbreak"])).toContain(
      "suggestExamples[0] must not contain control characters",
    );
    expect(collect(["del\u007fchar"])).toContain(
      "suggestExamples[0] must not contain control characters",
    );
    // Ordinary punctuation and unicode stay legal.
    expect(collect(["clean up my déjà-vu folder, please!"])).toEqual([]);
  });

  test("the path prefix threads through to error strings", () => {
    expect(collect(42, "tools[0].suggestExamples")).toEqual([
      "tools[0].suggestExamples must be an array of strings",
    ]);
  });
});

describe("validateManifestV2 integration", () => {
  const base = {
    schemaVersion: 2 as const,
    name: "demo-ext",
    version: "1.0.0",
    description: "Demo",
    author: { name: "Tester" },
    entrypoint: "./index.ts",
    permissions: {},
  };

  test("absent suggestExamples (tool + top-level) → valid, no errors", () => {
    const res = validateManifestV2({
      ...base,
      tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
    });
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  test("valid per-tool + top-level examples → valid", () => {
    const res = validateManifestV2({
      ...base,
      suggestExamples: ["help me organize my files"],
      tools: [
        {
          name: "t",
          description: "d",
          inputSchema: { type: "object" },
          suggestExamples: ["search the web for bun release notes"],
        },
      ],
    });
    expect(res.valid).toBe(true);
  });

  test("bad per-tool examples surface a `tools[0].suggestExamples` path", () => {
    const res = validateManifestV2({
      ...base,
      tools: [
        {
          name: "t",
          description: "d",
          inputSchema: { type: "object" },
          suggestExamples: ["x".repeat(MAX_SUGGEST_EXAMPLE_LENGTH + 1)],
        },
      ],
    });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("tools[0].suggestExamples[0] must be at most 120 characters");
  });

  test("bad top-level examples surface a `suggestExamples` path", () => {
    const res = validateManifestV2({ ...base, suggestExamples: "nope" });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain("suggestExamples must be an array of strings");
  });
});
