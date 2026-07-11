import { test, expect, describe } from "bun:test";
import { detectCycle } from "../runtime/graph-cycle";

/** Build an `edgesOf` accessor from a plain adjacency map. */
function edges(adj: Record<string, string[]>): (n: string) => string[] {
  return (n) => adj[n] ?? [];
}

describe("detectCycle (generic)", () => {
  test("direct self-loop returns the repeated node at both ends", () => {
    expect(detectCycle("A", edges({ A: ["A"] }))).toEqual(["A", "A"]);
  });

  test("two-node cycle", () => {
    expect(detectCycle("A", edges({ A: ["B"], B: ["A"] }))).toEqual(["A", "B", "A"]);
  });

  test("transitive three-node cycle", () => {
    expect(detectCycle("A", edges({ A: ["B"], B: ["C"], C: ["A"] }))).toEqual([
      "A",
      "B",
      "C",
      "A",
    ]);
  });

  test("acyclic reachable subgraph returns null", () => {
    expect(detectCycle("A", edges({ A: ["B", "C"], B: ["D"], C: ["D"], D: [] }))).toBeNull();
  });

  test("a node with no out-edges returns null", () => {
    expect(detectCycle("A", edges({}))).toBeNull();
  });

  test("shared descendant visited twice does not false-positive (diamond)", () => {
    // A → B → D and A → C → D: D is reached twice but is not on the active
    // path the second time, so the `visited` short-circuit returns null.
    expect(detectCycle("A", edges({ A: ["B", "C"], B: ["D"], C: ["D"], D: [] }))).toBeNull();
  });

  test("reports only a cycle reachable from the start node", () => {
    // B↔C is a cycle, but it is unreachable from A → null.
    expect(detectCycle("A", edges({ A: [], B: ["C"], C: ["B"] }))).toBeNull();
  });

  test("finds a cycle deeper in the reachable graph", () => {
    // A → B → C → B.
    expect(detectCycle("A", edges({ A: ["B"], B: ["C"], C: ["B"] }))).toEqual(["B", "C", "B"]);
  });
});
