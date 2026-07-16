import { describe, test, expect } from "bun:test";
import {
  validateWorkflow,
  clampMaxIterations,
  clampRetries,
  stepKind,
  MAX_ITERATIONS_CEILING,
  MAX_ITERATIONS_FLOOR,
  RETRIES_CEILING,
} from "../runtime/workflow-validator";
import type { WorkflowDefinition, WorkflowStep } from "../types";

describe("clampMaxIterations", () => {
  test("bounds to the 1..25 range and floors fractionals", () => {
    expect(clampMaxIterations(0)).toBe(MAX_ITERATIONS_FLOOR);
    expect(clampMaxIterations(100)).toBe(MAX_ITERATIONS_CEILING);
    expect(clampMaxIterations(3)).toBe(3);
    expect(clampMaxIterations(3.9)).toBe(3);
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
