/**
 * Conditional skip (`when` / `skipDependents`) — C7's control-flow half.
 *
 * The property under test throughout is that skipping is NOT a failure:
 * every assertion checks the RUN's terminal status alongside the step's,
 * because "the step says skipped" is also true of an implementation that
 * skipped the step and then failed the run, and that is the outcome the
 * whole feature exists to avoid.
 *
 * The ref-language interaction is the sharp edge and gets its own block:
 * `$steps.<name>` is strict on the step, so a skipped step's downstream
 * reader must still fail — loudly, naming the fix — rather than silently
 * receiving `undefined`.
 */
import { test, expect, describe } from "bun:test";
import { WorkflowExecutor } from "../runtime/workflow-executor";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import { validateWorkflow } from "../runtime/workflow-validator";
import type {
  AgentDefinition,
  AgentEvents,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepRun,
} from "../types";

function makeAgent(name: string, onRun: () => void): AgentDefinition {
  return {
    name,
    description: name,
    capabilities: ["llm"],
    execute: async () => {
      onRun();
      return { success: true, output: { ran: name } };
    },
  };
}

function setup(agents: AgentDefinition[] = []) {
  const bus = new EventBus<AgentEvents>();
  const executor = new AgentExecutor(loadAgentsStatic(agents), bus);
  return new WorkflowExecutor(executor, bus);
}

/** `when` that is always false / always true, in the real grammar. */
const NEVER = { ref: "$input.go", op: "eq" as const, value: "yes" };
const ALWAYS = { ref: "$input.go", op: "neq" as const, value: "yes" };

function wf(steps: WorkflowStep[]): WorkflowDefinition {
  return { name: "cond", description: "conditional", steps };
}

const stepNamed = (run: WorkflowRun, name: string): WorkflowStepRun | undefined =>
  run.steps.find((s) => s.stepName === name);

describe("`when` — a false guard skips, it does not fail", () => {
  test("a skipped step leaves the RUN successful", async () => {
    let ran = 0;
    const wfx = setup([makeAgent("a", () => ran++)]);

    const run = await wfx.runWorkflow(wf([{ name: "maybe", agent: "a", when: NEVER }]), {
      go: "no",
    });

    // Both halves. A `gate` already produces "step did not proceed"; what
    // is new is that the run survives it.
    expect(run.status).toBe("success");
    expect(stepNamed(run, "maybe")?.status).toBe("skipped");
    expect(ran).toBe(0);
  });

  test("a satisfied guard runs the step exactly as before", async () => {
    let ran = 0;
    const wfx = setup([makeAgent("a", () => ran++)]);

    const run = await wfx.runWorkflow(wf([{ name: "maybe", agent: "a", when: ALWAYS }]), {
      go: "no",
    });

    expect(run.status).toBe("success");
    expect(stepNamed(run, "maybe")?.status).toBe("success");
    expect(ran).toBe(1);
  });

  test("the skipped step carries a reason naming its own guard", async () => {
    const wfx = setup([makeAgent("a", () => {})]);
    const run = await wfx.runWorkflow(wf([{ name: "maybe", agent: "a", when: NEVER }]), {
      go: "no",
    });
    // A trace showing "skipped" with no explanation is indistinguishable
    // from a step that was never reached.
    expect(stepNamed(run, "maybe")?.skippedReason).toContain('its "when" was not met');
  });

  test("an unresolvable ref inside `when` FAILS the step — it never guesses", async () => {
    const wfx = setup([makeAgent("a", () => {})]);
    const run = await wfx.runWorkflow(
      wf([
        {
          name: "maybe",
          agent: "a",
          when: { ref: "$steps.ghost.output.v", op: "truthy" },
        },
      ]),
      {},
    );
    // Silently reading an unresolvable guard as "run it" or as "skip it"
    // decides a branch by accident. Loud failure is the subsystem's rule.
    expect(run.status).toBe("error");
    expect(stepNamed(run, "maybe")?.status).toBe("error");
  });

  test("`when` on a looped step is evaluated ONCE, before the loop", async () => {
    let ran = 0;
    const wfx = setup([makeAgent("a", () => ran++)]);

    const run = await wfx.runWorkflow(
      wf([
        {
          name: "maybe",
          agent: "a",
          when: NEVER,
          loop: { maxIterations: 5 },
        },
      ]),
      { go: "no" },
    );

    expect(run.status).toBe("success");
    expect(stepNamed(run, "maybe")?.status).toBe("skipped");
    // Not "ran once and stopped" — zero. A per-iteration guard is `until`.
    expect(ran).toBe(0);
    expect(stepNamed(run, "maybe")?.iterations).toBeUndefined();
  });
});

