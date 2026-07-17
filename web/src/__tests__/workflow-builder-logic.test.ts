import { test, expect, describe } from "bun:test";
import {
  blankStep,
  pairsToRecord,
  parseJsonField,
  stepToPayload,
  buildWorkflowPayload,
  remapDependsOn,
  pruneDependsOn,
  type StepDraft,
} from "$lib/workflow-builder-logic";

// ---------------------------------------------------------------------------
// Pure-logic coverage for WorkflowBuilder.svelte / WorkflowStepForm.svelte.
// The `.svelte` components are thin bindings over these framework-free
// functions; exercising every branch here keeps them at 100%.
// ---------------------------------------------------------------------------

function agentStep(over: Partial<StepDraft> = {}): StepDraft {
  return { ...blankStep(0), agent: "summarizer", ...over };
}

describe("blankStep", () => {
  test("auto-numbers the step and defaults to an agent kind", () => {
    expect(blankStep(0).name).toBe("step-1");
    expect(blankStep(4).name).toBe("step-5");
    const s = blankStep(0);
    expect(s.kind).toBe("agent");
    expect(s.loopEnabled).toBe(false);
    expect(s.onExhausted).toBe("fail");
  });
});

describe("pairsToRecord", () => {
  test("trims keys, drops blank keys, last duplicate wins", () => {
    expect(
      pairsToRecord([
        { key: " a ", value: "1" },
        { key: "", value: "ignored" },
        { key: "a", value: "2" },
        { key: "b", value: "3" },
      ]),
    ).toEqual({ a: "2", b: "3" });
  });
});

