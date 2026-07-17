import { describe, test, expect } from "bun:test";
import {
  validateWorkflow,
  validateCondition,
  clampMaxIterations,
  clampRetries,
  stepKind,
  MAX_ITERATIONS_CEILING,
  MAX_ITERATIONS_FLOOR,
  RETRIES_CEILING,
  MAX_STEPS_PER_WORKFLOW,
  MAX_MAPPING_VALUE_LENGTH,
  MAX_CONDITION_DEPTH,
} from "../runtime/workflow-validator";
import type { WorkflowDefinition, WorkflowStep } from "../types";

describe("clampMaxIterations", () => {
  test("bounds to the 1..25 range and floors fractionals", () => {
    expect(clampMaxIterations(0)).toBe(MAX_ITERATIONS_FLOOR);
    expect(clampMaxIterations(100)).toBe(MAX_ITERATIONS_CEILING);
    expect(clampMaxIterations(3)).toBe(3);
    expect(clampMaxIterations(3.9)).toBe(3);
  });

  test("a non-finite value clamps to the floor (never a zero-iteration pass)", () => {
    // NaN would otherwise short-circuit `i <= NaN` into zero iterations —
    // a silent pass. Infinity would otherwise run the full ceiling.
    expect(clampMaxIterations(Number.NaN)).toBe(MAX_ITERATIONS_FLOOR);
    expect(clampMaxIterations(Number.POSITIVE_INFINITY)).toBe(MAX_ITERATIONS_FLOOR);
    expect(clampMaxIterations(Number.NEGATIVE_INFINITY)).toBe(MAX_ITERATIONS_FLOOR);
  });
});

describe("clampRetries", () => {
  test("absent / non-number / non-finite ⇒ 0", () => {
    expect(clampRetries(undefined)).toBe(0);
    expect(clampRetries(Number.NaN)).toBe(0);
    expect(clampRetries(Number.POSITIVE_INFINITY)).toBe(0);
  });
  test("negative ⇒ 0; above ceiling clamps; in-range floors", () => {
    expect(clampRetries(-3)).toBe(0);
    expect(clampRetries(9)).toBe(RETRIES_CEILING);
    expect(clampRetries(1.7)).toBe(1);
  });
});

describe("stepKind", () => {
  test("defaults to agent, honours explicit kind", () => {
    expect(stepKind({ name: "s" } as WorkflowStep)).toBe("agent");
    expect(stepKind({ name: "s", kind: "gate" } as WorkflowStep)).toBe("gate");
  });
});

function def(steps: unknown[], name = "wf"): WorkflowDefinition {
  return { name, description: "", steps: steps as WorkflowStep[] };
}

describe("validateWorkflow — structural rejections", () => {
  test("valid workflow returns no errors", () => {
    expect(
      validateWorkflow(
        def([
          { name: "a", agent: "x" },
          { name: "b", kind: "transform", output: { n: "$input.n" } },
          { name: "c", kind: "gate", condition: { ref: "$input.n", op: "exists" }, dependsOn: ["a"] },
        ]),
      ),
    ).toEqual([]);
  });

  test("rejects empty / non-string name", () => {
    expect(validateWorkflow(def([{ name: "a", agent: "x" }], ""))).toContain(
      "Workflow must have a non-empty name",
    );
    expect(
      validateWorkflow({ name: 123 as unknown as string, description: "", steps: [{ name: "a", agent: "x" }] as WorkflowStep[] }),
    ).toContain("Workflow must have a non-empty name");
  });

  test("rejects missing steps array and empty steps array", () => {
    expect(
      validateWorkflow({ name: "wf", description: "", steps: undefined as unknown as WorkflowStep[] }),
    ).toContain("Workflow must have at least one step");
    expect(validateWorkflow(def([]))).toContain("Workflow must have at least one step");
  });

  test("rejects a step with an empty name", () => {
    expect(validateWorkflow(def([{ name: "", agent: "x" }]))).toContain(
      "Every step must have a non-empty name",
    );
  });

  test("rejects duplicate step names", () => {
    const errs = validateWorkflow(def([
      { name: "dup", agent: "x" },
      { name: "dup", agent: "y" },
    ]));
    expect(errs.some((e) => e.includes('Duplicate step name "dup"'))).toBe(true);
  });
});

