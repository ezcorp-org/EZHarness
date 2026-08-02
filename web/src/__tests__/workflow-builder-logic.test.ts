import { test, expect, describe } from "bun:test";
import {
  acceptsInputMapping,
  acceptsLoop,
  acceptsRetries,
  blankStep,
  buildWorkflowPayload,
  duplicateName,
  pairsToRecord,
  parseJsonField,
  pruneDependsOn,
  remapDependsOn,
  stepToPayload,
  workflowToDrafts,
  type StepDraft,
  type StoredStep,
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

// ---------------------------------------------------------------------------
// Editing an existing workflow: the stored -> draft direction, the `tool`
// step kind, and the kind predicates the step form renders by.
// ---------------------------------------------------------------------------

describe("kind predicates", () => {
  test("agent and tool accept an input mapping; transform and gate do not", () => {
    expect(acceptsInputMapping("agent")).toBe(true);
    expect(acceptsInputMapping("tool")).toBe(true);
    expect(acceptsInputMapping("transform")).toBe(false);
    expect(acceptsInputMapping("gate")).toBe(false);
  });

  test("only agent and transform may loop", () => {
    expect(acceptsLoop("agent")).toBe(true);
    expect(acceptsLoop("transform")).toBe(true);
    // A gate is a pure assertion and a tool step would repeat a
    // side-effecting call with no LLM in between — both rejected server-side.
    expect(acceptsLoop("gate")).toBe(false);
    expect(acceptsLoop("tool")).toBe(false);
  });

  test("only an agent step retries", () => {
    expect(acceptsRetries("agent")).toBe(true);
    expect(acceptsRetries("tool")).toBe(false);
    expect(acceptsRetries("transform")).toBe(false);
    expect(acceptsRetries("gate")).toBe(false);
  });
});

describe("stepToPayload — tool steps", () => {
  test("emits `tool` and `kind`, never `agent`", () => {
    const payload = stepToPayload({
      ...blankStep(0),
      kind: "tool",
      tool: "extension-author__create_extension",
    });
    expect(payload).toEqual({
      name: "step-1",
      kind: "tool",
      tool: "extension-author__create_extension",
    });
    expect(payload.agent).toBeUndefined();
  });

  test("carries an input mapping — tool steps use the same ref grammar", () => {
    const payload = stepToPayload({
      ...blankStep(0),
      kind: "tool",
      tool: "ext__do",
      inputPairs: [{ key: "draftId", value: "$prev.output.id" }],
    });
    expect(payload.input).toEqual({ draftId: "$prev.output.id" });
  });

  test("drops loop and retries — the executor reads neither on a tool step", () => {
    const payload = stepToPayload({
      ...blankStep(0),
      kind: "tool",
      tool: "ext__do",
      loopEnabled: true,
      maxIterations: 4,
      retries: 2,
    });
    expect(payload.loop).toBeUndefined();
    expect(payload.retries).toBeUndefined();
  });
});

describe("buildWorkflowPayload — tool steps", () => {
  test("rejects a tool step with no tool selected", () => {
    expect(
      buildWorkflowPayload("wf", "", [{ ...blankStep(0), kind: "tool", tool: "" } as StepDraft])
        .error,
    ).toBe('Step "step-1" (tool) needs a tool');
  });

  test("accepts a tool step once a tool is selected", () => {
    const res = buildWorkflowPayload("wf", "", [
      { ...blankStep(0), kind: "tool", tool: "ext__do" } as StepDraft,
    ]);
    expect(res.error).toBeNull();
  });
});

describe("workflowToDrafts", () => {
  test("returns a single blank draft for an absent or empty step list", () => {
    // The create form opens on one empty step; an edit of a (impossible)
    // stepless workflow must not render zero rows with no way to add one.
    expect(workflowToDrafts(undefined)).toEqual([blankStep(0)]);
    expect(workflowToDrafts([])).toEqual([blankStep(0)]);
  });

  test("inflates an agent step, expanding the input record into pairs", () => {
    const [draft] = workflowToDrafts([
      { name: "fetch", agent: "summarizer", input: { q: "$input.query" }, retries: 2 },
    ]);
    expect(draft.kind).toBe("agent");
    expect(draft.agent).toBe("summarizer");
    expect(draft.inputPairs).toEqual([{ key: "q", value: "$input.query" }]);
    expect(draft.retries).toBe(2);
    expect(draft.loopEnabled).toBe(false);
  });

  test("inflates a tool step", () => {
    const [draft] = workflowToDrafts([
      { name: "publish", kind: "tool", tool: "ext__publish", input: { id: "$prev.output.id" } },
    ]);
    expect(draft.kind).toBe("tool");
    expect(draft.tool).toBe("ext__publish");
    expect(draft.inputPairs).toEqual([{ key: "id", value: "$prev.output.id" }]);
  });

  test("inflates a transform step's output mapping", () => {
    const [draft] = workflowToDrafts([
      { name: "compose", kind: "transform", output: { headline: "Report on {{$input.topic}}" } },
    ]);
    expect(draft.kind).toBe("transform");
    expect(draft.outputPairs).toEqual([
      { key: "headline", value: "Report on {{$input.topic}}" },
    ]);
  });

  test("renders a gate condition back into indented JSON text", () => {
    const condition = { ref: "$steps.compose.output.headline", op: "contains", value: "Report" };
    const [draft] = workflowToDrafts([{ name: "assert", kind: "gate", condition }]);
    expect(draft.kind).toBe("gate");
    // Must parse back to the same tree — this text is what the user edits.
    expect(JSON.parse(draft.conditionText)).toEqual(condition);
    expect(draft.conditionText).toContain("\n");
  });

  test("unpacks a loop, including its until-condition and exhaustion policy", () => {
    const until = { ref: "$result.output.n", op: "gte", value: 3 };
    const [draft] = workflowToDrafts([
      { name: "count", kind: "transform", output: { n: "$loop.iteration" },
        loop: { maxIterations: 5, until, onExhausted: "pass" } },
    ]);
    expect(draft.loopEnabled).toBe(true);
    expect(draft.maxIterations).toBe(5);
    expect(draft.onExhausted).toBe("pass");
    expect(JSON.parse(draft.untilText)).toEqual(until);
  });

  test("defaults a loop's optional fields rather than emitting undefined", () => {
    const [draft] = workflowToDrafts([
      { name: "s", agent: "a", loop: { maxIterations: 2 } },
    ]);
    expect(draft.onExhausted).toBe("fail");
    expect(draft.untilText).toBe("");
  });

  test("defaults an absent or unrecognized kind to agent", () => {
    // `kind` is optional in the schema; an unknown value must still render
    // as SOMETHING editable rather than a form bound to no branch.
    expect(workflowToDrafts([{ name: "s", agent: "a" }])[0].kind).toBe("agent");
    expect(workflowToDrafts([{ name: "s", kind: "bogus" }])[0].kind).toBe("agent");
  });

  test("names an unnamed step by position and copies dependsOn defensively", () => {
    const dependsOn = ["first"];
    const drafts = workflowToDrafts([{ agent: "a" }, { name: "second", dependsOn }]);
    expect(drafts[0].name).toBe("step-1");
    expect(drafts[1].dependsOn).toEqual(["first"]);
    // A shared array would let a dependsOn edit in the form mutate the
    // store's copy of the workflow.
    expect(drafts[1].dependsOn).not.toBe(dependsOn);
  });
});

describe("workflowToDrafts / stepToPayload round-trip", () => {
  // The pair must stay lossless in the fields that carry meaning: opening
  // the editor and pressing Save unchanged must not rewrite the definition.
  const steps: StoredStep[] = [
    { name: "compose", kind: "transform", output: { headline: "Report on {{$input.topic}}" } },
    { name: "assert", kind: "gate", dependsOn: ["compose"],
      condition: { ref: "$steps.compose.output.headline", op: "contains", value: "Report on" } },
    { name: "call", kind: "tool", tool: "ext__publish", dependsOn: ["assert"],
      input: { headline: "$steps.compose.output.headline" } },
    { name: "summarize", agent: "summarizer", dependsOn: ["call"], retries: 1,
      input: { text: "$prev.output" } },
    { name: "count", kind: "transform", output: { n: "$loop.iteration" },
      loop: { maxIterations: 5, until: { ref: "$result.output.n", op: "gte", value: 3 },
        onExhausted: "pass" } },
  ];

  test("re-emits every step unchanged", () => {
    // Cast only to reconcile the declared shapes: `stepToPayload` returns an
    // open record while `StoredStep` is a closed interface.
    expect(workflowToDrafts(steps).map(stepToPayload)).toEqual(
      steps as unknown as Record<string, unknown>[],
    );
  });

  test("is idempotent, so repeated open-and-save cannot drift", () => {
    // Stated separately because normalization IS allowed on the first pass
    // (an omitted `onExhausted` becomes the explicit `"fail"` default, an
    // explicit `kind: "agent"` is dropped) — what must not happen is a
    // definition that keeps changing every time it is saved.
    const once = workflowToDrafts([
      { name: "s", kind: "agent", agent: "a", loop: { maxIterations: 2 } },
    ]).map(stepToPayload);
    const twice = workflowToDrafts(once).map(stepToPayload);
    expect(twice).toEqual(once);
  });
});

describe("duplicateName", () => {
  test("suffixes -copy", () => {
    expect(duplicateName("demo-mixed")).toBe("demo-mixed-copy");
  });

  test("strips an extension namespace", () => {
    // Keeping it would create a DB row squatting on the extension's
    // namespace — and extension assets win the merged cache, so the copy
    // would be permanently shadowed and never resolve.
    expect(duplicateName("extension-author:scaffold")).toBe("scaffold-copy");
  });
});
