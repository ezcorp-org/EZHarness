import { describe, test, expect } from "bun:test";
import { truncateOutput } from "../db/queries/conversations";

/**
 * Comprehensive tests for tool output extraction across ALL code paths.
 *
 * The tool_calls DB table stores output as jsonb. There are several shapes:
 * 1. ToolCallResult: { content: [{ type: "text", text: "..." }] }
 * 2. Wrapped ToolCallResult: { content: [{ type: "text", text: "..." }], isError: boolean }
 * 3. Plain string (unlikely in jsonb but possible)
 * 4. Object with text/content/result string fields
 * 5. Arbitrary object fallback
 *
 * The output flows through multiple extraction points:
 * - Backend: truncateOutput() for outputSummary in hydration API
 * - Backend: /api/tool-calls/[id]/output for full output fetch
 * - Frontend: extractToolOutput() for streaming tool calls
 * - Frontend: stringifyError() for inline tool store
 */

// ── truncateOutput: DB → outputSummary path ──────────────────────────

describe("truncateOutput", () => {
  describe("null/undefined", () => {
    test("returns null for null", () => {
      expect(truncateOutput(null)).toBeNull();
    });
    test("returns null for undefined", () => {
      expect(truncateOutput(undefined)).toBeNull();
    });
  });

  describe("string input", () => {
    test("returns string as-is", () => {
      expect(truncateOutput("hello world")).toBe("hello world");
    });
    test("returns first line only", () => {
      expect(truncateOutput("line1\nline2\nline3")).toBe("line1");
    });
    test("truncates long first line with ellipsis", () => {
      const long = "a".repeat(200);
      expect(truncateOutput(long, 120)).toBe("a".repeat(120) + "...");
    });
    test("does not truncate at exactly maxLen", () => {
      const exact = "a".repeat(120);
      expect(truncateOutput(exact, 120)).toBe(exact);
    });
  });

  describe("ToolCallResult shape: { content: [{ type: 'text', text: '...' }] }", () => {
    test("extracts text from single content block", () => {
      const output = { content: [{ type: "text", text: "file contents here" }] };
      expect(truncateOutput(output)).toBe("file contents here");
    });

    test("joins multiple text blocks, returns first line", () => {
      const output = {
        content: [
          { type: "text", text: "line1" },
          { type: "text", text: "line2" },
        ],
      };
      // texts.join("\n") = "line1\nline2", firstLine = "line1"
      expect(truncateOutput(output)).toBe("line1");
    });

    test("handles content block with newlines inside text", () => {
      const output = { content: [{ type: "text", text: "first\nsecond\nthird" }] };
      expect(truncateOutput(output)).toBe("first");
    });

    test("handles builtin tool readFile result", () => {
      const output = { content: [{ type: "text", text: '{\n  "name": "ezcorp-ai"\n}' }] };
      expect(truncateOutput(output)).toBe('{');
    });

    test("handles builtin tool listFiles result", () => {
      const output = {
        content: [{ type: "text", text: "bun.lock\n.planning/\ncompose.yml\npackage.json" }],
      };
      expect(truncateOutput(output)).toBe("bun.lock");
    });

    test("handles builtin tool editFile result", () => {
      const output = {
        content: [{ type: "text", text: 'Replaced in package.json\n1:   "name": "ezcorp-ai",' }],
      };
      expect(truncateOutput(output)).toBe("Replaced in package.json");
    });

    test("handles empty content array - falls back to JSON", () => {
      const output = { content: [] };
      expect(truncateOutput(output)).toBe('{"content":[]}');
    });

    test("handles content with non-text types (e.g. image)", () => {
      const output = { content: [{ type: "image", url: "http://example.com/img.png" }] };
      // No text blocks → falls back to JSON
      const result = truncateOutput(output);
      expect(result).toContain('"type":"image"');
    });

    test("includes isError and details alongside content", () => {
      const output = {
        content: [{ type: "text", text: "Error: file not found" }],
        isError: true,
        details: {},
      };
      expect(truncateOutput(output)).toBe("Error: file not found");
    });

    test("truncates long text content", () => {
      const long = "x".repeat(200);
      const output = { content: [{ type: "text", text: long }] };
      expect(truncateOutput(output, 120)).toBe("x".repeat(120) + "...");
    });
  });

  describe("object with simple string fields", () => {
    test("extracts obj.text if string", () => {
      expect(truncateOutput({ text: "hello" })).toBe("hello");
    });
    test("extracts obj.content if string (not array)", () => {
      expect(truncateOutput({ content: "world" })).toBe("world");
    });
    test("extracts obj.result if string", () => {
      expect(truncateOutput({ result: "done" })).toBe("done");
    });
    test("DOES NOT call String() on non-string obj.text (prevents [object Object])", () => {
      // obj.text is an object - should NOT produce "[object Object]"
      const result = truncateOutput({ text: { nested: "value" } });
      expect(result).not.toBe("[object Object]");
      expect(result).toContain("nested");
    });
    test("DOES NOT call String() on non-string obj.content (non-array)", () => {
      // obj.content is an object but not array - should NOT produce "[object Object]"
      const result = truncateOutput({ content: { nested: "value" } });
      expect(result).not.toBe("[object Object]");
      expect(result).toContain("nested");
    });
  });

  describe("fallback to JSON.stringify", () => {
    test("unknown object shape", () => {
      expect(truncateOutput({ foo: "bar" })).toBe('{"foo":"bar"}');
    });
    test("number", () => {
      expect(truncateOutput(42)).toBe("42");
    });
    test("boolean", () => {
      expect(truncateOutput(true)).toBe("true");
    });
  });
});