describe("parseJsonField", () => {
  test("empty → undefined; valid → parsed; invalid → error", () => {
    expect(parseJsonField("  ")).toEqual({ ok: true, value: undefined });
    expect(parseJsonField('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonField("{not json")).toEqual({ ok: false, error: "Invalid JSON" });
  });
});

describe("stepToPayload — agent", () => {
  test("emits agent, input (when non-empty) and retries (when no loop)", () => {
    const out = stepToPayload(
      agentStep({
        inputPairs: [{ key: "q", value: "$input.q" }],
        retries: 2,
      }),
    );
    expect(out).toEqual({
      name: "step-1",
      agent: "summarizer",
      input: { q: "$input.q" },
      retries: 2,
    });
    expect(out.kind).toBeUndefined(); // agent kind is implicit
  });

  test("omits input when empty and retries when a loop is enabled", () => {
    const out = stepToPayload(
      agentStep({ retries: 2, loopEnabled: true, maxIterations: 4 }),
    );
    expect(out.input).toBeUndefined();
    expect(out.retries).toBeUndefined();
    expect(out.loop).toEqual({ maxIterations: 4, onExhausted: "fail" });
  });
});

describe("stepToPayload — transform", () => {
  test("emits kind + output mapping and never input (executor ignores it)", () => {
    const out = stepToPayload({
      ...blankStep(0),
      kind: "transform",
      outputPairs: [{ key: "n", value: "$loop.iteration" }],
      // Stale drafts can carry inputPairs (e.g. the kind was switched from
      // agent) — they must not leak into the payload as dead weight.
      inputPairs: [{ key: "seed", value: "$input.seed" }],
    } as StepDraft);
    expect(out).toMatchObject({
      kind: "transform",
      output: { n: "$loop.iteration" },
    });
    expect(out.input).toBeUndefined();
  });
});

describe("stepToPayload — gate", () => {
  test("parses the condition JSON", () => {
    const out = stepToPayload({
      ...blankStep(0),
      kind: "gate",
      conditionText: '{"ref":"$input.n","op":"exists"}',
    } as StepDraft);
    expect(out.condition).toEqual({ ref: "$input.n", op: "exists" });
    expect(out.kind).toBe("gate");
  });

  test("throws a descriptive string on malformed condition JSON", () => {
    expect(() =>
      stepToPayload({ ...blankStep(0), kind: "gate", conditionText: "{bad" } as StepDraft),
    ).toThrow('Step "step-1": condition is not valid JSON');
  });
});

describe("stepToPayload — dependsOn + loop until", () => {
  test("emits dependsOn and a loop with a valid until-condition", () => {
    const out = stepToPayload(
      agentStep({
        dependsOn: ["prep"],
        loopEnabled: true,
        maxIterations: 5,
        untilText: '{"ref":"$result.output.n","op":"gte","value":3}',
      }),
    );
    expect(out.dependsOn).toEqual(["prep"]);
    expect(out.loop).toEqual({
      maxIterations: 5,
      onExhausted: "fail",
      until: { ref: "$result.output.n", op: "gte", value: 3 },
    });
  });

  test("throws on a malformed loop until-condition", () => {
    expect(() =>
      stepToPayload(agentStep({ loopEnabled: true, untilText: "{bad" })),
    ).toThrow('Step "step-1": loop until-condition is not valid JSON');
  });
});

describe("remapDependsOn / pruneDependsOn", () => {
  test("rename retargets every sibling dependsOn entry from old to new name", () => {
    const steps = [
      agentStep({ name: "first" }),
      agentStep({ name: "second", dependsOn: ["first"] }),
      agentStep({ name: "third", dependsOn: ["first", "second"] }),
    ];
    remapDependsOn(steps, "first", "fetch");
    expect(steps[1]!.dependsOn).toEqual(["fetch"]);
    expect(steps[2]!.dependsOn).toEqual(["fetch", "second"]);
  });

  test("a no-op rename (same name) leaves dependsOn untouched", () => {
    const steps = [agentStep({ name: "a" }), agentStep({ name: "b", dependsOn: ["a"] })];
    const before = steps[1]!.dependsOn;
    remapDependsOn(steps, "a", "a");
    expect(steps[1]!.dependsOn).toBe(before);
  });

  test("removal prunes the removed name from every remaining sibling", () => {
    const steps = [
      agentStep({ name: "keep", dependsOn: ["gone"] }),
      agentStep({ name: "also", dependsOn: ["gone", "keep"] }),
    ];
    pruneDependsOn(steps, "gone");
    expect(steps[0]!.dependsOn).toEqual([]);
    expect(steps[1]!.dependsOn).toEqual(["keep"]);
  });
});

describe("buildWorkflowPayload — validation", () => {
  test("rejects an empty name and an empty step list", () => {
    expect(buildWorkflowPayload("", "", [agentStep()])).toEqual({
      error: "Workflow name is required",
    });
    expect(buildWorkflowPayload("wf", "", [])).toEqual({
      error: "At least one step is required",
    });
  });

  test("rejects blank step name, duplicates and per-kind gaps", () => {
    expect(buildWorkflowPayload("wf", "", [agentStep({ name: "  " })]).error).toBe(
      "Each step needs a name",
    );
    expect(
      buildWorkflowPayload("wf", "", [agentStep({ name: "dup" }), agentStep({ name: "dup" })]).error,
    ).toBe('Duplicate step name "dup"');
    expect(buildWorkflowPayload("wf", "", [agentStep({ agent: "" })]).error).toBe(
      'Step "step-1" (agent) needs an agent',
    );
    expect(
      buildWorkflowPayload("wf", "", [{ ...blankStep(0), kind: "transform" } as StepDraft]).error,
    ).toBe('Step "step-1" (transform) needs an output mapping');
    expect(
      buildWorkflowPayload("wf", "", [{ ...blankStep(0), kind: "gate", conditionText: "" } as StepDraft])
        .error,
    ).toBe('Step "step-1" (gate) needs a condition');
  });

  test("surfaces a stepToPayload error (malformed gate JSON) as the payload error", () => {
    const res = buildWorkflowPayload("wf", "", [
      { ...blankStep(0), kind: "gate", conditionText: "{bad" } as StepDraft,
    ]);
    expect(res.error).toBe('Step "step-1": condition is not valid JSON');
  });

  test("builds a trimmed, well-formed payload for a valid workflow", () => {
    const res = buildWorkflowPayload("  My Flow  ", "  a demo  ", [
      agentStep({ name: "fetch" }),
      { ...blankStep(1), kind: "transform", outputPairs: [{ key: "n", value: "1" }] } as StepDraft,
    ]);
    expect(res.error).toBeNull();
    expect((res as { payload: Record<string, unknown> }).payload).toEqual({
      name: "My Flow",
      description: "a demo",
      steps: [
        { name: "fetch", agent: "summarizer" },
        { name: "step-2", kind: "transform", output: { n: "1" } },
      ],
    });
  });
});
