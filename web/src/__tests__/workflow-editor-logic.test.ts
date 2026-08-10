import { test, expect, describe } from "bun:test";
import {
  blankStep,
  buildWorkflowPayload,
  defaultModelToText,
  definitionToDrafts,
  stepToPayload,
  type StepDraft,
} from "$lib/workflow-builder-logic";
import { definitionFields, parseWorkflowYaml, workflowToYaml } from "$lib/workflow-yaml";

// ---------------------------------------------------------------------------
// The editor's pure logic. The load-bearing property here is the ROUND
// TRIP: the builder previously only ever CREATED workflows, so modelling
// three step kinds and ignoring model bindings cost nothing. The editor
// LOADS, and a form that silently dropped what it could not represent
// would delete a user's tool steps and model bindings on the next save —
// with no error anywhere.
// ---------------------------------------------------------------------------

describe("definitionToDrafts ⇄ stepToPayload round-trip", () => {
  const cases: Array<{ label: string; step: Record<string, unknown> }> = [
    { label: "a bare agent step", step: { name: "draft", agent: "writer" } },
    {
      label: "an agent step with input, retries and a model override",
      step: {
        name: "draft",
        agent: "writer",
        input: { topic: "$input.topic" },
        retries: 2,
        model: { provider: "anthropic", model: "claude-opus-5" },
      },
    },
    {
      label: "a tool step",
      step: {
        name: "publish",
        kind: "tool",
        tool: "ext__write_file",
        input: { path: "$prev.output" },
      },
    },
    {
      label: "a transform step",
      step: { name: "sum", kind: "transform", output: { n: "$input.n" } },
    },
    {
      label: "a gate step",
      step: { name: "check", kind: "gate", condition: { ref: "$prev.output.ok", op: "truthy" } },
    },
    {
      label: "a looped agent step",
      step: {
        name: "refine",
        kind: undefined,
        agent: "writer",
        loop: {
          maxIterations: 5,
          onExhausted: "pass",
          until: { ref: "$result.output.ok", op: "truthy" },
        },
      },
    },
    {
      label: "a step with dependsOn",
      step: { name: "last", agent: "writer", dependsOn: ["a", "b"] },
    },
  ];

  for (const { label, step } of cases) {
    test(`${label} survives load-then-save unchanged`, () => {
      // Strip explicitly-undefined members — the API shape never carries them.
      const original = Object.fromEntries(Object.entries(step).filter(([, v]) => v !== undefined));
      const [draft] = definitionToDrafts([original]);
      expect(stepToPayload(draft!)).toEqual(original);
    });
  }

  test("a tool step is not silently deleted by an editor round-trip", () => {
    // The specific data-loss bug the `tool` draft field exists to prevent.
    const steps = [
      { name: "draft", agent: "writer" },
      { name: "publish", kind: "tool", tool: "ext__write_file" },
    ];
    const drafts = definitionToDrafts(steps);
    expect(drafts.map((d) => d.kind)).toEqual(["agent", "tool"]);
    expect(drafts.map(stepToPayload)).toEqual(steps);
  });

  test("a per-step model binding is not silently deleted either", () => {
    const steps = [{ name: "draft", agent: "writer", model: { model: "claude-opus-5" } }];
    expect(definitionToDrafts(steps).map(stepToPayload)).toEqual(steps);
  });

  test("a whole workflow round-trips through buildWorkflowPayload", () => {
    const definition = {
      name: "ship",
      description: "does a thing",
      defaultModel: { provider: "anthropic", model: "claude-sonnet-5" },
      steps: [
        { name: "draft", agent: "writer", input: { topic: "$input.topic" } },
        { name: "publish", kind: "tool", tool: "ext__write" },
        { name: "sum", kind: "transform", output: { url: "$prev.output" } },
      ],
    };
    const result = buildWorkflowPayload(
      definition.name,
      definition.description,
      definitionToDrafts(definition.steps),
      defaultModelToText(definition.defaultModel),
    );
    expect(result.error).toBeNull();
    expect((result as { payload: Record<string, unknown> }).payload).toEqual(definition);
  });
});

describe("definitionToDrafts tolerates malformed input", () => {
  test("a non-array yields no drafts", () => {
    expect(definitionToDrafts(undefined)).toEqual([]);
    expect(definitionToDrafts(null)).toEqual([]);
    expect(definitionToDrafts("steps")).toEqual([]);
  });

  test("a nameless step gets a positional placeholder rather than an empty name", () => {
    expect(definitionToDrafts([{}, {}]).map((d) => d.name)).toEqual(["step-1", "step-2"]);
  });

  test("a null step entry does not throw", () => {
    expect(definitionToDrafts([null])[0]!.kind).toBe("agent");
  });

  test("non-string mapping values are stringified, never dropped", () => {
    const [draft] = definitionToDrafts([{ name: "s", agent: "a", input: { n: 42 } }]);
    expect(draft!.inputPairs).toEqual([{ key: "n", value: "42" }]);
  });

  test("a non-object input mapping yields no pairs", () => {
    const [draft] = definitionToDrafts([{ name: "s", agent: "a", input: "nope" }]);
    expect(draft!.inputPairs).toEqual([]);
  });

  test("a loop with no maxIterations falls back to the blank default", () => {
    const [draft] = definitionToDrafts([{ name: "s", agent: "a", loop: {} }]);
    expect(draft!.loopEnabled).toBe(true);
    expect(draft!.maxIterations).toBe(3);
    expect(draft!.onExhausted).toBe("fail");
  });

  test("dependsOn that is not an array becomes empty", () => {
    expect(definitionToDrafts([{ name: "s", agent: "a", dependsOn: "b" }])[0]!.dependsOn).toEqual(
      [],
    );
  });
});

