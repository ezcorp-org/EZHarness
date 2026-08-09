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
          {
            name: "c",
            kind: "gate",
            condition: { ref: "$input.n", op: "exists" },
            dependsOn: ["a"],
          },
        ]),
      ),
    ).toEqual([]);
  });

  test("rejects empty / non-string name", () => {
    expect(validateWorkflow(def([{ name: "a", agent: "x" }], ""))).toContain(
      "Workflow must have a non-empty name",
    );
    expect(
      validateWorkflow({
        name: 123 as unknown as string,
        description: "",
        steps: [{ name: "a", agent: "x" }] as WorkflowStep[],
      }),
    ).toContain("Workflow must have a non-empty name");
  });

  test("rejects missing steps array and empty steps array", () => {
    expect(
      validateWorkflow({
        name: "wf",
        description: "",
        steps: undefined as unknown as WorkflowStep[],
      }),
    ).toContain("Workflow must have at least one step");
    expect(validateWorkflow(def([]))).toContain("Workflow must have at least one step");
  });

  test("rejects a step with an empty name", () => {
    expect(validateWorkflow(def([{ name: "", agent: "x" }]))).toContain(
      "Every step must have a non-empty name",
    );
  });

  test("rejects duplicate step names", () => {
    const errs = validateWorkflow(
      def([
        { name: "dup", agent: "x" },
        { name: "dup", agent: "y" },
      ]),
    );
    expect(errs.some((e) => e.includes('Duplicate step name "dup"'))).toBe(true);
  });
});

