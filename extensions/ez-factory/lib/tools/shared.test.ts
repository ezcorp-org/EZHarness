/**
 * `lib/tools/shared.ts` — invariant E (over-cap or malformed input is
 * REJECTED, never truncated) and the primitives the three tools share.
 *
 * Ported from the audited reference's `parseRespondPayload` suite
 * (`docs/extensions/examples/ez-code-factory/lib/runs.test.ts`), which
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
  optionalBoundedInt,
  optionalString,
  requireContent,
  requireObject,
  requireSlug,
  requireString,
  requireStringArray,
  resolveWithinRoot,
  runTool,
  serializedBytes,
  sha256Hex,
  utf8Bytes,
} from "./shared";

/** Assert a validator rejects, and rejects with the code it promises. */
function expectRejected(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ToolInputError);
  expect((thrown as ToolInputError).code).toBe(code);
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
    expectRejected(() => requireObject(value), "invalid-input");
  });
});

describe("requireString", () => {
  test("trims and returns", () => {
    expect(requireString({ p: "  x  " }, "p")).toBe("x");
  });

  test("rejects a non-string", () => {
    expectRejected(() => requireString({ p: 7 }, "p"), "invalid-input");
  });

  test("rejects a whitespace-only value", () => {
    expectRejected(() => requireString({ p: "   " }, "p"), "invalid-input");
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
    expectRejected(() => optionalString({ p: 1 }, "p"), "invalid-input");
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

  test.each([
    ["a non-number", "5"],
    ["a fraction", 1.5],
    ["zero", 0],
    ["a negative", -3],
  ])("rejects %s", (_label, value) => {
    expectRejected(() => optionalBoundedInt({ n: value }, "n", 10), "invalid-input");
  });

  test("REJECTS over the ceiling rather than clamping to it", () => {
    // The whole point. A clamping implementation would return 10 here and
    // the caller would never learn its 4MB budget silently became 200KB.
    expectRejected(() => optionalBoundedInt({ n: 11 }, "n", 10), "over-cap");
  });
});

describe("requireStringArray — invariant E", () => {
  test("accepts a bounded list", () => {
    expect(requireStringArray({ g: [" a ", "b"] }, "g", 3, 10)).toEqual(["a", "b"]);
  });

  test("rejects a non-array", () => {
    expectRejected(() => requireStringArray({ g: "a" }, "g", 3, 10), "invalid-input");
  });

  test("rejects an empty list", () => {
    expectRejected(() => requireStringArray({ g: [] }, "g", 3, 10), "invalid-input");
  });

  test("REJECTS over the count cap rather than slicing to it", () => {
    expectRejected(() => requireStringArray({ g: ["a", "b", "c", "d"] }, "g", 3, 10), "over-cap");
  });

  test.each([
    ["a non-string entry", [1]],
    ["an empty entry", ["  "]],
  ])("rejects %s", (_label, value) => {
    expectRejected(() => requireStringArray({ g: value }, "g", 3, 10), "invalid-input");
  });

  test("REJECTS an over-long entry rather than truncating it", () => {
    expectRejected(() => requireStringArray({ g: ["x".repeat(11)] }, "g", 3, 10), "over-cap");
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

  test("rejects a non-string", () => {
    expectRejected(() => requireContent({ c: 1 }, "c"), "invalid-input");
  });

  test("REJECTS one byte over the 4MB cap rather than truncating", () => {
    expectRejected(() => requireContent({ c: "a".repeat(MAX_WRITE_BYTES + 1) }, "c"), "over-cap");
  });

  test("measures UTF-8 BYTES, not UTF-16 code units", () => {
    // Two-byte characters: half the code units still blows the byte cap.
    // Measuring `.length` would let a 4MB-byte payload through.
    const twoByte = "é".repeat(MAX_WRITE_BYTES / 2 + 1);
    expect(twoByte.length).toBeLessThan(MAX_WRITE_BYTES);
    expectRejected(() => requireContent({ c: twoByte }, "c"), "over-cap");
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
    expectRejected(
      () => resolveWithinRoot("/proj", "a".repeat(MAX_PATH_LEN + 1), "path"),
      "over-cap",
    );
  });

  test.each([
    ["a NUL byte", "a\0b"],
    ["an absolute path", "/etc/passwd"],
    ["a .. segment", "src/../../etc/passwd"],
    ["a backslash-separated .. segment", "src\\..\\..\\etc"],
  ])("rejects %s", (_label, value) => {
    expectRejected(() => resolveWithinRoot("/proj", value, "path"), "invalid-path");
  });

  test("fails closed on a degenerate root rather than resolving cwd-relative", () => {
    // The belt-and-braces containment check. Every caller passes a real
    // absolute root, so this is the branch that catches a future one that
    // does not — an empty root would otherwise silently produce a
    // process-cwd-relative path outside any grant.
    expectRejected(() => resolveWithinRoot("", "x", "path"), "invalid-path");
  });
});

describe("requireSlug — the traversal-proof name", () => {
  test("accepts an ordinary artifact name", () => {
    expect(requireSlug({ n: "report.md" }, "n", 64)).toBe("report.md");
  });

  test("REJECTS an over-long name rather than truncating it", () => {
    expectRejected(() => requireSlug({ n: "a".repeat(65) }, "n", 64), "over-cap");
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
    expectRejected(() => requireSlug({ n: value }, "n", MAX_ARTIFACT_NAME_LEN), "invalid-name");
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
