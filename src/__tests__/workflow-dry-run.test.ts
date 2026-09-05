import { describe, expect, test } from "bun:test";
import {
  containsDryRunStub,
  DRY_RUN_STUB_MARKER,
  DRY_RUN_UNVERIFIED,
  dryRunAgentExecutor,
  dryRunStatus,
  dryRunStub,
  dryRunToolRunnerFactory,
  dryRunWorkflow,
  isDryRunStub,
  isPureDryRunKind,
  renderStubs,
  WorkflowDryRunViolation,
} from "../runtime/workflow-dry-run";
import type { WorkflowDefinition } from "../types";
import { WorkflowExecutor } from "../runtime/workflow-executor";
import { EventBus } from "../runtime/events";
import { registerWorkflowRuntime, _resetWorkflowRuntimeForTests } from "../runtime/workflow/runtime-registry";

const toolBearing: WorkflowDefinition = {
  name: "ship",
  description: "agent + tool + transform + gate",
  steps: [
    { name: "draft", kind: "agent", agent: "writer", input: { topic: "$input.topic" } },
    { name: "publish", kind: "tool", tool: "ext__write_file", input: { body: "$steps.draft.output.text" } },
    { name: "summary", kind: "transform", output: { url: "$steps.publish.output.url", topic: "$input.topic" } },
  ],
};