describe("editor validation mirrors the server", () => {
  test("a tool step with no tool is rejected before POST", () => {
    const draft: StepDraft = { ...blankStep(0), kind: "tool", tool: "" };
    expect(buildWorkflowPayload("w", "", [draft])).toEqual({
      error: 'Step "step-1" (tool) needs a tool',
    });
  });

  test("a malformed per-step model binding is reported, not silently dropped", () => {
    const draft: StepDraft = { ...blankStep(0), agent: "a", modelText: "{ not json" };
    expect(buildWorkflowPayload("w", "", [draft])).toEqual({
      error: 'Step "step-1": model binding is not valid JSON',
    });
  });

  test("a malformed workflow default model is reported", () => {
    const draft: StepDraft = { ...blankStep(0), agent: "a" };
    expect(buildWorkflowPayload("w", "", [draft], "{ nope")).toEqual({
      error: "Workflow default model is not valid JSON",
    });
  });

  test("an empty default model is simply absent from the payload", () => {
    const draft: StepDraft = { ...blankStep(0), agent: "a" };
    const result = buildWorkflowPayload("w", "", [draft], "   ");
    expect(result.error).toBeNull();
    expect((result as { payload: Record<string, unknown> }).payload).not.toHaveProperty(
      "defaultModel",
    );
  });
});

describe("defaultModelToText", () => {
  test("absent bindings render as empty, never the literal null", () => {
    expect(defaultModelToText(undefined)).toBe("");
    expect(defaultModelToText(null)).toBe("");
  });

  test("a binding renders as indented JSON", () => {
    expect(defaultModelToText({ model: "m" })).toBe('{\n  "model": "m"\n}');
  });
});

describe("the YAML tab", () => {
  test("parses a mapping into a definition", () => {
    const result = parseWorkflowYaml(
      "name: ship\ndescription: d\nsteps:\n  - name: s\n    agent: a\n",
    );
    expect(result).toEqual({
      ok: true,
      value: { name: "ship", description: "d", steps: [{ name: "s", agent: "a" }] },
    });
  });

  test("an empty document is rejected with a message about emptiness", () => {
    expect(parseWorkflowYaml("   ")).toEqual({ ok: false, error: "Definition is empty" });
  });

  test("a list or scalar is rejected here rather than confusing the validator", () => {
    // `validateWorkflow` would report "Workflow must have a non-empty
    // name" for a list, which tells the user nothing about the real problem.
    expect(parseWorkflowYaml("- a\n- b")).toEqual({
      ok: false,
      error: "Definition must be a YAML mapping (name, description, steps)",
    });
    expect(parseWorkflowYaml("just a string").ok).toBe(false);
  });

  test("a syntax error surfaces the parser's own message", () => {
    const result = parseWorkflowYaml("name: [unclosed\n");
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error.length).toBeGreaterThan(0);
  });

  test("workflowToYaml emits a human key order and drops absent members", () => {
    const yaml = workflowToYaml({
      steps: [{ name: "s" }],
      name: "ship",
      description: "d",
      inputSchema: null,
      defaultModel: undefined,
    });
    expect(yaml.indexOf("name:")).toBeLessThan(yaml.indexOf("steps:"));
    expect(yaml).not.toContain("inputSchema");
    expect(yaml).not.toContain("defaultModel");
  });

  test("a definition survives the YAML round-trip", () => {
    const definition = {
      name: "ship",
      description: "d",
      defaultModel: { model: "m" },
      steps: [{ name: "s", agent: "a", input: { x: "$input.x" } }],
    };
    const parsed = parseWorkflowYaml(workflowToYaml(definition));
    expect(parsed).toEqual({ ok: true, value: definition });
  });

  test("definitionFields strips the provenance the strict PUT body would reject", () => {
    // The single-workflow GET returns definition + provenance, and the PUT
    // schema is `.strict()` — echoing the whole object back would 400.
    expect(
      definitionFields({
        name: "ship",
        description: "d",
        steps: [],
        source: "db",
        visibility: "project",
        canEdit: true,
        projectId: null,
        forkedFrom: null,
      }),
    ).toEqual({ name: "ship", description: "d", steps: [] });
  });
});