// ── Frontend extraction: mirrors extractToolOutput from stores.svelte.ts ──

function extractToolOutput(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.content)) {
    const texts = (obj.content as any[])
      .filter((c: any) => c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text);
    if (texts.length > 0) return texts.join("\n");
  }
  return value;
}

describe("extractToolOutput (streaming path)", () => {
  test("returns null/undefined as-is", () => {
    expect(extractToolOutput(null)).toBeNull();
    expect(extractToolOutput(undefined)).toBeUndefined();
  });

  test("returns string as-is", () => {
    expect(extractToolOutput("hello")).toBe("hello");
  });

  test("returns number as-is", () => {
    expect(extractToolOutput(42)).toBe(42);
  });

  test("extracts text from ToolCallResult", () => {
    const result = { content: [{ type: "text", text: "file contents" }], isError: false };
    expect(extractToolOutput(result)).toBe("file contents");
  });

  test("joins multiple text blocks with newlines", () => {
    const result = {
      content: [
        { type: "text", text: "block1" },
        { type: "text", text: "block2" },
      ],
    };
    expect(extractToolOutput(result)).toBe("block1\nblock2");
  });

  test("returns object as-is if content array has no text blocks", () => {
    const result = { content: [] };
    expect(extractToolOutput(result)).toEqual({ content: [] });
  });

  test("returns object as-is if no content array", () => {
    const obj = { foo: "bar" };
    expect(extractToolOutput(obj)).toEqual({ foo: "bar" });
  });

  test("handles builtin tool listFiles output", () => {
    const result = {
      content: [{ type: "text", text: "bun.lock\n.planning/\ncompose.yml" }],
      details: {},
    };
    expect(extractToolOutput(result)).toBe("bun.lock\n.planning/\ncompose.yml");
  });

  test("handles builtin tool readFile output", () => {
    const result = {
      content: [{ type: "text", text: '{\n  "name": "ezcorp-ai"\n}' }],
      details: {},
    };
    expect(extractToolOutput(result)).toBe('{\n  "name": "ezcorp-ai"\n}');
  });
});

// ── Frontend stringifyError: mirrors inline-tool-store.svelte.ts ──

function stringifyError(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    "content" in value &&
    Array.isArray((value as any).content)
  ) {
    const texts = (value as any).content
      .filter((c: any) => c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text);
    if (texts.length > 0) return texts.join("\n");
  }
  return JSON.stringify(value);
}

