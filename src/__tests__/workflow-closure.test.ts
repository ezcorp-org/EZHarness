/**
 * The nesting graph walk — `collectWorkflowClosure` and its one edge
 * reader.
 *
 * Pure, so the matrix that covers it is cheap enough to be exhaustive.
 * Two callers depend on this being ONE walk (the validator's cycle/depth
 * check and C3's transitive capability hash), which is why the closure and
 * the diagnostics come out of the same call rather than two functions that
 * could eventually disagree about what is "inside" a workflow.
 */
import { test, expect, describe } from "bun:test";
import {
  collectWorkflowClosure,
  MAX_WORKFLOW_NESTING_DEPTH,
  nestedWorkflowNames,
} from "../runtime/workflow-closure";
import type { WorkflowDefinition, WorkflowStep } from "../types";

/** A definition whose steps nest `children`, in order. */
function def(
  name: string,
  children: string[] = [],
  extra: WorkflowStep[] = [],
): WorkflowDefinition {
  return {
    name,
    description: name,
    steps: [
      ...children.map((child, i) => ({
        name: `nest-${i}`,
        kind: "workflow" as const,
        workflow: child,
      })),
      ...extra,
    ],
  };
}

/** Resolve against a literal list — the shape the validator's injected
 *  resolver and C3's cache reader both reduce to. */
function resolverOver(defs: WorkflowDefinition[]) {
  return (name: string): WorkflowDefinition | undefined => defs.find((d) => d.name === name);
}

describe("nestedWorkflowNames", () => {
  test("reads only kind:workflow steps, in declaration order, de-duplicated", () => {
    const d: WorkflowDefinition = {
      name: "root",
      description: "",
      steps: [
        { name: "a", agent: "x" },
        { name: "b", kind: "workflow", workflow: "beta" },
        { name: "c", kind: "transform", output: { v: "$input.v" } },
        { name: "d", kind: "workflow", workflow: "alpha" },
        // A repeat is one EDGE, not two: the closure is a set.
        { name: "e", kind: "workflow", workflow: "beta" },
      ],
    };
    expect(nestedWorkflowNames(d)).toEqual(["beta", "alpha"]);
  });

  test("a kind:workflow step with no target contributes no edge", () => {
    // The validator rejects this separately; the walk must not invent an
    // edge to `""` and then report it unresolved, which would bury the real
    // error under a second one.
    const d: WorkflowDefinition = {
      name: "root",
      description: "",
      steps: [{ name: "a", kind: "workflow" }],
    };
    expect(nestedWorkflowNames(d)).toEqual([]);
  });

  test("a missing `steps` array is empty, not a crash", () => {
    expect(nestedWorkflowNames({ name: "r", description: "" } as WorkflowDefinition)).toEqual([]);
  });
});