describe("transitive skip", () => {
  test("dependents are skipped too, transitively, each with a reason", async () => {
    let ran = 0;
    const wfx = setup([makeAgent("a", () => ran++)]);

    const run = await wfx.runWorkflow(
      wf([
        { name: "head", agent: "a", when: NEVER },
        { name: "mid", agent: "a", dependsOn: ["head"] },
        { name: "tail", agent: "a", dependsOn: ["mid"] },
      ]),
      { go: "no" },
    );

    expect(run.status).toBe("success");
    expect(stepNamed(run, "mid")?.status).toBe("skipped");
    expect(stepNamed(run, "tail")?.status).toBe("skipped");
    expect(ran).toBe(0);
    // A transitively-skipped step explains itself by NAMING its cause —
    // otherwise the trace shows a skipped step with no explanation, and a
    // "dependents were skipped" test would pass on an implementation that
    // left them silent.
    expect(stepNamed(run, "mid")?.skippedReason).toBe('step "head" was skipped');
    expect(stepNamed(run, "tail")?.skippedReason).toBe('step "mid" was skipped');
  });

  test("`skipDependents: false` on the SKIPPED step lets its dependents run", async () => {
    let ran = 0;
    const wfx = setup([makeAgent("a", () => ran++)]);

    const run = await wfx.runWorkflow(
      wf([
        { name: "head", agent: "a", when: NEVER, skipDependents: false },
        { name: "mid", agent: "a", dependsOn: ["head"] },
      ]),
      { go: "no" },
    );

    expect(run.status).toBe("success");
    expect(stepNamed(run, "head")?.status).toBe("skipped");
    expect(stepNamed(run, "mid")?.status).toBe("success");
    expect(ran).toBe(1);
  });

  test("the flag is read off the SKIPPED step, not off the dependent", async () => {
    let ran = 0;
    const wfx = setup([makeAgent("a", () => ran++)]);

    // `skipDependents: false` declared on the DEPENDENT must not opt it
    // into running: only the producer knows whether its absence is
    // survivable, and a consumer cannot consent to a value nobody made.
    const run = await wfx.runWorkflow(
      wf([
        { name: "head", agent: "a", when: NEVER },
        { name: "mid", agent: "a", dependsOn: ["head"], skipDependents: false },
      ]),
      { go: "no" },
    );

    expect(stepNamed(run, "mid")?.status).toBe("skipped");
    expect(ran).toBe(0);
  });
});

describe("`$prev` across a skipped batch", () => {
  test("a fully skipped batch leaves `$prev` naming the last real result", async () => {
    const wfx = setup();

    const run = await wfx.runWorkflow(
      wf([
        { name: "a", kind: "transform", output: { v: "A" } },
        {
          name: "b",
          kind: "transform",
          output: { v: "B" },
          when: NEVER,
          skipDependents: false,
          dependsOn: ["a"],
        },
        {
          name: "c",
          kind: "transform",
          output: { got: "$prev.output.v" },
          dependsOn: ["b"],
        },
      ]),
      { go: "no" },
    );

    expect(run.status).toBe("success");
    // Not "B" (the skipped step's would-be value) and not a throw: `$prev`
    // is untouched by a batch that executed nothing.
    expect(run.result?.output).toMatchObject({ got: "A" });
  });

  test("a skipped sibling never becomes `$prev` for the next batch", async () => {
    const wfx = setup();

    // `zed` is declared LAST in its batch, so under the old
    // "last slot of the batch" rule it would have been `$prev`.
    const run = await wfx.runWorkflow(
      wf([
        { name: "seed", kind: "transform", output: { v: "SEED" } },
        {
          name: "aye",
          kind: "transform",
          output: { v: "AYE" },
          dependsOn: ["seed"],
        },
        {
          name: "zed",
          kind: "transform",
          output: { v: "ZED" },
          when: NEVER,
          skipDependents: false,
          dependsOn: ["seed"],
        },
        {
          name: "read",
          kind: "transform",
          output: { got: "$prev.output.v" },
          dependsOn: ["aye", "zed"],
        },
      ]),
      { go: "no" },
    );

    expect(run.status).toBe("success");
    expect(run.result?.output).toMatchObject({ got: "AYE" });
  });
});

describe("a skipped step's refs stay STRICT", () => {
  test("an undeclared reader fails, and the message names the skip and the fix", async () => {
    const wfx = setup();

    // Deliberately built past the validator (which rejects this shape) so
    // the run-time fallback is exercised: a definition can predate the
    // check, or reach it through a ref the scan cannot see.
    const run = await wfx.runWorkflow(
      wf([
        { name: "draft", kind: "transform", output: { path: "p" }, when: NEVER },
        { name: "use", kind: "transform", output: { p: "$steps.draft.output.path" } },
      ]),
      { go: "no" },
    );

    expect(run.status).toBe("error");
    const message = String(run.result?.error);
    // "has not run yet" would send the author looking for a missing step
    // that is right there in the definition.
    expect(message).toContain("was SKIPPED");
    expect(message).toContain('dependsOn: ["draft"]');
  });

  test("a declared reader is skipped rather than left to hit the strict ref", async () => {
    const wfx = setup();
    const run = await wfx.runWorkflow(
      wf([
        { name: "draft", kind: "transform", output: { path: "p" }, when: NEVER },
        {
          name: "use",
          kind: "transform",
          output: { p: "$steps.draft.output.path" },
          dependsOn: ["draft"],
        },
      ]),
      { go: "no" },
    );

    expect(run.status).toBe("success");
    expect(stepNamed(run, "use")?.status).toBe("skipped");
  });

  test("an ordinary unrun step keeps its original wording", async () => {
    const wfx = setup();
    const run = await wfx.runWorkflow(
      wf([{ name: "use", kind: "transform", output: { p: "$steps.ghost.output.path" } }]),
      {},
    );
    // The skip wording must not leak onto every strict-ref failure — that
    // would make a genuine graph error read as a control-flow decision.
    const message = String(run.result?.error);
    expect(message).toContain("has not produced a result");
    expect(message).not.toContain("SKIPPED");
  });
});

