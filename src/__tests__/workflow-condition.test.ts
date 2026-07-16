import { describe, test, expect } from "bun:test";
import { evaluateCondition } from "../runtime/workflow-condition";
import type { RefContext } from "../runtime/workflow-refs";
import type { AgentResult, WorkflowCondition } from "../types";

function ctx(input: Record<string, unknown> = {}): RefContext {
  return { input, stepResults: new Map<string, AgentResult>(), prevResult: undefined };
}

function evalLeaf(cond: WorkflowCondition, input: Record<string, unknown>) {
  return evaluateCondition(cond, ctx(input));
}

describe("evaluateCondition — leaf operators", () => {
  test("eq / neq (primitive and deep object equality)", () => {
    expect(evalLeaf({ ref: "$input.a", op: "eq", value: 1 }, { a: 1 }).passed).toBe(true);
    expect(evalLeaf({ ref: "$input.a", op: "neq", value: 2 }, { a: 1 }).passed).toBe(true);
    expect(evalLeaf({ ref: "$input.a", op: "eq", value: { x: 1 } }, { a: { x: 1 } }).passed).toBe(true);
    expect(evalLeaf({ ref: "$input.a", op: "eq", value: { x: 2 } }, { a: { x: 1 } }).passed).toBe(false);
    // one side non-object → deepEq falls through to false
    expect(evalLeaf({ ref: "$input.a", op: "eq", value: { x: 1 } }, { a: 5 }).passed).toBe(false);
  });

  test("numeric comparisons gt/gte/lt/lte", () => {
    expect(evalLeaf({ ref: "$input.n", op: "gt", value: 2 }, { n: 3 }).passed).toBe(true);
    expect(evalLeaf({ ref: "$input.n", op: "gte", value: 3 }, { n: 3 }).passed).toBe(true);
    expect(evalLeaf({ ref: "$input.n", op: "lt", value: 5 }, { n: 3 }).passed).toBe(true);
    expect(evalLeaf({ ref: "$input.n", op: "lte", value: 3 }, { n: 3 }).passed).toBe(true);
    expect(evalLeaf({ ref: "$input.n", op: "gt", value: 5 }, { n: 3 }).passed).toBe(false);
  });

  test("comparisons on non-numbers evaluate false (never throw)", () => {
    expect(evalLeaf({ ref: "$input.s", op: "gt", value: 2 }, { s: "text" }).passed).toBe(false);
    expect(evalLeaf({ ref: "$input.n", op: "lt", value: "x" }, { n: 3 }).passed).toBe(false);
  });

  test("contains covers string-substring and array-includes", () => {
    expect(evalLeaf({ ref: "$input.s", op: "contains", value: "ell" }, { s: "hello" }).passed).toBe(true);
    expect(evalLeaf({ ref: "$input.arr", op: "contains", value: 2 }, { arr: [1, 2, 3] }).passed).toBe(true);
    expect(evalLeaf({ ref: "$input.arr", op: "contains", value: 9 }, { arr: [1, 2, 3] }).passed).toBe(false);
    // non-string, non-array → false
    expect(evalLeaf({ ref: "$input.n", op: "contains", value: 1 }, { n: 5 }).passed).toBe(false);
  });

  test("exists = not undefined/null", () => {
    expect(evalLeaf({ ref: "$input.a", op: "exists" }, { a: 0 }).passed).toBe(true);
    expect(evalLeaf({ ref: "$input.a", op: "exists" }, { a: null }).passed).toBe(false);
    expect(evalLeaf({ ref: "$input.missing", op: "exists" }, {}).passed).toBe(false);
  });

  test("truthy = JS truthiness", () => {
    expect(evalLeaf({ ref: "$input.a", op: "truthy" }, { a: "x" }).passed).toBe(true);
    expect(evalLeaf({ ref: "$input.a", op: "truthy" }, { a: "" }).passed).toBe(false);
  });
});

describe("evaluateCondition — composition", () => {
  test("all: passes only when every child passes", () => {
    const cond: WorkflowCondition = {
      all: [
        { ref: "$input.a", op: "eq", value: 1 },
        { ref: "$input.b", op: "gt", value: 0 },
      ],
    };
    expect(evaluateCondition(cond, ctx({ a: 1, b: 5 })).passed).toBe(true);
    const fail = evaluateCondition(cond, ctx({ a: 1, b: -1 }));
    expect(fail.passed).toBe(false);
    expect(fail.reason).toContain("$input.b");
    expect(evaluateCondition({ all: [] }, ctx()).reason).toBe("all conditions passed");
  });

  test("any: passes when at least one child passes, else lists reasons", () => {
    const cond: WorkflowCondition = {
      any: [
        { ref: "$input.a", op: "eq", value: 99 },
        { ref: "$input.b", op: "eq", value: 2 },
      ],
    };
    expect(evaluateCondition(cond, ctx({ a: 1, b: 2 })).passed).toBe(true);
    const fail = evaluateCondition(cond, ctx({ a: 1, b: 1 }));
    expect(fail.passed).toBe(false);
    expect(fail.reason).toContain("none of the conditions matched");
  });

  test("not: inverts the child", () => {
    const r = evaluateCondition({ not: { ref: "$input.a", op: "eq", value: 1 } }, ctx({ a: 2 }));
    expect(r.passed).toBe(true);
    expect(r.reason).toContain("not(");
  });
});

describe("evaluateCondition — reason formatting", () => {
  test("exists/truthy omit the rhs; comparisons include the formatted value", () => {
    expect(evalLeaf({ ref: "$input.a", op: "exists" }, { a: 1 }).reason).not.toContain(" exists ");
    const cmp = evalLeaf({ ref: "$input.a", op: "eq", value: "s" }, { a: "s" });
    expect(cmp.reason).toContain('"s"');
    expect(cmp.reason).toContain("satisfies");
  });

  test("formats undefined, null and object actuals in the reason", () => {
    expect(evalLeaf({ ref: "$input.missing", op: "eq", value: 1 }, {}).reason).toContain("undefined");
    expect(evalLeaf({ ref: "$input.a", op: "eq", value: 1 }, { a: null }).reason).toContain("null");
    expect(evalLeaf({ ref: "$input.a", op: "eq", value: 1 }, { a: { x: 1 } }).reason).toContain('{"x":1}');
  });
});
