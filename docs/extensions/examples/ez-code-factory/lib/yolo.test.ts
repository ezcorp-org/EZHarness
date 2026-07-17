import { test, expect, describe } from "bun:test";
import { decideYoloAction, autoFixFindingIds, askUserFindingCount } from "./yolo";
import type { Finding, Findings } from "./runs";

/** Build a Findings blob from partial finding specs (defaults fill the rest). */
function findings(items: Array<Partial<Finding>>): Findings {
  return {
    items: items.map((it, i) => ({
      id: it.id ?? `f${i}`,
      severity: it.severity ?? "error",
      file: it.file ?? "src/x.ts",
      line: it.line ?? null,
      description: it.description ?? "desc",
      action: it.action ?? "ask-user",
      source: it.source ?? "agent",
      userInstructions: it.userInstructions ?? "",
      category: it.category ?? "",
    })),
    summary: "",
    tested: [],
    testingSummary: "",
    artifacts: [],
    riskLevel: "",
    riskRationale: "",
  };
}

describe("autoFixFindingIds", () => {
  test("returns only the named auto-fix finding ids", () => {
    const f = findings([
      { id: "a", action: "auto-fix" },
      { id: "b", action: "ask-user" },
      { id: "c", action: "no-op" },
      { id: "d", action: "auto-fix" },
    ]);
    expect(autoFixFindingIds(f)).toEqual(["a", "d"]);
  });

  test("drops auto-fix findings with a blank id (can't be selected by id)", () => {
    const f = findings([
      { id: "", action: "auto-fix" },
      { id: "keep", action: "auto-fix" },
    ]);
    expect(autoFixFindingIds(f)).toEqual(["keep"]);
  });
});

describe("askUserFindingCount", () => {
  test("counts the ask-user findings", () => {
    const f = findings([
      { action: "ask-user" },
      { action: "auto-fix" },
      { action: "ask-user" },
    ]);
    expect(askUserFindingCount(f)).toBe(2);
  });

  test("is zero for a gate with no ask-user finding", () => {
    expect(askUserFindingCount(findings([{ action: "no-op" }]))).toBe(0);
  });
});

describe("decideYoloAction", () => {
  test("STOPS when any ask-user finding is present (never blanket-approves)", () => {
    const f = findings([
      { action: "auto-fix", id: "a" },
      { action: "ask-user", id: "b" },
    ]);
    expect(decideYoloAction(f, false)).toEqual({ kind: "stop", askUserCount: 1 });
    // Even after a fix round: an ask-user finding still stops.
    expect(decideYoloAction(f, true)).toEqual({ kind: "stop", askUserCount: 1 });
  });

  test("FIXES once when there are auto-fix findings and the fix budget is unspent", () => {
    const f = findings([
      { action: "auto-fix", id: "a" },
      { action: "no-op", id: "b" },
      { action: "auto-fix", id: "c" },
    ]);
    expect(decideYoloAction(f, false)).toEqual({ kind: "fix", findingIds: ["a", "c"] });
  });

  test("APPROVES after the one fix is spent (approve the rest)", () => {
    const f = findings([{ action: "auto-fix", id: "a" }]);
    expect(decideYoloAction(f, true)).toEqual({ kind: "approve" });
  });

  test("APPROVES a clean gate (no ask-user, no auto-fix)", () => {
    const f = findings([{ action: "no-op", id: "a" }]);
    expect(decideYoloAction(f, false)).toEqual({ kind: "approve" });
  });

  test("APPROVES an empty gate", () => {
    expect(decideYoloAction(findings([]), false)).toEqual({ kind: "approve" });
  });

  test("APPROVES when auto-fix findings exist but none have a usable id", () => {
    const f = findings([{ action: "auto-fix", id: "" }]);
    expect(decideYoloAction(f, false)).toEqual({ kind: "approve" });
  });
});
