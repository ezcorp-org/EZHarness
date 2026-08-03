/**
 * `lib/tools/shared.ts` — invariant E (over-cap or malformed input is
 * REJECTED, never truncated) and the primitives the three tools share.
 *
 * Ported from the audited reference's `parseRespondPayload` suite
 * (`ez-code-factory/lib/runs.test.ts` — retired 2026-08-03 in phase 9,
 * readable in git history), which
 * asserts one rejection per bound. The shape of every test below is the
 * same: hand it a value one step over a named bound and assert the call is
 * REFUSED — not that the result came back smaller. A clamping
 * implementation passes "the result is under the cap"; it fails these.
 */
import { describe, expect, test } from "bun:test";

import {
  MAX_ARTIFACT_NAME_LEN,
  MAX_GLOBS,
  MAX_GLOB_LEN,
  MAX_PATH_LEN,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_WRITE_BYTES,
  ToolInputError,
  WORKFLOW_SCOPE_PREFIX,
  optionalBoundedInt,
  optionalString,
  requireContent,
  requireObject,
  requireSlug,
  requireString,
  requireStringList,
  resolveWithinRoot,
  runIdFromConversation,
  runTool,
  serializedBytes,
  sha256Hex,
  utf8Bytes,
} from "./shared";

/**
 * Run `fn` and report HOW it was rejected: the `ToolInputError` code, or a
 * description of what happened instead.
 *
 * Deliberately returns rather than asserting. Every call site then carries
 * its own visible `expect(...)`, which keeps the assertion where a reader
 * (and the assertion-free-test gate) can see it, and makes the failure
 * message say what actually happened — "did not throw" reads far better
 * than a bare instanceof mismatch.
 */
function rejectionCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof ToolInputError ? err.code : `threw a non-ToolInputError: ${String(err)}`;
  }
  return "did not throw";
}

describe("requireObject", () => {
  test("accepts a plain object", () => {
    expect(requireObject({ a: 1 })).toEqual({ a: 1 });
  });

  test.each([
    ["null", null],
    ["a scalar", 42],
    ["an array", [1, 2]],
  ])("rejects %s", (_label, value) => {
    expect(rejectionCode(() => requireObject(value))).toBe("invalid-input");
  });
});

describe("requireString", () => {
  test("trims and returns", () => {
    expect(requireString({ p: "  x  " }, "p")).toBe("x");
  });

  test("rejects a non-string", () => {
    expect(rejectionCode(() => requireString({ p: 7 }, "p"))).toBe("invalid-input");
  });

  test("rejects a whitespace-only value", () => {
    expect(rejectionCode(() => requireString({ p: "   " }, "p"))).toBe("invalid-input");
  });
});

describe("optionalString", () => {
  test.each([
    ["absent", {}],
    ["undefined", { p: undefined }],
    ["null", { p: null }],
  ])("returns undefined when %s", (_label, args) => {
    expect(optionalString(args as Record<string, unknown>, "p")).toBeUndefined();
  });

  test("rejects a present non-string rather than coercing it", () => {
    expect(rejectionCode(() => optionalString({ p: 1 }, "p"))).toBe("invalid-input");
  });

  test("trims a present string", () => {
    expect(optionalString({ p: " docs " }, "p")).toBe("docs");
  });
});