describe("stringifyError (inline tool store path)", () => {
  test("returns string as-is", () => {
    expect(stringifyError("hello")).toBe("hello");
  });

  test("extracts text from ToolCallResult", () => {
    const result = { content: [{ type: "text", text: "output text" }], isError: false };
    expect(stringifyError(result)).toBe("output text");
  });

  test("joins multiple text blocks", () => {
    const result = {
      content: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
    };
    expect(stringifyError(result)).toBe("line1\nline2");
  });

  test("falls back to JSON.stringify for unknown objects", () => {
    expect(stringifyError({ foo: "bar" })).toBe('{"foo":"bar"}');
  });

  test("never produces [object Object]", () => {
    const cases = [
      { content: [{ type: "text", text: "hello" }] },
      { content: [] },
      { foo: "bar" },
      { text: { nested: true } },
      42,
      null,
    ];
    for (const c of cases) {
      const result = stringifyError(c);
      expect(result).not.toBe("[object Object]");
    }
  });
});

// ── API endpoint output extraction: /api/tool-calls/[id]/output ──

function apiExtractOutput(raw: unknown): unknown {
  if (raw && typeof raw === "object" && Array.isArray((raw as any).content)) {
    const texts = ((raw as any).content as any[])
      .filter((c: any) => c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text);
    if (texts.length > 0) return texts.join("\n");
  }
  return raw;
}

describe("API /api/tool-calls/[id]/output extraction", () => {
  test("extracts text from DB jsonb ToolCallResult", () => {
    const dbOutput = { content: [{ type: "text", text: "package.json contents" }] };
    expect(apiExtractOutput(dbOutput)).toBe("package.json contents");
  });

  test("returns null as-is", () => {
    expect(apiExtractOutput(null)).toBeNull();
  });

  test("returns string as-is", () => {
    expect(apiExtractOutput("already a string")).toBe("already a string");
  });

  test("returns non-ToolCallResult object as-is", () => {
    const obj = { foo: "bar" };
    expect(apiExtractOutput(obj)).toEqual({ foo: "bar" });
  });

  test("handles listFiles output from DB", () => {
    // Stored as { content: [{ type: "text", text: "file1\nfile2\n..." }] }
    const dbOutput = {
      content: [{ type: "text", text: "bun.lock\n.planning/\ncompose.yml\npackage.json" }],
    };
    const extracted = apiExtractOutput(dbOutput);
    expect(extracted).toBe("bun.lock\n.planning/\ncompose.yml\npackage.json");
    expect(typeof extracted).toBe("string");
  });

  test("handles editFile output from DB", () => {
    const dbOutput = {
      content: [{ type: "text", text: 'Replaced in package.json\n1:   "name": "ezcorp-ai",' }],
    };
    const extracted = apiExtractOutput(dbOutput);
    expect(extracted).toBe('Replaced in package.json\n1:   "name": "ezcorp-ai",');
  });
});

// ── E2E: Full pipeline from DB storage → hydration → display ──