describe("validateWorkflow — kind rejections", () => {
  test("unknown kind", () => {
    expect(validateWorkflow(def([{ name: "s", kind: "bogus" as unknown as "agent" }]))).toContain(
      'Step "s" has unknown kind "bogus"',
    );
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

  test("tool is a valid kind", () => {
    expect(stepKind({ name: "s", kind: "tool", tool: "ext__t" })).toBe("tool");
    expect(validateWorkflow(def([{ name: "s", kind: "tool", tool: "ext__t" }]))).toEqual([]);
  });

  test("tool kind without tool", () => {
    expect(validateWorkflow(def([{ name: "s", kind: "tool" }]))).toContain(
      'Step "s" (kind "tool") requires a "tool"',
    );
  });

  test("tool kind cannot also name an agent", () => {
    expect(
      validateWorkflow(def([{ name: "s", kind: "tool", tool: "ext__t", agent: "writer" }])),
    ).toContain('Step "s" (kind "tool") cannot also specify an "agent"');
  });

  test("a tool step's input mapping is validated like every other kind", () => {
    expect(
      validateWorkflow(
        def([
          {
            name: "s",
            kind: "tool",
            tool: "ext__t",
            input: { n: 42 as unknown as string },
          },
        ]),
      ),
    ).toContain(
      'Step "s" input mapping value for "n" must be a string ref, template or literal (got number)',
    );
  });
});

describe("validateWorkflow — dependency + loop rejections", () => {
  test("dependsOn naming an unknown step", () => {
    expect(validateWorkflow(def([{ name: "s", agent: "x", dependsOn: ["ghost"] }]))).toContain(
      'Step "s" depends on unknown step "ghost"',
    );
  });

  test("a step depending on itself is rejected at definition time", () => {
    // Used to pass create and then fail every run with "Circular dependency".
    expect(validateWorkflow(def([{ name: "s", agent: "x", dependsOn: ["s"] }]))).toContain(
      'Step "s" cannot depend on itself',
    );
  });

  test("a non-string mapping value is rejected (YAML loader path)", () => {
    // zod protects the API; a YAML `output: { n: 42 }` used to crash the
    // resolver at run time with `ref.startsWith is not a function`.
    expect(
      validateWorkflow(def([{ name: "t", kind: "transform", output: { n: 42 } as never }])),
    ).toContain(
      'Step "t" output mapping value for "n" must be a string ref, template or literal (got number)',
    );
    expect(
      validateWorkflow(def([{ name: "s", agent: "x", input: { obj: {} } as never }])),
    ).toContain(
      'Step "s" input mapping value for "obj" must be a string ref, template or literal (got object)',
    );
  });

  test("loop on a gate step", () => {
    expect(
      validateWorkflow(
        def([
          {
            name: "g",
            kind: "gate",
            condition: { ref: "$input.n", op: "exists" },
            loop: { maxIterations: 2 },
          },
        ]),
      ),
    ).toContain('Step "g" (kind "gate") cannot have a "loop"');
  });

  test("loop on a tool step", () => {
    // Looping a side-effecting tool call (install / write / shell) with no
    // LLM in the middle is deliberately out of scope; rejected loudly at
    // definition time rather than mis-dispatched onto the agent path.
    expect(
      validateWorkflow(
        def([{ name: "t", kind: "tool", tool: "ext__t", loop: { maxIterations: 2 } }]),
      ),
    ).toContain('Step "t" (kind "tool") cannot have a "loop"');
  });

  test("loop and retries together", () => {
    expect(
      validateWorkflow(def([{ name: "s", agent: "x", loop: { maxIterations: 2 }, retries: 1 }])),
    ).toContain('Step "s" cannot combine "loop" and "retries" (mutually exclusive)');
  });

  test("loop + retries mutual exclusion still applies to a tool step", () => {
    expect(
      validateWorkflow(
        def([
          {
            name: "t",
            kind: "tool",
            tool: "ext__t",
            loop: { maxIterations: 2 },
            retries: 1,
          },
        ]),
      ),
    ).toContain('Step "t" cannot combine "loop" and "retries" (mutually exclusive)');
  });

  test("loop with missing / non-integer maxIterations", () => {
    expect(
      validateWorkflow(
        def([{ name: "s", agent: "x", loop: { maxIterations: undefined as unknown as number } }]),
      ),
    ).toContain('Step "s" loop requires an integer "maxIterations"');
    expect(
      validateWorkflow(def([{ name: "s", agent: "x", loop: { maxIterations: 2.5 } }])),
    ).toContain('Step "s" loop requires an integer "maxIterations"');
  });

  test("out-of-range but integer maxIterations is NOT a validation error (clamped at run time)", () => {
    expect(
      validateWorkflow(def([{ name: "s", agent: "x", loop: { maxIterations: 100 } }])),
    ).toEqual([]);
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
    expect(validateWorkflow(def([{ name: "s", agent: "x", input: { big: overCap } }]))).toContain(
      `Step "s" input mapping value for "big" exceeds the maximum length of ${MAX_MAPPING_VALUE_LENGTH} characters`,
    );
    expect(
      validateWorkflow(def([{ name: "t", kind: "transform", output: { big: overCap } }])),
    ).toContain(
      `Step "t" output mapping value for "big" exceeds the maximum length of ${MAX_MAPPING_VALUE_LENGTH} characters`,
    );
    expect(validateWorkflow(def([{ name: "s", agent: "x", input: { big: atCap } }]))).toEqual([]);
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
    const errs = validateWorkflow(def([{ name: "g", kind: "gate", condition: tooDeep as never }]));
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
    expect(
      errs.some((e) => e.includes('Step "g" condition leaf has an invalid or missing "op"')),
    ).toBe(true);
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
    expect(
      errs.some((e) => e.includes('Step "s" loop until leaf requires a non-empty string "ref"')),
    ).toBe(true);
  });
});

describe("validateWorkflow — per-step model bindings", () => {
  test("an agent step may carry a well-formed model binding", () => {
    expect(
      validateWorkflow(
        def([{ name: "verify", agent: "a", model: { model: "claude-opus-5", maxTokens: 8000 } }]),
      ),
    ).toEqual([]);
  });

  test.each(["transform", "gate", "tool"] as const)(
    "a %s step cannot carry a model binding (it runs no LLM)",
    (kind) => {
      const step: Record<string, unknown> = { name: "s", kind, model: { model: "m" } };
      if (kind === "transform") step.output = { a: "x" };
      if (kind === "gate") step.condition = { ref: "$input.n", op: "truthy" };
      if (kind === "tool") step.tool = "demo__x";
      const errs = validateWorkflow(def([step]));
      // Silently ignoring it would be the classic "I set it and nothing
      // happened" bug — it must be rejected at definition time.
      expect(
        errs.some(
          (e) =>
            e ===
            `Step "s" (kind "${kind}") cannot specify a "model" override — only agent steps run an LLM`,
        ),
      ).toBe(true);
    },
  );

  test("a malformed agent-step binding is rejected with the step named", () => {
    const errs = validateWorkflow(def([{ name: "verify", agent: "a", model: { temperature: 9 } }]));
    expect(errs.some((e) => e.startsWith('Step "verify" model "temperature"'))).toBe(true);
  });

  test("a definition-level defaultModel is validated", () => {
    const d = def([{ name: "s", agent: "a" }]);
    d.defaultModel = { effort: "nope" } as never;
    const errs = validateWorkflow(d);
    expect(errs.some((e) => e.startsWith('Workflow "defaultModel" "effort" must be one of'))).toBe(
      true,
    );
  });

  test("a valid defaultModel passes", () => {
    const d = def([{ name: "s", agent: "a" }]);
    d.defaultModel = { provider: "anthropic", model: "claude-haiku-4-5-20251001" };
    expect(validateWorkflow(d)).toEqual([]);
  });

  test("a bad defaultModel is reported even when the step list is also invalid", () => {
    // Checked BEFORE the steps early-return, so it is not hidden behind an
    // unrelated fix.
    const d: WorkflowDefinition = { name: "wf", description: "", steps: [] };
    d.defaultModel = { maxTokens: -1 };
    const errs = validateWorkflow(d);
    expect(errs.some((e) => e.startsWith('Workflow "defaultModel" "maxTokens"'))).toBe(true);
    expect(errs).toContain("Workflow must have at least one step");
  });
});

describe("validateWorkflow — approval steps", () => {
  const approval = (extra: Partial<WorkflowStep> = {}): WorkflowDefinition => ({
    name: "wf",
    description: "",
    steps: [
      {
        name: "gate",
        kind: "approval",
        prompt: "Ship it?",
        choices: ["approve", "reject"],
        ...extra,
      } as WorkflowStep,
    ],
  });

  test("a well-formed approval step validates", () => {
    expect(validateWorkflow(approval())).toEqual([]);
  });

  test("requires a prompt and a non-empty choices array", () => {
    // The executor would only discover these at run time — by which point
    // it has parked a human on a question with no answers, or suspended
    // with nothing to render.
    expect(validateWorkflow(approval({ prompt: undefined }))[0]).toContain('requires a "prompt"');
    expect(validateWorkflow(approval({ choices: [] }))[0]).toContain("non-empty");
    expect(validateWorkflow(approval({ choices: undefined }))[0]).toContain("non-empty");
  });

  test("rejects empty and duplicate choices", () => {
    expect(validateWorkflow(approval({ choices: ["approve", ""] }))[0]).toContain(
      "empty or non-string choice",
    );
    // A duplicate is ambiguous the moment anyone picks it, and resolves
    // into `$steps.gate.output.choice` indistinguishably.
    expect(validateWorkflow(approval({ choices: ["a", "a"] }))[0]).toContain("duplicate choices");
  });

  test("rejects an approval that also names an agent or tool", () => {
    expect(validateWorkflow(approval({ agent: "writer" }))[0]).toContain("cannot also specify");
    expect(validateWorkflow(approval({ tool: "x__y" }))[0]).toContain("cannot also specify");
  });

  test("rejects requireItemConsent with no itemsRef", () => {
    // With no items the guard reads a clean gate and waves every answer
    // through ids-free — the exact opposite of what was asked for.
    const errs = validateWorkflow(approval({ requireItemConsent: true }));
    expect(errs[0]).toContain("would silently pass");
  });

  test("rejects a non-positive or non-integer timeout", () => {
    expect(validateWorkflow(approval({ timeoutMs: 0 }))[0]).toContain("positive integer");
    expect(validateWorkflow(approval({ timeoutMs: -1 }))[0]).toContain("positive integer");
    expect(validateWorkflow(approval({ timeoutMs: 1.5 }))[0]).toContain("positive integer");
    expect(validateWorkflow(approval({ timeoutMs: 1000 }))).toEqual([]);
  });

  test("rejects an unknown onTimeout policy", () => {
    const errs = validateWorkflow(approval({ onTimeout: "yolo" as never }));
    expect(errs[0]).toContain("abort | approve | skip");
  });

  test("rejects onTimeout:approve without a timeout", () => {
    // Deciding on a human's behalf may only be reached deliberately —
    // never as a side effect of a default filling in a missing timeout.
    const errs = validateWorkflow(approval({ onTimeout: "approve" }));
    expect(errs[0]).toContain('"onTimeout: approve" without a "timeoutMs"');
    expect(validateWorkflow(approval({ onTimeout: "approve", timeoutMs: 5000 }))).toEqual([]);
  });

  test("rejects onTimeout:approve|skip whose policy name is not a declared choice", () => {
    // The sweep answers with the POLICY NAME, and the consent guard
    // rejects an undeclared choice rather than coercing it. Without this
    // rule the failure surfaces at 3am as a cancelled run.
    const errs = validateWorkflow(
      approval({ onTimeout: "approve", timeoutMs: 5000, choices: ["ship", "hold"] }),
    );
    expect(errs[0]).toContain('does not declare "approve" in its "choices"');

    expect(
      validateWorkflow(approval({ onTimeout: "skip", choices: ["ship", "hold"] }))[0],
    ).toContain('does not declare "skip" in its "choices"');

    // Declared ⇒ valid. `abort` never answers, so it needs no choice.
    expect(validateWorkflow(approval({ onTimeout: "skip", choices: ["skip", "go"] }))).toEqual([]);
    expect(validateWorkflow(approval({ onTimeout: "abort", choices: ["ship"] }))).toEqual([]);
  });

  test("rejects loop and retries on an approval", () => {
    // A human decision is not a retryable computation: re-asking would
    // either re-park the same question or silently reuse the first answer.
    expect(validateWorkflow(approval({ retries: 2 }))[0]).toContain('cannot specify "retries"');
    expect(validateWorkflow(approval({ loop: { maxIterations: 2 } }))[0]).toContain(
      'cannot have a "loop"',
    );
  });

  test("abort is the default policy — omitting onTimeout is valid", () => {
    // An approval that silently became `approve` because nobody looked at
    // it is a consent bypass, so the safe policy must be the one you get
    // by not thinking about it.
    expect(validateWorkflow(approval({ timeoutMs: 5000 }))).toEqual([]);
  });
});
