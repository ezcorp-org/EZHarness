/**
 * Pure-heuristic tests for the lessons distiller triggers
 * (`src/runtime/lessons/triggers.ts`). No DB, no async, no I/O — these
 * lock the truth-table semantics of `shouldDistill` plus each detector
 * function's individual signal.
 */
import { test, expect, describe } from "bun:test";
import {
  shouldDistill,
  detectUserCorrection,
  detectErrorRecovery,
  detectExplicitTag,
  TOOL_CALL_THRESHOLD,
  type DistillTriggerInput,
} from "../runtime/lessons/triggers";

const allFalse = (): DistillTriggerInput => ({
  toolCallCount: 0,
  errorRecoveryObserved: false,
  userCorrectionObserved: false,
  explicitlyTagged: false,
});

describe("shouldDistill — truth-table coverage", () => {
  test("returns false when every signal is off", () => {
    expect(shouldDistill(allFalse())).toBe(false);
  });

  test("returns false when toolCallCount is below threshold", () => {
    expect(shouldDistill({ ...allFalse(), toolCallCount: TOOL_CALL_THRESHOLD - 1 })).toBe(false);
  });

  test("fires on toolCallCount >= threshold alone", () => {
    expect(shouldDistill({ ...allFalse(), toolCallCount: TOOL_CALL_THRESHOLD })).toBe(true);
    expect(shouldDistill({ ...allFalse(), toolCallCount: TOOL_CALL_THRESHOLD + 100 })).toBe(true);
  });

  test("fires on errorRecoveryObserved alone", () => {
    expect(shouldDistill({ ...allFalse(), errorRecoveryObserved: true })).toBe(true);
  });

  test("fires on userCorrectionObserved alone", () => {
    expect(shouldDistill({ ...allFalse(), userCorrectionObserved: true })).toBe(true);
  });

  test("fires on explicitlyTagged alone", () => {
    expect(shouldDistill({ ...allFalse(), explicitlyTagged: true })).toBe(true);
  });

  test("fires when every signal is on", () => {
    expect(
      shouldDistill({
        toolCallCount: 99,
        errorRecoveryObserved: true,
        userCorrectionObserved: true,
        explicitlyTagged: true,
      }),
    ).toBe(true);
  });

  test("any pair of flags fires (combo coverage)", () => {
    const combos: Array<Partial<DistillTriggerInput>> = [
      { toolCallCount: TOOL_CALL_THRESHOLD, errorRecoveryObserved: true },
      { toolCallCount: TOOL_CALL_THRESHOLD, userCorrectionObserved: true },
      { toolCallCount: TOOL_CALL_THRESHOLD, explicitlyTagged: true },
      { errorRecoveryObserved: true, userCorrectionObserved: true },
      { errorRecoveryObserved: true, explicitlyTagged: true },
      { userCorrectionObserved: true, explicitlyTagged: true },
    ];
    for (const c of combos) {
      expect(shouldDistill({ ...allFalse(), ...c })).toBe(true);
    }
  });
});

describe("detectUserCorrection", () => {
  test("matches each documented correction token", () => {
    expect(detectUserCorrection(["no, that's wrong"])).toBe(true);
    expect(detectUserCorrection(["not quite — try again"])).toBe(true);
    expect(detectUserCorrection(["actually, it's the other file"])).toBe(true);
    expect(detectUserCorrection(["wait, you missed the imports"])).toBe(true);
    expect(detectUserCorrection(["don't run that — it'll wipe state"])).toBe(true);
    expect(detectUserCorrection(["stop"])).toBe(true);
    expect(detectUserCorrection(["redo it without the cache"])).toBe(true);
    expect(detectUserCorrection(["use the helper instead"])).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(detectUserCorrection(["NO, that's wrong"])).toBe(true);
    expect(detectUserCorrection(["Actually, look at line 42"])).toBe(true);
    expect(detectUserCorrection(["WAIT, hold on"])).toBe(true);
  });

  test("does NOT false-positive on benign 'don't' phrases", () => {
    expect(detectUserCorrection(["don't worry about it"])).toBe(false);
    expect(detectUserCorrection(["I don't think so"])).toBe(false);
    expect(detectUserCorrection(["why don't we wait until tomorrow"])).toBe(false);
  });

  test("does NOT false-positive on benign 'wait' / 'no' prose", () => {
    // 'wait' without trailing comma — narrative, not redirection.
    expect(detectUserCorrection(["I had to wait a long time"])).toBe(false);
    // 'no' without trailing comma.
    expect(detectUserCorrection(["I have no idea what happened"])).toBe(false);
  });

  test("scans every message in the array, not just the first", () => {
    expect(detectUserCorrection(["First message", "second", "actually, here's the thing"])).toBe(true);
  });

  test("ignores empty + non-string entries", () => {
    expect(detectUserCorrection(["", "actually, fix this"])).toBe(true);
    // Cast-through-unknown to test runtime defensiveness against
    // bad inputs (string[] only at the type level).
    expect(
      detectUserCorrection([null as unknown as string, undefined as unknown as string]),
    ).toBe(false);
  });

  test("returns false for an empty array", () => {
    expect(detectUserCorrection([])).toBe(false);
  });
});

describe("detectErrorRecovery", () => {
  test("returns true when an error is followed by a success", () => {
    expect(
      detectErrorRecovery([
        { status: "error" },
        { status: "ok" },
      ]),
    ).toBe(true);
  });

  test("returns true when error → ok with intermediate noise", () => {
    expect(
      detectErrorRecovery([
        { status: "ok" },
        { status: "error" },
        { status: "error" },
        { status: "ok" },
      ]),
    ).toBe(true);
  });

  test("returns false when only errors occur", () => {
    expect(
      detectErrorRecovery([
        { status: "error" },
        { status: "error" },
      ]),
    ).toBe(false);
  });

  test("returns false when only successes occur", () => {
    expect(
      detectErrorRecovery([
        { status: "ok" },
        { status: "ok" },
      ]),
    ).toBe(false);
  });

  test("returns false when error appears AFTER all successes", () => {
    expect(
      detectErrorRecovery([
        { status: "ok" },
        { status: "ok" },
        { status: "error" },
      ]),
    ).toBe(false);
  });

  test("returns false on empty input", () => {
    expect(detectErrorRecovery([])).toBe(false);
  });
});

describe("detectExplicitTag", () => {
  test("matches '[lesson]' anywhere in the message", () => {
    expect(detectExplicitTag(["[lesson] remember this"])).toBe(true);
    expect(detectExplicitTag(["please note: [lesson] tag this conversation"])).toBe(true);
    expect(detectExplicitTag(["this is important [lesson]"])).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(detectExplicitTag(["[LESSON] uppercase tag"])).toBe(true);
    expect(detectExplicitTag(["[Lesson] mixed case"])).toBe(true);
  });

  test("does NOT match without brackets", () => {
    expect(detectExplicitTag(["this contains the word lesson"])).toBe(false);
    expect(detectExplicitTag(["a lesson learned"])).toBe(false);
  });

  test("scans every message in the array", () => {
    expect(detectExplicitTag(["msg one", "msg two", "msg [lesson] three"])).toBe(true);
  });

  test("returns false on empty array", () => {
    expect(detectExplicitTag([])).toBe(false);
  });
});