describe("dry run cannot dispatch, structurally", () => {
  test("YAML transform expressions remain data and cannot evaluate host JavaScript", async () => {
    const key = `EZ_DRY_RUN_${crypto.randomUUID().replaceAll("-", "")}`;
    const expression = `process.env.${key} = 'executed'`;
    const definition = Bun.YAML.parse(`name: unapproved:expression\nsteps:\n  - name: render\n    kind: transform\n    output:\n      code: ${JSON.stringify(expression)}\n      template: ${JSON.stringify(`{{ ${expression} }}`)}\n`) as WorkflowDefinition;
    try {
      const report = await dryRunWorkflow(definition, {});
      expect(report.status).toBe("success");
      expect(report.output).toEqual({ code: expression, template: expression });
      expect(process.env[key]).toBeUndefined();
    } finally { delete process.env[key]; }
  });

  test("a nested step cannot fall back to the live runtime even with an unsafe predicate", async () => {
    let dispatches = 0;
    const nested: WorkflowDefinition = { name: "unapproved:parent", description: "", steps: [{ name: "child", kind: "workflow", workflow: "live-child" }] };
    registerWorkflowRuntime({
      getWorkflows: () => [{ name: "live-child", description: "", steps: [] }],
      workflowExecutor: { runWorkflow: async () => { dispatches++; throw new Error("Must not dispatch"); }, resumeWorkflow: async () => { dispatches++; throw new Error("Must not resume"); } },
    });
    try {
      expect((await dryRunWorkflow(nested, {})).stubbed).toEqual(["child"]);
      const forced = await dryRunWorkflow(nested, {}, () => true);
      expect(forced.status).toBe("error");
      expect(forced.error).toContain("could not resolve workflow");
      expect(dispatches).toBe(0);
    } finally { _resetWorkflowRuntimeForTests(); }
  });

  test("namespaced pure evaluation cannot grant real execution or dispatch through its predicate", async () => {
    const definition = { ...toolBearing, name: "unapproved:ship" };
    expect((await dryRunWorkflow(definition, { topic: "release" })).stubbed).toEqual(["draft", "publish"]);
    await expect(dryRunWorkflow(definition, {}, () => true)).rejects.toThrow(WorkflowDryRunViolation);
    const executor = new WorkflowExecutor(dryRunAgentExecutor(), new EventBus(), { persist: false, toolRunnerFactory: () => dryRunToolRunnerFactory() });
    await expect(executor.runWorkflow(definition, {})).rejects.toThrow("release authority");
  });

  test("a tool-bearing graph dry-runs to completion with stubs", async () => {
    // Also the merge tripwire for `stepSubstitute`. If that option is ever
    // lost from the executor, the agent and tool steps here DISPATCH, the
    // guarantees fire, and this call now throws a WorkflowDryRunViolation
    // naming the dispatch it attempted — rather than quietly returning a
    // report with an error string in it, which is how the same loss used
    // to read.
    const report = await dryRunWorkflow(toolBearing, { topic: "release notes" });

    expect(report.status).toBe("success");
    expect(report.error).toBeUndefined();
    expect(report.stubbed).toEqual(["draft", "publish"]);
    expect(report.steps.map((s) => s.mode)).toEqual(["stubbed", "stubbed", "evaluated"]);
    // No gate in this graph, so nothing was left unenforced — the plain
    // `success` above is honest here, and only here.
    expect(report.gatesOnStubs).toEqual([]);
  });

  test("a violation ESCAPES the harness rather than being reported as a workflow failure", async () => {
    // Reached by simulating the ONE condition the violation exists for:
    // the allow list and the executor's dispatch have diverged, so a step
    // that must be substituted is claimed pure and dispatched. A correct
    // harness substitutes every impure kind, which is why this needs the
    // injected list — and why the propagation claim in the module doc was
    // false for as long as nobody could exercise it: the per-step catch
    // turned the violation into `status: "error"` with a message, which is
    // what an ordinary failed gate looks like.
    const agentReaches = dryRunWorkflow(toolBearing, { topic: "x" }, () => true);
    await expect(agentReaches).rejects.toBeInstanceOf(WorkflowDryRunViolation);
    await expect(agentReaches).rejects.toThrow(/real agent invocation/);
  });

  test("a tool step that reaches dispatch escapes as a violation, not a step failure", async () => {
    // The tool path launders harder: `runToolStep` catches whatever its
    // dispatch raised and re-throws `Step "<name>" failed: …`, so the
    // original type is gone by the time the run ends. Recording at the
    // throw site is what survives that.
    const toolOnly = {
      name: "publish-only",
      description: "",
      steps: [{ name: "publish", kind: "tool" as const, tool: "ext__write_file" }],
    };
    await expect(dryRunWorkflow(toolOnly, {}, () => true)).rejects.toThrow(/real tool dispatch/);
  });

  test("the tool runner factory throws, so a tool step reaching dispatch fails loudly", () => {
    // The backstop itself — the ACTUAL factory `dryRunWorkflow` wires in,
    // called directly. A dry run never reaches it (the executor builds the
    // runner lazily and only for a graph with a tool step), which is why
    // proving it throws needs a direct call: it is what makes "no tool
    // ran" a property of the object graph rather than of the substitution
    // predicate happening to be right.
    expect(() => dryRunToolRunnerFactory()).toThrow(WorkflowDryRunViolation);
    expect(() => dryRunToolRunnerFactory()).toThrow(/must never dispatch/);
  });

  test("runAgent on the dry-run executor throws rather than calling an LLM", () => {
    const executor = dryRunAgentExecutor();
    expect(() => executor.runAgent("writer", {})).toThrow(WorkflowDryRunViolation);
  });

  test("cancelRun on the dry-run executor is a no-op — nothing is ever in flight", () => {
    const executor = dryRunAgentExecutor();
    expect(() => executor.cancelRun("run-1")).not.toThrow();
  });

  test("a transform reading real input is evaluated for real, not stubbed", async () => {
    const report = await dryRunWorkflow(
      {
        name: "pure",
        description: "",
        steps: [{ name: "echo", kind: "transform", output: { topic: "$input.topic" } }],
      },
      { topic: "hello" },
    );

    expect(report.stubbed).toEqual([]);
    expect(report.output).toEqual({ topic: "hello" });
  });

  test("the substitution predicate is an ALLOW list — an unknown kind is stubbed, never dispatched", () => {
    // The C7 guard: when a `workflow` step kind lands, it must be
    // substituted by default. A deny list would dispatch it.
    expect(isPureDryRunKind("transform")).toBe(true);
    expect(isPureDryRunKind("gate")).toBe(true);
    expect(isPureDryRunKind("agent")).toBe(false);
    expect(isPureDryRunKind("tool")).toBe(false);
    expect(isPureDryRunKind("workflow" as never)).toBe(false);
  });

  test("a looped agent step is substituted too — the hook sits above the loop branch", async () => {
    const report = await dryRunWorkflow(
      {
        name: "looped",
        description: "",
        steps: [
          {
            name: "refine",
            kind: "agent",
            agent: "writer",
            loop: { maxIterations: 5, until: { ref: "$result.output.done", op: "truthy" } },
          },
        ],
      },
      {},
    );

    expect(report.status).toBe("success");
    expect(report.stubbed).toEqual(["refine"]);
  });
});

