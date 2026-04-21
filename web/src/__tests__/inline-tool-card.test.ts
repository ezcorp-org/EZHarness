import { describe, test, expect } from "bun:test";

/**
 * Tests for InlineToolCard derived logic.
 * We test the pure derivation functions extracted from the Svelte component
 * since we can't compile .svelte in bun test.
 */

interface InlineToolCall {
  id: string;
  extensionName: string;
  toolName: string;
  input: Record<string, unknown>;
  status: "pending" | "running" | "complete" | "error";
  output?: string;
  error?: string;
  retryCount: number;
  startedAt?: number;
  duration?: number;
  conversationId: string;
}

/** Mirrors summaryLine derived logic from InlineToolCard.svelte */
function deriveSummaryLine(call: InlineToolCall): string {
  if (call.status !== "complete" || !call.output) return "";
  const firstLine = call.output.split("\n")[0] ?? "";
  const truncated = firstLine.length > 80 ? firstLine.slice(0, 80) + "..." : firstLine;
  const dur = call.duration != null ? ` (${(call.duration / 1000).toFixed(1)}s)` : "";
  return `${call.extensionName} > ${call.toolName} -- ${truncated}${dur}`;
}

/** Mirrors elapsed timer logic */
function computeElapsed(startedAt: number, now: number): number {
  return Math.floor((now - startedAt) / 1000);
}

/** Mirrors retry count display logic from template */
function retryCountText(retryCount: number): string {
  if (retryCount > 0) {
    return `Failed after ${retryCount} ${retryCount === 1 ? "retry" : "retries"}`;
  }
  return "Failed";
}

function makeCall(overrides: Partial<InlineToolCall> = {}): InlineToolCall {
  return {
    id: "inv-1",
    extensionName: "test-ext",
    toolName: "do-thing",
    input: {},
    status: "complete",
    retryCount: 0,
    conversationId: "conv-1",
    ...overrides,
  };
}

describe("InlineToolCard summaryLine derivation", () => {
  test("returns empty string for non-complete status", () => {
    expect(deriveSummaryLine(makeCall({ status: "running" }))).toBe("");
    expect(deriveSummaryLine(makeCall({ status: "pending" }))).toBe("");
    expect(deriveSummaryLine(makeCall({ status: "error" }))).toBe("");
  });

  test("returns empty string when output is undefined", () => {
    expect(deriveSummaryLine(makeCall({ status: "complete", output: undefined }))).toBe("");
  });

  test("includes extension name, tool name, and first line of output", () => {
    const result = deriveSummaryLine(makeCall({ output: "Hello world" }));
    expect(result).toBe("test-ext > do-thing -- Hello world");
  });

  test("truncates first line at 80 chars with ellipsis", () => {
    const longLine = "A".repeat(100);
    const result = deriveSummaryLine(makeCall({ output: longLine }));
    expect(result).toContain("A".repeat(80) + "...");
    // Should not contain the full 100 chars
    expect(result).not.toContain("A".repeat(81));
  });

  test("does not truncate lines at exactly 80 chars", () => {
    const exactLine = "B".repeat(80);
    const result = deriveSummaryLine(makeCall({ output: exactLine }));
    expect(result).not.toContain("...");
    expect(result).toContain("B".repeat(80));
  });

  test("uses only the first line of multiline output", () => {
    const result = deriveSummaryLine(makeCall({ output: "first line\nsecond line\nthird" }));
    expect(result).toContain("first line");
    expect(result).not.toContain("second line");
  });

  test("includes duration when present", () => {
    const result = deriveSummaryLine(makeCall({ output: "done", duration: 1234 }));
    expect(result).toBe("test-ext > do-thing -- done (1.2s)");
  });

  test("omits duration when not present", () => {
    const result = deriveSummaryLine(makeCall({ output: "done", duration: undefined }));
    expect(result).toBe("test-ext > do-thing -- done");
  });

  test("formats sub-second durations correctly", () => {
    const result = deriveSummaryLine(makeCall({ output: "ok", duration: 50 }));
    expect(result).toContain("(0.1s)");
  });
});

describe("InlineToolCard elapsed timer logic", () => {
  test("computes elapsed seconds from startedAt", () => {
    const start = 1000;
    expect(computeElapsed(start, 1000)).toBe(0);
    expect(computeElapsed(start, 1500)).toBe(0); // floors
    expect(computeElapsed(start, 2000)).toBe(1);
    expect(computeElapsed(start, 5500)).toBe(4);
  });

  test("handles large elapsed values", () => {
    expect(computeElapsed(0, 120_000)).toBe(120);
  });
});

describe("InlineToolCard error state", () => {
  test("shows 'Failed' when retryCount is 0", () => {
    expect(retryCountText(0)).toBe("Failed");
  });

  test("shows 'Failed after 1 retry' for single retry", () => {
    expect(retryCountText(1)).toBe("Failed after 1 retry");
  });

  test("shows 'Failed after N retries' for multiple retries", () => {
    expect(retryCountText(2)).toBe("Failed after 2 retries");
    expect(retryCountText(5)).toBe("Failed after 5 retries");
  });
});