describe("optionalBoundedInt — invariant E", () => {
  test("returns undefined when absent", () => {
    expect(optionalBoundedInt({}, "n", 10)).toBeUndefined();
    expect(optionalBoundedInt({ n: null }, "n", 10)).toBeUndefined();
  });

  test("accepts a value at the ceiling", () => {
    expect(optionalBoundedInt({ n: 10 }, "n", 10)).toBe(10);
  });

  test("accepts a NUMERIC STRING — a workflow step cannot pass a number", () => {
    // `validateWorkflow` rejects any step `input` mapping value that is
    // not a string, so a template can only write `maxFiles: "40"`.
    // Without this coercion the tool is uncallable from a workflow.
    expect(optionalBoundedInt({ n: "7" }, "n", 10)).toBe(7);
    expect(optionalBoundedInt({ n: " 7 " }, "n", 10)).toBe(7);
  });

  test("REJECTS an over-cap numeric string too — the coercion is not a bypass", () => {
    expect(rejectionCode(() => optionalBoundedInt({ n: "11" }, "n", 10))).toBe("over-cap");
  });

  test.each([
    ["a fraction", 1.5],
    ["zero", 0],
    ["a negative", -3],
    ["a boolean", true],
    ["a fractional string", "1.5"],
    ["a hex string", "0x8"],
    ["a trailing-garbage string", "7abc"],
    ["a signed string", "-3"],
    ["an empty string", ""],
    ["a whitespace string", "   "],
    ["a zero string", "0"],
  ])("rejects %s", (_label, value) => {
    // Strict coercion: a mis-typed ref must fail loudly, not silently
    // become NaN or 0.
    expect(rejectionCode(() => optionalBoundedInt({ n: value }, "n", 10))).toBe("invalid-input");
  });

  test("REJECTS over the ceiling rather than clamping to it", () => {
    // The whole point. A clamping implementation would return 10 here and
    // the caller would never learn its 4MB budget silently became 200KB.
    expect(rejectionCode(() => optionalBoundedInt({ n: 11 }, "n", 10))).toBe("over-cap");
  });
});

describe("requireStringList — invariant E", () => {
  test("accepts a bounded list", () => {
    expect(requireStringList({ g: [" a ", "b"] }, "g", 3, 10)).toEqual(["a", "b"]);
  });

  test("accepts a NEWLINE-SEPARATED STRING — a workflow step cannot pass an array", () => {
    expect(requireStringList({ g: "a\nb" }, "g", 3, 10)).toEqual(["a", "b"]);
  });

  test("ignores blank lines in the string form", () => {
    expect(requireStringList({ g: "a\n\n  \nb\n" }, "g", 3, 10)).toEqual(["a", "b"]);
  });

  test("splits on NEWLINE, not comma — a brace expansion contains commas", () => {
    // `src/**/*.{ts,tsx}` is ONE pattern. Splitting on commas would
    // silently turn it into two broken ones.
    expect(requireStringList({ g: "a/*.{ts,tsx}" }, "g", 3, 20)).toEqual(["a/*.{ts,tsx}"]);
  });

  test("rejects a value that is neither an array nor a string", () => {
    expect(rejectionCode(() => requireStringList({ g: 7 }, "g", 3, 10))).toBe("invalid-input");
  });

  test.each([
    ["an empty array", []],
    ["an empty string", ""],
    ["a whitespace-only string", "  \n  "],
  ])("rejects %s", (_label, value) => {
    expect(rejectionCode(() => requireStringList({ g: value }, "g", 3, 10))).toBe("invalid-input");
  });

  test("REJECTS over the count cap in the STRING form too", () => {
    expect(rejectionCode(() => requireStringList({ g: "a\nb\nc\nd" }, "g", 3, 10))).toBe("over-cap");
  });

  test("REJECTS over the count cap rather than slicing to it", () => {
    expect(rejectionCode(() => requireStringList({ g: ["a", "b", "c", "d"] }, "g", 3, 10))).toBe("over-cap");
  });

  test.each([
    ["a non-string entry", [1]],
    ["an empty entry", ["  "]],
  ])("rejects %s", (_label, value) => {
    expect(rejectionCode(() => requireStringList({ g: value }, "g", 3, 10))).toBe("invalid-input");
  });

  test("REJECTS an over-long entry rather than truncating it", () => {
    expect(rejectionCode(() => requireStringList({ g: ["x".repeat(11)] }, "g", 3, 10))).toBe("over-cap");
  });

  test("the read_files bounds are the ones the manifest advertises", () => {
    expect(MAX_GLOBS).toBe(20);
    expect(MAX_GLOB_LEN).toBe(200);
  });
});