describe("collectWorkflowClosure", () => {
  test("returns the root first, then everything reachable, once each", () => {
    const root = def("root", ["a", "b"]);
    const a = def("a", ["leaf"]);
    const b = def("b", ["leaf"]);
    const leaf = def("leaf");

    const closure = collectWorkflowClosure(root, resolverOver([a, b, leaf]));

    expect(closure.definitions.map((d) => d.name)).toEqual(["root", "a", "leaf", "b"]);
    expect(closure.cycles).toEqual([]);
    expect(closure.unresolved).toEqual([]);
    expect(closure.tooDeep).toEqual([]);
  });

  test("a workflow nesting itself is a cycle, named", () => {
    const root = def("root", ["root"]);
    const closure = collectWorkflowClosure(root, resolverOver([root]));
    expect(closure.cycles).toEqual([["root", "root"]]);
  });

  test("a mutual cycle names the path that closes it", () => {
    const a = def("a", ["b"]);
    const b = def("b", ["a"]);
    const closure = collectWorkflowClosure(a, resolverOver([a, b]));
    expect(closure.cycles).toEqual([["a", "b", "a"]]);
  });

  test("a cycle is detected rather than followed — the walk terminates", () => {
    // The property that matters: no stack overflow, and the closure still
    // reports every definition it legitimately reached.
    const a = def("a", ["b"]);
    const b = def("b", ["c"]);
    const c = def("c", ["a"]);
    const closure = collectWorkflowClosure(a, resolverOver([a, b, c]));
    expect(closure.definitions.map((d) => d.name)).toEqual(["a", "b", "c"]);
    expect(closure.cycles).toEqual([["a", "b", "c", "a"]]);
  });

  test("a chain deeper than the cap reports the name that broke it", () => {
    const chain = [
      def("d0", ["d1"]),
      def("d1", ["d2"]),
      def("d2", ["d3"]),
      def("d3", ["d4"]),
      def("d4"),
    ];
    const closure = collectWorkflowClosure(chain[0]!, resolverOver(chain));
    // d1/d2/d3 are depths 1..3 and legal; d4 would be depth 4.
    expect(closure.definitions.map((d) => d.name)).toEqual(["d0", "d1", "d2", "d3"]);
    expect(closure.tooDeep).toEqual(["d4"]);
    expect(MAX_WORKFLOW_NESTING_DEPTH).toBe(3);
  });

  test("a shared subtree is re-checked from the DEEPER path, not only the first", () => {
    // `shared` is reachable at depth 1 (declared first) and again at depth
    // 3 via the chain. Its own child `leaf` is therefore depth 2 on the
    // short path and depth 4 — over the cap — on the long one.
    //
    // Memoizing expansion on the NAME alone would expand `shared` once, at
    // depth 1, and never depth-check `leaf` from the long path: the
    // violation would vanish silently. Keying the memo on `depth:name` is
    // what makes this the deeper answer rather than the first one.
    const root = def("root", ["shared", "p1"]);
    const p1 = def("p1", ["p2"]);
    const p2 = def("p2", ["shared"]);
    const shared = def("shared", ["leaf"]);
    const leaf = def("leaf");

    const closure = collectWorkflowClosure(root, resolverOver([p1, p2, shared, leaf]));

    expect(closure.tooDeep).toEqual(["leaf"]);
    // Both are still INCLUDED — they genuinely are inside the closure via
    // the short path, and the capability hash needs every one of them.
    expect(closure.definitions.map((d) => d.name)).toContain("shared");
    expect(closure.definitions.map((d) => d.name)).toContain("leaf");
  });

  test("a diamond expands its shared leaf once and includes it once", () => {
    const root = def("root", ["l", "r"]);
    const l = def("l", ["leaf"]);
    const r = def("r", ["leaf"]);
    let leafReads = 0;
    const leaf = def("leaf");
    const resolve = (name: string): WorkflowDefinition | undefined => {
      if (name === "leaf") leafReads++;
      return [l, r, leaf].find((d) => d.name === name);
    };

    const closure = collectWorkflowClosure(root, resolve);

    expect(closure.definitions.filter((d) => d.name === "leaf")).toHaveLength(1);
    // Resolved twice (once per edge) but EXPANDED once — the memo is on
    // expansion, and re-walking a shared subtree per edge is what makes a
    // wide diamond graph quadratic.
    expect(leafReads).toBe(2);
  });

  test("an unresolvable name is reported, not thrown, and does not stop the walk", () => {
    const root = def("root", ["ghost", "real"]);
    const real = def("real");
    const closure = collectWorkflowClosure(root, resolverOver([real]));
    expect(closure.unresolved).toEqual(["ghost"]);
    expect(closure.definitions.map((d) => d.name)).toEqual(["root", "real"]);
  });

  test("a cycle wins over a depth violation for the same name", () => {
    // Order matters: bouncing round a 1-cycle would otherwise be reported
    // as "too deep" after three hops, which names the symptom instead of
    // the cause.
    const a = def("a", ["a"]);
    const closure = collectWorkflowClosure(a, resolverOver([a]), 0);
    expect(closure.cycles).toEqual([["a", "a"]]);
    expect(closure.tooDeep).toEqual([]);
  });
});
