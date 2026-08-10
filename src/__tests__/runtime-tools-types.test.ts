import { test, expect, describe } from "bun:test";
import { errorMessage, toolError } from "../runtime/tools/types";

/**
 * `toolError` / `errorMessage` — the shared error-result convention
 * promoted out of the 17 built-ins that used to hand-roll it (each one had
 * its own copy of `{ content: [{ type: "text", text: \`Error: ${e
 * instanceof Error ? e.message : String(e)}\` }], details: { isError: true
 * } }`). Tested directly here, on top of the many tool-level tests that
 * exercise them indirectly through real catch blocks.
 */
describe("toolError", () => {
  test("wraps the message in the 'Error: <message>' text convention", () => {
    const result = toolError("something went wrong");
    expect(result.content).toEqual([{ type: "text", text: "Error: something went wrong" }]);
  });

  test("sets details.isError to true with no extra fields", () => {
    const result = toolError("bad input");
    expect(result.details).toEqual({ isError: true });
  });

  test("merges extra details after isError", () => {
    const result = toolError("boom", { exitCode: -1, stdout: "", stderr: "boom" });
    expect(result.details).toEqual({ isError: true, exitCode: -1, stdout: "", stderr: "boom" });
  });

  test("isError is set before extra, so extra fields win on key collision", () => {
    // No caller relies on this today, but the merge order is `{ isError:
    // true, ...extra }` — pin it so a future extra field named `isError`
    // (or any other reserved-looking key) has documented, not accidental,
    // behavior.
    const result = toolError("boom", { isError: false });
    expect(result.details.isError).toBe(false);
  });
});

describe("errorMessage", () => {
  test("returns .message for a real Error", () => {
    expect(errorMessage(new Error("real error"))).toBe("real error");
  });

  test("returns .message for an Error subclass", () => {
    class CustomError extends Error {}
    expect(errorMessage(new CustomError("custom"))).toBe("custom");
  });

  test("stringifies a thrown string", () => {
    expect(errorMessage("plain string throw")).toBe("plain string throw");
  });

  test("stringifies a thrown non-Error object", () => {
    expect(errorMessage({ code: "EFAIL" })).toBe("[object Object]");
  });

  test("stringifies null and undefined", () => {
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