describe("requireContent — invariant E", () => {
  test("accepts content at the cap", () => {
    const atCap = "a".repeat(MAX_WRITE_BYTES);
    expect(requireContent({ c: atCap }, "c")).toBe(atCap);
  });

  test("accepts an OBJECT and pretty-prints it as JSON", () => {
    // A template threading a previous step's whole result into an
    // artifact (`content: "$steps.write.output"`) hands over a real
    // object. Rejecting it would force a transform step whose only job
    // is JSON.stringify.
    expect(requireContent({ c: { a: 1 } }, "c")).toBe('{\n  "a": 1\n}');
  });

  test("accepts an ARRAY", () => {
    expect(requireContent({ c: [1, 2] }, "c")).toBe("[\n  1,\n  2\n]");
  });

  test.each([
    ["a number", 1],
    ["a boolean", true],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s — that is what a mis-typed ref produces", (_label, value) => {
    // Writing "null" into an artifact a human will later read is exactly
    // the silent-wrong-output failure invariant E exists to prevent.
    expect(rejectionCode(() => requireContent({ c: value }, "c"))).toBe("invalid-input");
  });

  test("caps the SERIALIZED bytes of an object, and rejects rather than truncating", () => {
    const big = { blob: "a".repeat(MAX_WRITE_BYTES) };
    expect(rejectionCode(() => requireContent({ c: big }, "c"))).toBe("over-cap");
  });

  test("REJECTS one byte over the 4MB cap rather than truncating", () => {
    expect(rejectionCode(() => requireContent({ c: "a".repeat(MAX_WRITE_BYTES + 1) }, "c"))).toBe("over-cap");
  });

  test("measures UTF-8 BYTES, not UTF-16 code units", () => {
    // Two-byte characters: half the code units still blows the byte cap.
    // Measuring `.length` would let a 4MB-byte payload through.
    const twoByte = "é".repeat(MAX_WRITE_BYTES / 2 + 1);
    expect(twoByte.length).toBeLessThan(MAX_WRITE_BYTES);
    expect(rejectionCode(() => requireContent({ c: twoByte }, "c"))).toBe("over-cap");
  });
});

describe("resolveWithinRoot", () => {
  test("resolves a relative path under the root", () => {
    expect(resolveWithinRoot("/proj", "src/a.ts", "path")).toBe("/proj/src/a.ts");
  });

  test("resolves the root itself", () => {
    expect(resolveWithinRoot("/proj", ".", "path")).toBe("/proj");
  });

  test("handles a root that already ends in a separator", () => {
    expect(resolveWithinRoot("/", "a.ts", "path")).toBe("/a.ts");
  });

  test("REJECTS an over-long path rather than truncating it", () => {
    expect(
      rejectionCode(() => resolveWithinRoot("/proj", "a".repeat(MAX_PATH_LEN + 1), "path")),
    ).toBe("over-cap");
  });

  test.each([
    ["a NUL byte", "a\0b"],
    ["an absolute path", "/etc/passwd"],
    ["a .. segment", "src/../../etc/passwd"],
    ["a backslash-separated .. segment", "src\\..\\..\\etc"],
  ])("rejects %s", (_label, value) => {
    expect(rejectionCode(() => resolveWithinRoot("/proj", value, "path"))).toBe("invalid-path");
  });

  test("fails closed on a degenerate root rather than resolving cwd-relative", () => {
    // The belt-and-braces containment check. Every caller passes a real
    // absolute root, so this is the branch that catches a future one that
    // does not — an empty root would otherwise silently produce a
    // process-cwd-relative path outside any grant.
    expect(rejectionCode(() => resolveWithinRoot("", "x", "path"))).toBe("invalid-path");
  });
});

