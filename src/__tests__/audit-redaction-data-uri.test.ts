/**
 * Unit fixtures for `redactLargeDataUris` (audit-redaction.ts) — the
 * resolved-attachment payload redactor. Lives in src/__tests__ (the
 * coverage host set) so the new lines feed coverage/lcov.info; the
 * executor-boundary integration lives in
 * tool-executor-input-redaction.test.ts alongside.
 */
import { test, expect, describe } from "bun:test";
import { redactLargeDataUris } from "../extensions/audit-redaction";

// The tool-executor applies this at the `tool:start` emit boundary and
// at the recordToolCall persist boundary (tool_calls.input write).
// Contract: base64 data-URI strings LARGER than 1 KB become a compact
// `[data:<mime>;<n> bytes]` marker (n = decoded payload size); everything
// else — small data URIs, plain strings, non-strings — passes through
// unchanged, and the input object is never mutated.

describe("redactLargeDataUris", () => {
  const bigPayload = "A".repeat(4096); // 4096 b64 chars → 3072 decoded bytes
  const bigDataUri = `data:image/png;base64,${bigPayload}`;

  test("large base64 data URI → [data:<mime>;<n> bytes] marker", () => {
    const out = redactLargeDataUris(bigDataUri);
    expect(out).toBe("[data:image/png;3072 bytes]");
  });

  test("padding is subtracted from the decoded byte count", () => {
    const padded = `data:application/pdf;base64,${"B".repeat(4094)}==`;
    const out = redactLargeDataUris(padded);
    // 4096 payload chars → floor(4096*3/4)=3072, minus 2 padding = 3070
    expect(out).toBe("[data:application/pdf;3070 bytes]");
  });

  test("small data URI (≤1 KB) passes through untouched", () => {
    const small = "data:image/png;base64,iVBORw0KGgo=";
    expect(redactLargeDataUris(small)).toBe(small);
  });

  test("large NON-data-URI string passes through untouched", () => {
    const prose = "x".repeat(5000);
    expect(redactLargeDataUris(prose)).toBe(prose);
  });

  test("large string with data: prefix but no base64 marker passes through", () => {
    const notB64 = `data:text/plain,${"y".repeat(5000)}`;
    expect(redactLargeDataUris(notB64)).toBe(notB64);
  });

  test("nested objects and arrays are walked; siblings untouched", () => {
    const input = {
      prompt: "edit this",
      images: [bigDataUri, "data:image/png;base64,tiny=="],
      nested: { deep: { blob: bigDataUri } },
      count: 3,
      flag: true,
      nothing: null,
    };
    const out = redactLargeDataUris(input) as typeof input;
    expect(out.images[0]).toBe("[data:image/png;3072 bytes]");
    expect(out.images[1]).toBe("data:image/png;base64,tiny==");
    expect(out.nested.deep.blob).toBe("[data:image/png;3072 bytes]");
    expect(out.prompt).toBe("edit this");
    expect(out.count).toBe(3);
    expect(out.flag).toBe(true);
    expect(out.nothing).toBeNull();
  });

  test("never mutates the input (execution keeps the real data URI)", () => {
    const input = { images: [bigDataUri] };
    const out = redactLargeDataUris(input) as { images: string[] };
    expect(input.images[0]).toBe(bigDataUri);
    expect(out.images[0]).not.toBe(bigDataUri);
  });

  test("circular references degrade to a [Circular] marker, no throw", () => {
    const a: Record<string, unknown> = { blob: bigDataUri };
    a.self = a;
    const out = redactLargeDataUris(a) as Record<string, unknown>;
    expect(out.blob).toBe("[data:image/png;3072 bytes]");
    expect(out.self).toBe("[Circular]");
  });
});
