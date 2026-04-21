import { test, expect, describe } from "bun:test";
import { detectCycle } from "../runtime/dag-validator";

describe("detectCycle", () => {
  test("direct self-reference returns cycle", () => {
    const result = detectCycle("A", ["A"], new Map());
    expect(result).toEqual(["A", "A"]);
  });

  test("direct cycle between two agents", () => {
    const allRefs = new Map([["A", []], ["B", ["A"]]]);
    const result = detectCycle("A", ["B"], allRefs);
    expect(result).toEqual(["A", "B", "A"]);
  });

  test("transitive cycle through three agents", () => {
    const allRefs = new Map([["B", ["C"]], ["C", ["A"]]]);
    const result = detectCycle("A", ["B"], allRefs);
    expect(result).toEqual(["A", "B", "C", "A"]);
  });

  test("valid DAG returns null", () => {
    const allRefs = new Map([["A", []], ["B", []]]);
    const result = detectCycle("A", ["B"], allRefs);
    expect(result).toBeNull();
  });

  test("no references returns null", () => {
    const result = detectCycle("A", [], new Map());
    expect(result).toBeNull();
  });

  test("does not mutate allRefs map", () => {
    const allRefs = new Map([["B", ["C"]], ["C", []]]);
    detectCycle("A", ["B"], allRefs);
    expect(allRefs.has("A")).toBe(false);
    expect(allRefs.get("B")).toEqual(["C"]);
  });

  test("complex DAG without cycle returns null", () => {
    const allRefs = new Map([["B", ["D"]], ["C", ["D"]], ["D", []]]);
    const result = detectCycle("A", ["B", "C"], allRefs);
    expect(result).toBeNull();
  });
});