describe("dry-run stubs resolve arbitrary ref paths", () => {
  test("a downstream ref into a stubbed step resolves instead of throwing", async () => {
    // The strict resolver (`workflow-refs.ts`) throws on a missing field.
    // Without a path-answering stub every real graph would die at its
    // first `$steps.<agent>.output.<field>` reference.
    const report = await dryRunWorkflow(
      {
        name: "deep",
        description: "",
        steps: [
          { name: "draft", kind: "agent", agent: "writer" },
          { name: "use", kind: "transform", output: { title: "$steps.draft.output.meta.title" } },
        ],
      },
      {},
    );

    expect(report.status).toBe("success");
    expect(report.output).toEqual({ title: "«draft.output.meta.title»" });
  });

  test("a stub interpolates into a template as its label (quoted), not [object Object]", async () => {
    const report = await dryRunWorkflow(
      {
        name: "tpl",
        description: "",
        steps: [
          { name: "draft", kind: "agent", agent: "writer" },
          { name: "msg", kind: "transform", output: { line: "got {{$steps.draft.output.text}}" } },
        ],
      },
      {},
    );

    // Quoted because `interpolateTemplate` routes objects through
    // `JSON.stringify`, and the stub must stay typeof "object" or
    // `getNestedValue` would refuse to walk it at all. Cosmetic, and it
    // still names the unrun step the value came from.
    expect(report.output).toEqual({ line: 'got "«draft.output.text»"' });
  });

  test("a stub reports every property as present and answers each with a stub", () => {
    const stub = dryRunStub("s");
    expect(Object.hasOwn(stub, "anything")).toBe(true);
    expect(isDryRunStub(stub.anything)).toBe(true);
    expect(String((stub.a as Record<string, Record<string, unknown>>).b.c)).toBe("«s.a.b.c»");
  });

  test("a stub serializes without recursing forever", () => {
    expect(JSON.stringify(dryRunStub("s"))).toBe('"«s»"');
  });

  test("symbol access on a stub yields undefined, so it is not mistaken for a thenable", () => {
    const stub = dryRunStub("s") as unknown as Record<symbol, unknown>;
    expect(stub[Symbol.iterator]).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(stub, Symbol.iterator)).toBeUndefined();
  });

  test("isDryRunStub rejects ordinary values", () => {
    expect(isDryRunStub(null)).toBe(false);
    expect(isDryRunStub("text")).toBe(false);
    expect(isDryRunStub({ [DRY_RUN_STUB_MARKER]: false })).toBe(false);
  });

  test("renderStubs replaces stubs anywhere in the tree and leaves real data alone", () => {
    expect(renderStubs({ a: dryRunStub("x"), b: [1, dryRunStub("y")], c: "kept", d: null })).toEqual({
      a: "«x»",
      b: [1, "«y»"],
      c: "kept",
      d: null,
    });
  });
});