describe("E2E: tool output pipeline", () => {
  test("builtin readFile: DB → truncateOutput → hydrate → display", () => {
    // 1. executor.ts stores: { content: event.result?.content ?? [] }
    const dbOutput = {
      content: [{ type: "text", text: '{\n  "name": "ezcorp-ai",\n  "version": "1.0.0"\n}' }],
    };

    // 2. truncateOutput extracts text for outputSummary
    const outputSummary = truncateOutput(dbOutput);
    expect(outputSummary).toBe("{");
    expect(outputSummary).not.toBe("[object Object]");

    // 3. hydrateToolCalls stores outputSummary as InlineToolCall.output
    const hydratedOutput = outputSummary; // string | null

    // 4. getHistoricalToolCalls maps to ToolCallState.output
    const toolCallState = { output: hydratedOutput };

    // 5. ToolCallCard renders: typeof output === 'string' ? output : JSON.stringify(...)
    const rendered =
      typeof toolCallState.output === "string"
        ? toolCallState.output
        : JSON.stringify(toolCallState.output, null, 2);
    expect(rendered).toBe("{");
    expect(rendered).not.toBe("[object Object]");
  });

  test("builtin listFiles: DB → truncateOutput → hydrate → display", () => {
    const dbOutput = {
      content: [{ type: "text", text: "bun.lock\n.planning/\ncompose.yml\npackage.json" }],
    };
    const outputSummary = truncateOutput(dbOutput);
    expect(outputSummary).toBe("bun.lock");
    expect(outputSummary).not.toBe("[object Object]");
  });

  test("builtin editFile: DB → truncateOutput → hydrate → display", () => {
    const dbOutput = {
      content: [{ type: "text", text: 'Created/overwrote package.json (5 lines)\n1: {\n2:   "name": "ezcorp-ai"' }],
    };
    const outputSummary = truncateOutput(dbOutput);
    expect(outputSummary).toBe("Created/overwrote package.json (5 lines)");
  });

  test("extension tool: DB → truncateOutput → hydrate → display", () => {
    // Extension tools store via recordToolCall: { content: result.content }
    const dbOutput = {
      content: [{ type: "text", text: "Weather in NYC: Sunny, 72°F" }],
    };
    const outputSummary = truncateOutput(dbOutput);
    expect(outputSummary).toBe("Weather in NYC: Sunny, 72°F");
  });

  test("streaming path: WS event → extractToolOutput → ToolCallCard", () => {
    // WS sends: { type: "tool:complete", data: { output: { content: [...], details: {} } } }
    const wsOutput = {
      content: [{ type: "text", text: "bun.lock\n.planning/\ncompose.yml" }],
      details: {},
    };
    const extracted = extractToolOutput(wsOutput);
    expect(typeof extracted).toBe("string");
    expect(extracted).toBe("bun.lock\n.planning/\ncompose.yml");
    expect(extracted).not.toBe("[object Object]");

    // ToolCallCard renders string directly in <pre> with whitespace-pre-wrap
    // Newlines render as actual newlines, not \n escape sequences
  });

  test("API fetch path: DB → API → InlineToolCard.fetchFullOutput", () => {
    const dbOutput = {
      content: [{ type: "text", text: "bun.lock\n.planning/\ncompose.yml" }],
    };
    // API now extracts text before returning
    const apiResponse = apiExtractOutput(dbOutput);
    expect(typeof apiResponse).toBe("string");

    // InlineToolCard: typeof data.output === 'string' ? data.output : JSON.stringify(...)
    const fullOutput =
      typeof apiResponse === "string" ? apiResponse : JSON.stringify(apiResponse, null, 2);
    expect(fullOutput).toBe("bun.lock\n.planning/\ncompose.yml");
    expect(fullOutput).not.toContain("[object Object]");
  });

  test("REGRESSION: no path ever produces [object Object]", () => {
    const testOutputs = [
      // All known DB output shapes
      { content: [{ type: "text", text: "hello" }] },
      { content: [{ type: "text", text: "line1\nline2" }] },
      { content: [] },
      { content: [{ type: "image", url: "http://example.com" }] },
      { content: [{ type: "text", text: "x" }], isError: false },
      { content: [{ type: "text", text: "err" }], isError: true, details: {} },
      { text: "plain text" },
      { result: "some result" },
      { foo: "bar" },
    ];

    for (const output of testOutputs) {
      // Backend truncateOutput path
      const summary = truncateOutput(output);
      expect(summary).not.toBe("[object Object]");

      // Frontend extractToolOutput path
      const extracted = extractToolOutput(output);
      if (typeof extracted === "string") {
        expect(extracted).not.toBe("[object Object]");
      }

      // Frontend stringifyError path
      const stringified = stringifyError(output);
      expect(stringified).not.toBe("[object Object]");

      // API extraction path
      const apiResult = apiExtractOutput(output);
      if (typeof apiResult === "string") {
        expect(apiResult).not.toBe("[object Object]");
      }
    }
  });
});