describe("requireSlug — the traversal-proof name", () => {
  test("accepts an ordinary artifact name", () => {
    expect(requireSlug({ n: "report.md" }, "n", 64)).toBe("report.md");
  });

  test("REJECTS an over-long name rather than truncating it", () => {
    expect(rejectionCode(() => requireSlug({ n: "a".repeat(65) }, "n", 64))).toBe("over-cap");
  });

  test.each([
    ["a parent-dir traversal", "../../etc/passwd"],
    ["a bare ..", ".."],
    ["a bare .", "."],
    ["an embedded separator", "sub/report.md"],
    ["a backslash separator", "sub\\report.md"],
    ["an absolute path", "/etc/passwd"],
    ["a leading dot", ".ssh"],
    ["a shell metacharacter", "a;rm -rf b"],
  ])("rejects %s", (_label, value) => {
    expect(rejectionCode(() => requireSlug({ n: value }, "n", MAX_ARTIFACT_NAME_LEN))).toBe("invalid-name");
  });
});

describe("runIdFromConversation", () => {
  test("extracts the run id from the workflow scope key", () => {
    expect(runIdFromConversation("workflow-run:abc-123")).toBe("abc-123");
  });

  test.each([
    ["an ordinary chat conversation", "conv-abc"],
    ["no conversation", undefined],
    ["the bare prefix", "workflow-run:"],
    ["a whitespace-only run id", "workflow-run:   "],
  ])("returns undefined for %s", (_label, value) => {
    expect(runIdFromConversation(value)).toBeUndefined();
  });

  test("the prefix matches the executor's workflowScopeKey", () => {
    // `workflowScopeKey` in `src/runtime/workflow-executor.ts` builds
    // `workflow-run:${id}`. Restated, not imported — this module ships
    // into a sandbox that cannot read `src/`.
    expect(WORKFLOW_SCOPE_PREFIX).toBe("workflow-run:");
  });
});

describe("byte + hash primitives", () => {
  test("utf8Bytes counts bytes, not code units", () => {
    expect(utf8Bytes("é")).toBe(2);
    expect("é".length).toBe(1);
  });

  test("serializedBytes measures the JSON form", () => {
    expect(serializedBytes({ a: 1 })).toBe(utf8Bytes(JSON.stringify({ a: 1 })));
  });

  test("serializedBytes reports 0 for an unserializable value", () => {
    expect(serializedBytes(undefined)).toBe(0);
  });

  test("sha256Hex matches the known digest of the empty string", () => {
    // The canonical SHA-256 of "" — a fixed vector, so a swapped
    // algorithm or a byte-order slip is caught rather than self-confirmed.
    return expect(sha256Hex("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("runTool — the one place the output ceiling is enforced", () => {
  test("serializes a successful payload", async () => {
    const outcome = await runTool("t", async () => ({ a: 1 }));
    expect(outcome).toEqual({ ok: true, text: '{"a":1}' });
  });

  test("turns a ToolInputError into a coded error outcome", async () => {
    const outcome = await runTool("t", async () => {
      throw new ToolInputError("over-cap", "too big");
    });
    expect(outcome).toEqual({ ok: false, text: "t: too big", code: "over-cap" });
  });

  test("turns an ordinary Error into a `failed` outcome", async () => {
    const outcome = await runTool("t", async () => {
      throw new Error("EACCES");
    });
    expect(outcome).toEqual({ ok: false, text: "t: EACCES", code: "failed" });
  });

  test("survives a non-Error throw", async () => {
    const outcome = await runTool("t", async () => {
      throw "boom";
    });
    expect(outcome).toEqual({ ok: false, text: "t: boom", code: "failed" });
  });

  test("REFUSES a payload over the ceiling instead of emitting it", async () => {
    // This is the resume-failure guard at its source. Emitting it would
    // store an overflow sentinel that only fails on RESUME — after the
    // run has spent its LLM budget and a human has approved a gate.
    const outcome = await runTool("t", async () => ({ blob: "x".repeat(MAX_TOOL_OUTPUT_BYTES) }));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("output-too-large");
  });

  test("the ceiling sits under the host's step-output cap", () => {
    // `MAX_STEP_OUTPUT_BYTES` is 256 * 1024 in
    // `src/runtime/workflow-step-output.ts`. Restated rather than
    // imported: this module runs in a sandbox that cannot read `src/`.
    expect(MAX_TOOL_OUTPUT_BYTES).toBeLessThan(256 * 1024);
  });
});