describe("a gate over fabricated operands is recorded, never enforced", () => {
  const gatedOnStub = (op: "eq" | "truthy") => ({
    name: "gated",
    description: "",
    steps: [
      { name: "draft", kind: "agent" as const, agent: "writer" },
      {
        name: "check",
        kind: "gate" as const,
        condition:
          op === "eq"
            ? { ref: "$steps.draft.output.status", op: "eq" as const, value: "ok" }
            : { ref: "$steps.draft.output.ok", op: "truthy" as const },
      },
      { name: "after", kind: "transform" as const, output: { done: "yes" } },
    ],
  });

  test("a gate a stub SATISFIES never reports a bare success — the status is unverified", async () => {
    // The critical half of the defect: the stub answers every path, so
    // `truthy` holds against a Proxy and the run went green on data
    // nobody produced. `success` here is indistinguishable, to a user and
    // to a script, from a graph that really passed.
    const report = await dryRunWorkflow(gatedOnStub("truthy"), {});

    expect(report.status).toBe(DRY_RUN_UNVERIFIED);
    expect(report.status).not.toBe("success");
    expect(report.gatesOnStubs).toEqual([
      {
        name: "check",
        passed: true,
        reason: '$steps.draft.output.ok (="«draft.output.ok»") satisfies truthy',
      },
    ]);
    // The cue sits on the GATE, not only on the upstream agent step that
    // produced the value.
    expect(report.steps.find((s) => s.name === "check")?.mode).toBe("evaluated-on-stubs");
    expect(report.steps.find((s) => s.name === "draft")?.mode).toBe("stubbed");
  });

  test("a gate a stub FAILS is not enforced either — the run continues past it", async () => {
    // The mirror: `eq` against a literal can never hold for a Proxy, so
    // enforcing that verdict would stop the dry run at the first gate and
    // hide every downstream finding behind a failure that is not a fact.
    const report = await dryRunWorkflow(gatedOnStub("eq"), {});

    expect(report.status).toBe(DRY_RUN_UNVERIFIED);
    expect(report.error).toBeUndefined();
    expect(report.gatesOnStubs[0]).toMatchObject({ name: "check", passed: false });
    // The step AFTER the unenforced gate actually ran.
    expect(report.steps.find((s) => s.name === "after")?.status).toBe("success");
    expect(report.output).toEqual({ done: "yes" });
  });

  test("a gate over deterministic operands is enforced exactly as built", async () => {
    // The useful half of the feature, unchanged: nothing about this gate
    // is fabricated, so its verdict is a fact and it stops the run.
    const report = await dryRunWorkflow(
      {
        name: "real-gate",
        description: "",
        steps: [
          { name: "check", kind: "gate", condition: { ref: "$input.mode", op: "eq", value: "ok" } },
          { name: "after", kind: "transform", output: { done: "yes" } },
        ],
      },
      { mode: "nope" },
    );

    expect(report.status).toBe("error");
    expect(report.error).toContain('Gate "check" failed');
    expect(report.gatesOnStubs).toEqual([]);
    expect(report.steps.find((s) => s.name === "check")?.mode).toBe("evaluated");
    expect(report.steps.find((s) => s.name === "after")?.status).toBe("skipped");
  });

  test("a passing deterministic gate leaves the report a genuine success", async () => {
    const report = await dryRunWorkflow(
      {
        name: "real-gate-ok",
        description: "",
        steps: [
          { name: "check", kind: "gate", condition: { ref: "$input.mode", op: "eq", value: "ok" } },
        ],
      },
      { mode: "ok" },
    );

    expect(report.status).toBe("success");
    expect(report.gatesOnStubs).toEqual([]);
  });

  test("a stub laundered through a transform still leaves the gate unenforced", async () => {
    // The taint is deep: the transform's output is a real object with a
    // stub INSIDE it, and a shallow check would call that operand
    // deterministic and enforce a verdict about fabricated data.
    const report = await dryRunWorkflow(
      {
        name: "laundered",
        description: "",
        steps: [
          { name: "draft", kind: "agent", agent: "writer" },
          { name: "copy", kind: "transform", output: { text: "$steps.draft.output.text" } },
          { name: "check", kind: "gate", condition: { ref: "$steps.copy.output", op: "exists" } },
        ],
      },
      {},
    );

    expect(report.status).toBe(DRY_RUN_UNVERIFIED);
    expect(report.gatesOnStubs.map((g) => g.name)).toEqual(["check"]);
  });

  test("an unenforced gate's own result is a stub, so a gate reading it is unenforced too", async () => {
    // Otherwise the second gate would enforce against a boolean derived
    // from fabrication — a laundering path one hop shorter than the
    // transform above.
    const report = await dryRunWorkflow(
      {
        name: "chained",
        description: "",
        steps: [
          { name: "draft", kind: "agent", agent: "writer" },
          { name: "first", kind: "gate", condition: { ref: "$steps.draft.output.ok", op: "truthy" } },
          { name: "second", kind: "gate", condition: { ref: "$steps.first.output.passed", op: "truthy" } },
        ],
      },
      {},
    );

    expect(report.gatesOnStubs.map((g) => g.name)).toEqual(["first", "second"]);
    expect(report.status).toBe(DRY_RUN_UNVERIFIED);
  });

  test("a gate whose ref cannot resolve reports the ref error rather than hiding behind 'unenforced'", async () => {
    // A ref into a step that does not exist is a real defect in the
    // graph, and it is exactly what a dry run is for. Classifying it as
    // "operands unknown, so unenforced" would swallow the finding.
    const report = await dryRunWorkflow(
      {
        name: "ghost-ref",
        description: "",
        steps: [{ name: "check", kind: "gate", condition: { ref: "$steps.ghost.output", op: "exists" } }],
      },
      {},
    );

    expect(report.status).toBe("error");
    expect(report.error).toContain('step "ghost" has not produced a result');
    expect(report.gatesOnStubs).toEqual([]);
  });

  test("a failure keeps its own status even when a gate went unenforced", async () => {
    // `unverified` must never overwrite a real failure — the fault is the
    // answer the caller needs, not the caveat.
    const report = await dryRunWorkflow(
      {
        name: "both",
        description: "",
        steps: [
          { name: "draft", kind: "agent", agent: "writer" },
          { name: "check", kind: "gate", condition: { ref: "$steps.draft.output.ok", op: "truthy" } },
          { name: "hard", kind: "gate", condition: { ref: "$input.n", op: "gt", value: 1 } },
        ],
      },
      { n: 0 },
    );

    expect(report.status).toBe("error");
    expect(report.gatesOnStubs.map((g) => g.name)).toEqual(["check"]);
  });

  test("dryRunStatus downgrades only a success", () => {
    expect(dryRunStatus("success", 0)).toBe("success");
    expect(dryRunStatus("success", 1)).toBe(DRY_RUN_UNVERIFIED);
    expect(dryRunStatus("error", 1)).toBe("error");
    expect(dryRunStatus("cancelled", 2)).toBe("cancelled");
  });

  test("containsDryRunStub finds a stub nested anywhere, and nowhere else", () => {
    expect(containsDryRunStub(dryRunStub("s"))).toBe(true);
    expect(containsDryRunStub({ a: { b: [1, dryRunStub("s")] } })).toBe(true);
    expect(containsDryRunStub([[{ deep: dryRunStub("s") }]])).toBe(true);
    expect(containsDryRunStub({ a: { b: [1, "two"] } })).toBe(false);
    expect(containsDryRunStub(null)).toBe(false);
    expect(containsDryRunStub("text")).toBe(false);
    expect(containsDryRunStub(7)).toBe(false);
  });
});

describe("dry run reports failures rather than throwing them", () => {
  test("an unresolvable ref into an EVALUATED step is still reported", async () => {
    // The useful half of dry-run validation: refs into steps that really
    // ran are still checked strictly.
    const report = await dryRunWorkflow(
      {
        name: "bad-ref",
        description: "",
        steps: [
          { name: "one", kind: "transform", output: { a: "literal" } },
          { name: "two", kind: "transform", output: { b: "$steps.one.output.missing" } },
        ],
      },
      {},
    );

    expect(report.status).toBe("error");
    expect(report.error).toContain("missing");
  });
});