describe("validateWorkflow — kind rejections", () => {
  test("unknown kind", () => {
    expect(
      validateWorkflow(def([{ name: "s", kind: "bogus" as unknown as "agent" }])),
    ).toContain('Step "s" has unknown kind "bogus"');
  });

  test("agent kind without agent", () => {
    expect(validateWorkflow(def([{ name: "s", kind: "agent" }]))).toContain(
      'Step "s" (kind "agent") requires an "agent"',
    );
  });

  test("transform kind without output", () => {
    expect(validateWorkflow(def([{ name: "s", kind: "transform" }]))).toContain(
      'Step "s" (kind "transform") requires an "output" mapping',
    );
  });

  test("gate kind without condition", () => {
    expect(validateWorkflow(def([{ name: "s", kind: "gate" }]))).toContain(
      'Step "s" (kind "gate") requires a "condition"',
    );
  });
});

describe("validateWorkflow — dependency + loop rejections", () => {
  test("dependsOn naming an unknown step", () => {
    expect(
      validateWorkflow(def([{ name: "s", agent: "x", dependsOn: ["ghost"] }])),
    ).toContain('Step "s" depends on unknown step "ghost"');
  });

  test("a step depending on itself is rejected at definition time", () => {
    // Used to pass create and then fail every run with "Circular dependency".
    expect(
      validateWorkflow(def([{ name: "s", agent: "x", dependsOn: ["s"] }])),
    ).toContain('Step "s" cannot depend on itself');
  });

  test("a non-string mapping value is rejected (YAML loader path)", () => {
    // zod protects the API; a YAML `output: { n: 42 }` used to crash the
    // resolver at run time with `ref.startsWith is not a function`.
    expect(
      validateWorkflow(
        def([{ name: "t", kind: "transform", output: { n: 42 } as never }]),
      ),
    ).toContain(
      'Step "t" output mapping value for "n" must be a string ref, template or literal (got number)',
    );
    expect(
      validateWorkflow(
        def([{ name: "s", agent: "x", input: { obj: {} } as never }]),
      ),
    ).toContain(
      'Step "s" input mapping value for "obj" must be a string ref, template or literal (got object)',
    );
  });

  test("loop on a gate step", () => {
    expect(
      validateWorkflow(
        def([{ name: "g", kind: "gate", condition: { ref: "$input.n", op: "exists" }, loop: { maxIterations: 2 } }]),
      ),
    ).toContain('Step "g" (kind "gate") cannot have a "loop"');
  });

  test("loop and retries together", () => {
    expect(
      validateWorkflow(def([{ name: "s", agent: "x", loop: { maxIterations: 2 }, retries: 1 }])),
    ).toContain('Step "s" cannot combine "loop" and "retries" (mutually exclusive)');
  });

  test("loop with missing / non-integer maxIterations", () => {
    expect(
      validateWorkflow(def([{ name: "s", agent: "x", loop: { maxIterations: undefined as unknown as number } }])),
    ).toContain('Step "s" loop requires an integer "maxIterations"');
    expect(
      validateWorkflow(def([{ name: "s", agent: "x", loop: { maxIterations: 2.5 } }])),
    ).toContain('Step "s" loop requires an integer "maxIterations"');
  });

  test("out-of-range but integer maxIterations is NOT a validation error (clamped at run time)", () => {
    expect(validateWorkflow(def([{ name: "s", agent: "x", loop: { maxIterations: 100 } }]))).toEqual([]);
  });
});

describe("validateWorkflow — definition-time caps (untrusted definitions)", () => {
  test("rejects a workflow with more than the maximum number of steps", () => {
    const steps = Array.from({ length: MAX_STEPS_PER_WORKFLOW + 1 }, (_, i) => ({
      name: `s${i}`,
      agent: "x",
    }));
    expect(validateWorkflow(def(steps))).toContain(
      `Workflow has ${MAX_STEPS_PER_WORKFLOW + 1} steps (maximum ${MAX_STEPS_PER_WORKFLOW})`,
    );
    // Exactly at the cap is fine.
    expect(validateWorkflow(def(steps.slice(0, MAX_STEPS_PER_WORKFLOW)))).toEqual([]);
  });

  test("rejects an over-long input/output mapping value; at-cap passes", () => {
    const atCap = "a".repeat(MAX_MAPPING_VALUE_LENGTH);
    const overCap = `${atCap}!`;
    expect(
      validateWorkflow(def([{ name: "s", agent: "x", input: { big: overCap } }])),
    ).toContain(
      `Step "s" input mapping value for "big" exceeds the maximum length of ${MAX_MAPPING_VALUE_LENGTH} characters`,
    );
    expect(
      validateWorkflow(def([{ name: "t", kind: "transform", output: { big: overCap } }])),
    ).toContain(
      `Step "t" output mapping value for "big" exceeds the maximum length of ${MAX_MAPPING_VALUE_LENGTH} characters`,
    );
    expect(
      validateWorkflow(def([{ name: "s", agent: "x", input: { big: atCap } }])),
    ).toEqual([]);
  });

  test("rejects a condition tree nested deeper than the maximum depth", () => {
    let deep: unknown = { ref: "$input.n", op: "exists" };
    for (let i = 0; i < MAX_CONDITION_DEPTH; i++) deep = { not: deep };
    // Leaf at exactly MAX_CONDITION_DEPTH is fine…
    expect(validateCondition(deep, "cond")).toEqual([]);
    // …one more level of nesting is rejected, from validateWorkflow too.
    const tooDeep = { not: deep };
    expect(
      validateCondition(tooDeep, "cond").some((e) =>
        e.includes(`maximum condition nesting depth of ${MAX_CONDITION_DEPTH}`),
      ),
    ).toBe(true);
    const errs = validateWorkflow(
      def([{ name: "g", kind: "gate", condition: tooDeep as never }]),
    );
    expect(
      errs.some((e) => e.includes(`maximum condition nesting depth of ${MAX_CONDITION_DEPTH}`)),
    ).toBe(true);
  });
});

