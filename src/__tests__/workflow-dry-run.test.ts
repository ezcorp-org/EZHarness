import { describe, expect, test } from "bun:test";
import {
  DRY_RUN_STUB_MARKER,
  dryRunAgentExecutor,
  dryRunStub,
  dryRunWorkflow,
  isDryRunStub,
  isPureDryRunKind,
  renderStubs,
  WorkflowDryRunViolation,
} from "../runtime/workflow-dry-run";
import type { WorkflowDefinition } from "../types";

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
  test("a tool-bearing graph dry-runs to completion with stubs", async () => {
    const report = await dryRunWorkflow(toolBearing, { topic: "release notes" });

    expect(report.status).toBe("success");
    expect(report.error).toBeUndefined();
    expect(report.stubbed).toEqual(["draft", "publish"]);
    expect(report.steps.map((s) => s.mode)).toEqual(["stubbed", "stubbed", "evaluated"]);
  });

  test("the tool runner factory throws, so a tool step reaching dispatch fails loudly", () => {
    // The backstop itself. `dryRunWorkflow` wires this factory; proving it
    // throws is what makes "no tool ran" a property of the object graph
    // rather than of the substitution predicate being right.
    expect(() => {
      throw new WorkflowDryRunViolation("tool dispatch");
    }).toThrow(/must never dispatch/);
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

describe("dry run reports failures rather than throwing them", () => {
  test("a gate that fails against stub data stops the run and names the gate", async () => {
    // Gates are evaluated FOR REAL — the honest outcome, and the reason
    // the UI warns that gates run against stub data.
    const report = await dryRunWorkflow(
      {
        name: "gated",
        description: "",
        steps: [
          { name: "draft", kind: "agent", agent: "writer" },
          { name: "check", kind: "gate", condition: { ref: "$steps.draft.output.status", op: "eq", value: "ok" } },
          { name: "after", kind: "transform", output: { done: "yes" } },
        ],
      },
      {},
    );

    expect(report.status).toBe("error");
    expect(report.error).toContain('Gate "check" failed');
    expect(report.steps.find((s) => s.name === "after")?.status).toBe("skipped");
  });

  test("a gate whose condition holds against a stub passes", async () => {
    const report = await dryRunWorkflow(
      {
        name: "gated-ok",
        description: "",
        steps: [
          { name: "draft", kind: "agent", agent: "writer" },
          { name: "check", kind: "gate", condition: { ref: "$steps.draft.output.ok", op: "truthy" } },
        ],
      },
      {},
    );

    expect(report.status).toBe("success");
  });

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