describe("validateWorkflow — the skip/ref rule", () => {
  const errorsFor = (steps: WorkflowStep[]): string[] => validateWorkflow(wf(steps));

  test("a reader of a skippable step without dependsOn is a DEFINITION-time error", () => {
    const errors = errorsFor([
      { name: "draft", kind: "transform", output: { path: "p" }, when: NEVER },
      { name: "use", agent: "a", input: { p: "$steps.draft.output.path" } },
    ]);
    expect(errors.some((e) => e.includes('references $steps."draft"'))).toBe(true);
  });

  test("declaring the dependency clears it", () => {
    const errors = errorsFor([
      { name: "draft", kind: "transform", output: { path: "p" }, when: NEVER },
      {
        name: "use",
        agent: "a",
        input: { p: "$steps.draft.output.path" },
        dependsOn: ["draft"],
      },
    ]);
    expect(errors).toEqual([]);
  });

  test("a TRANSITIVELY skippable step's reader is caught too", () => {
    // `mid` declares no `when` of its own — it is skippable only because
    // `head` suppresses it. Checking direct `when` declarations alone would
    // miss this and leave the deeper reader to discover it at run time.
    const errors = errorsFor([
      { name: "head", agent: "a", when: NEVER },
      { name: "mid", agent: "a", dependsOn: ["head"] },
      { name: "use", agent: "a", input: { v: "$steps.mid.output.v" } },
    ]);
    expect(errors.some((e) => e.includes('references $steps."mid"'))).toBe(true);
  });

  test("`skipDependents: false` cuts the propagation, so the deeper reader is fine", () => {
    const errors = errorsFor([
      { name: "head", agent: "a", when: NEVER, skipDependents: false },
      { name: "mid", agent: "a", dependsOn: ["head"] },
      { name: "use", agent: "a", input: { v: "$steps.mid.output.v" } },
    ]);
    expect(errors).toEqual([]);
  });

  test("a `{{…}}` template inside a transform is scanned, not just direct refs", () => {
    // The C7 spec calls this out by name as the ref "the validator cannot
    // see". `resolveOutputMapping` interpolates templates, so a scan that
    // only read direct refs would pass this and fail at run time.
    const errors = errorsFor([
      { name: "draft", agent: "a", when: NEVER },
      {
        name: "use",
        kind: "transform",
        output: { line: "text: {{ $steps.draft.output.text }}" },
      },
    ]);
    expect(errors.some((e) => e.includes('references $steps."draft"'))).toBe(true);
  });

  test("a condition, a `when` and a loop `until` are all scanned", () => {
    const errors = errorsFor([
      { name: "draft", agent: "a", when: NEVER },
      {
        name: "g",
        kind: "gate",
        condition: { ref: "$steps.draft.output.ok", op: "truthy" },
      },
      {
        name: "w",
        agent: "a",
        when: { ref: "$steps.draft.output.ok", op: "truthy" },
      },
      {
        name: "l",
        agent: "a",
        loop: {
          maxIterations: 2,
          until: { ref: "$steps.draft.output.ok", op: "truthy" },
        },
      },
    ]);
    for (const name of ["g", "w", "l"]) {
      expect(errors.some((e) => e.startsWith(`Step "${name}" references`))).toBe(true);
    }
  });

  test("a graph with no `when` anywhere is completely unaffected", () => {
    // The rule must never fire for a definition that predates `when` —
    // undeclared refs are legal and common today.
    const errors = errorsFor([
      { name: "draft", agent: "a" },
      { name: "use", agent: "a", input: { v: "$steps.draft.output.v" } },
    ]);
    expect(errors).toEqual([]);
  });
});

describe("validateWorkflow — `when` / `skipDependents` shape", () => {
  test("a malformed `when` is rejected with the same wording a gate gets", () => {
    const errors = validateWorkflow(wf([{ name: "s", agent: "a", when: {} as never }]));
    expect(errors.some((e) => e.includes('Step "s" when leaf requires'))).toBe(true);
  });

  test("a non-boolean `skipDependents` is rejected", () => {
    // "false" (the string) is truthy, so a silent accept would read as ON —
    // the wrong default in the one field that exists to turn the safe
    // behaviour off.
    const errors = validateWorkflow(
      wf([{ name: "s", agent: "a", skipDependents: "false" as never }]),
    );
    expect(errors).toContain('Step "s" "skipDependents" must be a boolean');
  });

  test("a well-formed `when` on any kind is accepted", () => {
    expect(validateWorkflow(wf([{ name: "s", agent: "a", when: NEVER }]))).toEqual([]);
  });
});