describe("validateCondition — shape validation", () => {
  test("a well-formed leaf / tree returns no errors", () => {
    expect(validateCondition({ ref: "$input.n", op: "gte", value: 3 }, "cond")).toEqual([]);
    expect(
      validateCondition(
        {
          all: [
            { ref: "$input.a", op: "exists" },
            { any: [{ ref: "$input.b", op: "truthy" }] },
            { not: { ref: "$input.c", op: "eq", value: 1 } },
          ],
        },
        "cond",
      ),
    ).toEqual([]);
  });

  test("a non-object condition is rejected", () => {
    expect(validateCondition(null, "cond")).toContain("cond must be an object");
    expect(validateCondition("nope", "cond")).toContain("cond must be an object");
  });

  test("`all` / `any` must be non-empty arrays", () => {
    expect(validateCondition({ all: [] }, "cond")).toContain(
      'cond "all" must be a non-empty array',
    );
    expect(validateCondition({ any: "x" as unknown }, "cond")).toContain(
      'cond "any" must be a non-empty array',
    );
  });

  test("recurses into `not` and reports the nested label", () => {
    expect(validateCondition({ not: { op: "eq" } }, "cond")).toContain(
      'cond not leaf requires a non-empty string "ref"',
    );
  });

  test("a leaf needs a non-empty string ref", () => {
    expect(validateCondition({ op: "eq", value: 1 }, "cond")).toContain(
      'cond leaf requires a non-empty string "ref"',
    );
    expect(validateCondition({ ref: "  ", op: "eq" }, "cond")).toContain(
      'cond leaf requires a non-empty string "ref"',
    );
  });

  test("a leaf rejects an unknown or missing op", () => {
    const errs = validateCondition({ ref: "$input.n", op: "startsWith" }, "cond");
    expect(errs.some((e) => e.includes('leaf has an invalid or missing "op"'))).toBe(true);
    expect(
      validateCondition({ ref: "$input.n" }, "cond").some((e) =>
        e.includes('leaf has an invalid or missing "op"'),
      ),
    ).toBe(true);
  });
});

describe("validateWorkflow — condition + loop-until shape (repro: empty condition)", () => {
  test("a gate with an empty condition object is rejected at definition time", () => {
    // Regression: `condition: {}` used to pass create then die at run with a
    // raw `TypeError` inside the ref resolver.
    const errs = validateWorkflow(def([{ name: "g", kind: "gate", condition: {} as never }]));
    expect(errs.some((e) => e.includes('Step "g" condition leaf requires'))).toBe(true);
  });

  test("a gate with an unknown op is rejected", () => {
    const errs = validateWorkflow(
      def([{ name: "g", kind: "gate", condition: { ref: "$input.n", op: "bogus" as never } }]),
    );
    expect(errs.some((e) => e.includes('Step "g" condition leaf has an invalid or missing "op"'))).toBe(
      true,
    );
  });

  test("a loop until with a malformed condition is rejected", () => {
    const errs = validateWorkflow(
      def([
        {
          name: "s",
          kind: "transform",
          output: { n: "$loop.iteration" },
          loop: { maxIterations: 3, until: { op: "gte", value: 3 } as never },
        },
      ]),
    );
    expect(errs.some((e) => e.includes('Step "s" loop until leaf requires a non-empty string "ref"'))).toBe(
      true,
    );
  });
});
