/**
 * The three shipped `*.workflow.yaml` templates, put through the SAME
 * validator the boot loader uses.
 *
 * A workflow asset is data, not code — nothing typechecks it, no import
 * resolves it, and a mistake in one is invisible until a run reaches the
 * broken step. `loadExtensionWorkflows` warn-and-SKIPS an invalid file
 * (deliberately: a broken asset in one extension must not take down boot),
 * so the failure mode in production is a template that silently is not
 * there. This file is the only thing standing between a typo'd `$steps.`
 * ref and that.
 *
 * Every assertion below is paired with a DISCRIMINATION case — the same
 * predicate applied to a deliberately-broken copy — because a guard that
 * has never been seen to fail is indistinguishable from one that cannot.
 *
 * The four rules that a future editor will otherwise undo, each with its
 * own named test:
 *
 *   1. Agent names carry the `ez-factory ` prefix and name a SEEDED agent.
 *      Agent names are one flat global map; a bare `writer` collides with
 *      any user's own agent of that name, in either direction.
 *   2. NO step declares an `rbacScope`. On an approval it REPLACES the
 *      owner check and resolves at `{projectId: null, extensionId: null}`,
 *      which an ez-factory-scoped grant does not cover — "tightening" it
 *      makes every gate admin-only and locks the job's own creator out.
 *   3. Approval `prompt`s carry no `{{…}}`. `parkWorkflowApproval` stores
 *      the prompt VERBATIM, so a template placeholder would be shown to a
 *      human as literal source.
 *   4. Every agent step binds `maxTokens`. A step output over
 *      `MAX_STEP_OUTPUT_BYTES` is stored as a sentinel and a resume
 *      REFUSES the run terminally — after the LLM spend and after the
 *      human answered.
 */
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

import type { WorkflowDefinition, WorkflowStep } from "../../src/types";
import { validateWorkflow } from "../../src/runtime/workflow-validator";
import { loadExtensionWorkflows } from "../../src/runtime/workflow-extension-loader";
import { namespacedWorkflowName } from "../../src/runtime/workflow-name";
import {
  collectWorkflowClosure,
  MAX_WORKFLOW_NESTING_DEPTH,
} from "../../src/runtime/workflow-closure";
import { MAX_STEP_OUTPUT_BYTES } from "../../src/runtime/workflow-step-output";
import { VALID_MODEL_EFFORTS } from "../../src/runtime/workflow-model";
import { hasTemplate, templateRefs } from "../../src/runtime/workflow-refs";
import { conditionRefs } from "../../src/runtime/workflow-condition";
import {
  dryRunWorkflow,
  DRY_RUN_UNVERIFIED,
  type DryRunReport,
} from "../../src/runtime/workflow-dry-run";
import {
  EZ_FACTORY_AGENTS,
  EZ_FACTORY_AGENT_PREFIX,
  EZ_FACTORY_EXTENSION_NAME,
} from "../../src/extensions/ez-factory-agents";
import manifest from "./ezcorp.config";

const TEMPLATE_FILES = [
  "docs-factory.workflow.yaml",
  "draft-and-verify.workflow.yaml",
  "etl-factory.workflow.yaml",
] as const;

/** The bare names `permissions.workflows.names` authorizes this extension
 *  to FIRE. Shipping an asset is not the privileged act; firing it is, and
 *  a template whose declared name is absent here loads fine and is then
 *  refused at `ctx.workflows.run()`. */
const grantedNames = (
  manifest.permissions?.workflows as { names: string[] } | undefined
)?.names;

/** Read one asset exactly as the loader does: parse the YAML, take it at
 *  face value, no schema coercion. */
async function readTemplate(file: string): Promise<WorkflowDefinition> {
  const text = await Bun.file(`${import.meta.dir}/${file}`).text();
  return parse(text) as WorkflowDefinition;
}

/** What the loader hands the validator: the SAME rename, applied before
 *  validation, so what this file checks is what actually enters the cache. */
function asLoaderWouldName(def: WorkflowDefinition): WorkflowDefinition {
  return {
    ...def,
    name: namespacedWorkflowName(EZ_FACTORY_EXTENSION_NAME, def.name),
    description: def.description ?? "",
  };
}

const templates = await Promise.all(TEMPLATE_FILES.map(readTemplate));
const byBareName = new Map(templates.map((def) => [def.name, def]));

/** A deep, independent copy so a mutation in a discrimination case cannot
 *  leak into the next test. */
function mutantOf(bareName: string): WorkflowDefinition {
  return structuredClone(byBareName.get(bareName)!);
}

function stepNamed(def: WorkflowDefinition, name: string): WorkflowStep {
  const step = def.steps.find((s) => s.name === name);
  if (!step) throw new Error(`No step "${name}" in "${def.name}"`);
  return step;
}

const everyStep = (): WorkflowStep[] => templates.flatMap((def) => def.steps);
const stepKindOf = (step: WorkflowStep): string => step.kind ?? "agent";

// ── The predicates the guards are built from ────────────────────────
//
// Extracted so each can be pointed at a BROKEN definition and shown to
// answer differently. A guard written inline as a bare `expect` in a loop
// cannot be discriminated, only trusted.

const stepsDeclaringRbacScope = (defs: WorkflowDefinition[]): string[] =>
  defs.flatMap((def) =>
    def.steps.filter((s) => s.rbacScope !== undefined).map((s) => `${def.name}.${s.name}`),
  );

const seededAgentNames: string[] = EZ_FACTORY_AGENTS.map((a) => a.name);

const agentStepsNamingAnUnseededAgent = (defs: WorkflowDefinition[]): string[] =>
  defs.flatMap((def) =>
    def.steps
      .filter((s) => stepKindOf(s) === "agent" && !seededAgentNames.includes(s.agent ?? ""))
      .map((s) => `${def.name}.${s.name} -> ${s.agent}`),
  );

const approvalPromptsCarryingATemplate = (defs: WorkflowDefinition[]): string[] =>
  defs.flatMap((def) =>
    def.steps
      .filter((s) => stepKindOf(s) === "approval" && (s.prompt ?? "").includes("{{"))
      .map((s) => `${def.name}.${s.name}`),
  );

const declaredNamesOf = (defs: WorkflowDefinition[]): string[] =>
  defs.map((d) => d.name).sort();

// ── Ref integrity, which `validateWorkflow` does NOT check ──────────
//
// Verified by mutation: renaming `$steps.review-loop.…` to
// `$steps.review-lop.…` inside `docs-factory` passes `validateWorkflow`
// clean. It only inspects a `$steps` target for the SKIP rule (is the
// named step one that can be skipped?) and a nonexistent step is not
// skippable — so a typo is a run-time
// `Cannot resolve "$steps.review-lop.output.content"` at the moment that
// step dispatches, after everything upstream has already been paid for.
//
// The readers below are the PRODUCTION ones (`conditionRefs`,
// `templateRefs` / `hasTemplate`) rather than a second walker, so this
// cannot drift from what the resolver actually reads. The field split
// mirrors the resolver's own asymmetry: only a transform's `output`
// interpolates `{{…}}`; `input` / `model` / `itemsRef` are direct refs.

interface FieldRef {
  step: string;
  field: string;
  ref: string;
}

function refsOf(step: WorkflowStep): FieldRef[] {
  const out: FieldRef[] = [];
  const direct = (field: string, value: unknown): void => {
    if (typeof value === "string") out.push({ step: step.name, field, ref: value });
  };
  for (const value of Object.values(step.input ?? {})) direct("input", value);
  for (const value of Object.values(step.model ?? {})) direct("model", value);
  if (step.itemsRef !== undefined) direct("itemsRef", step.itemsRef);
  for (const value of Object.values(step.output ?? {})) {
    if (typeof value === "string" && hasTemplate(value)) {
      for (const ref of templateRefs(value)) out.push({ step: step.name, field: "output", ref });
      continue;
    }
    direct("output", value);
  }
  for (const [field, cond] of [
    ["condition", step.condition],
    ["when", step.when],
    ["loop.until", step.loop?.until],
  ] as const) {
    if (cond) for (const ref of conditionRefs(cond)) out.push({ step: step.name, field, ref });
  }
  return out;
}

/** The step a `$steps.<name>[.path]` ref addresses, else undefined. */
function stepNameOfRef(ref: string): string | undefined {
  if (!ref.startsWith("$steps.")) return undefined;
  const rest = ref.slice("$steps.".length);
  const dot = rest.indexOf(".");
  const name = dot === -1 ? rest : rest.slice(0, dot);
  return name === "" ? undefined : name;
}

/** Every step reachable from `start` through `dependsOn`, transitively. */
function transitiveDeps(def: WorkflowDefinition, start: WorkflowStep): Set<string> {
  const byName = new Map(def.steps.map((s) => [s.name, s]));
  const seen = new Set<string>();
  const queue = [...(start.dependsOn ?? [])];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...(byName.get(name)?.dependsOn ?? []));
  }
  return seen;
}

/**
 * `$steps.X` refs that name a step which is not a transitive dependency of
 * the referencing step — which covers BOTH a typo (no such step at all)
 * and a real ordering bug (the target runs in the same batch or later, so
 * its result does not exist yet).
 */
const danglingStepRefs = (defs: WorkflowDefinition[]): string[] =>
  defs.flatMap((def) =>
    def.steps.flatMap((step) => {
      const deps = transitiveDeps(def, step);
      return refsOf(step)
        .filter((r) => {
          const target = stepNameOfRef(r.ref);
          return target !== undefined && !deps.has(target);
        })
        .map((r) => `${def.name}.${r.step}.${r.field} -> ${r.ref}`);
    }),
  );

/** `$input.f` refs naming a field the workflow's `inputSchema` never
 *  declares. Lenient at run time — it resolves to `undefined` — so a typo
 *  here is silent, not loud. */
const undeclaredInputRefs = (defs: WorkflowDefinition[]): string[] =>
  defs.flatMap((def) => {
    const declared = new Set(Object.keys(def.inputSchema ?? {}));
    return def.steps.flatMap((step) =>
      refsOf(step)
        .filter((r) => r.ref.startsWith("$input.") && !declared.has(r.ref.slice("$input.".length)))
        .map((r) => `${def.name}.${r.step}.${r.field} -> ${r.ref}`),
    );
  });

/** `$loop.*` outside a looped step, or `$result` / `$iteration` outside a
 *  `loop.until` — both throw at run time, neither is caught at definition
 *  time. */
const misplacedLoopRefs = (defs: WorkflowDefinition[]): string[] =>
  defs.flatMap((def) =>
    def.steps.flatMap((step) =>
      refsOf(step)
        .filter((r) => {
          if (r.ref.startsWith("$loop.")) return step.loop === undefined;
          if (r.ref === "$iteration" || r.ref === "$result" || r.ref.startsWith("$result."))
            return r.field !== "loop.until";
          return false;
        })
        .map((r) => `${def.name}.${r.step}.${r.field} -> ${r.ref}`),
    ),
  );

describe("ez-factory templates — identity and the manifest grant", () => {
  test("exactly three *.workflow.yaml assets ship", async () => {
    const found = await Array.fromAsync(
      new Bun.Glob("*.workflow.yaml").scan({ cwd: import.meta.dir }),
    );
    expect(found.sort()).toEqual([...TEMPLATE_FILES].sort());
  });

  test("the declared names are EXACTLY the three the manifest grants", () => {
    expect(grantedNames).toBeDefined();
    expect(declaredNamesOf(templates)).toEqual([...grantedNames!].sort());
  });

  test("that comparison discriminates — one renamed template breaks it", () => {
    // Without this, the assertion above would pass just as happily against
    // a comparison that could not fail.
    const renamed = mutantOf("docs-factory");
    renamed.name = "docs-factory-v2";
    const withOneRenamed = [renamed, ...templates.filter((d) => d.name !== "docs-factory")];
    expect(declaredNamesOf(withOneRenamed)).not.toEqual([...grantedNames!].sort());
  });

  test("every declared name is BARE — the separator is applied by the host", () => {
    // A declared name containing `:` is rejected outright by the loader
    // (an extension must not be able to forge another's namespace), and
    // `permissions.workflows.names` is matched against the bare form.
    for (const def of templates) {
      expect(def.name).not.toContain(":");
    }
  });

  test("every template carries a non-empty description", () => {
    for (const def of templates) {
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
    }
  });
});

describe("ez-factory templates — the shared validator accepts every one", () => {
  test.each([...TEMPLATE_FILES])("%s validates clean, namespaced as the loader names it", async (file) => {
    const def = asLoaderWouldName(await readTemplate(file));
    // `toEqual([])` rather than a length check: a failure prints the
    // validator's own messages, which name the offending step and rule.
    expect(validateWorkflow(def)).toEqual([]);
  });

  test("the boot loader admits all three, renamed <extension>:<name>", async () => {
    // The real entry point. It parses, renames, validates and warn-SKIPS —
    // so a template that fails validation is simply ABSENT from this list,
    // which is exactly how the failure would present in production.
    const loaded = await loadExtensionWorkflows([
      { extensionName: EZ_FACTORY_EXTENSION_NAME, installPath: import.meta.dir },
    ]);
    expect(loaded.map((d) => d.name).sort()).toEqual([
      "ez-factory:docs-factory",
      "ez-factory:draft-and-verify",
      "ez-factory:etl-factory",
    ]);
  });
});

describe("ez-factory templates — the validator has teeth (discrimination)", () => {
  // Each case breaks ONE real rule in a real template and asserts the
  // validator names it. Together they prove the clean result above is a
  // verdict rather than a no-op.

  test("a $steps ref to a skippable step without dependsOn is rejected", () => {
    const def = asLoaderWouldName(mutantOf("etl-factory"));
    // `consent` reads the answer of `anomaly-gate`, which carries a `when`
    // and can therefore be skipped. Dropping the dependency is the exact
    // mistake that would fail at run time on the clean path.
    delete stepNamed(def, "consent").dependsOn;
    const errors = validateWorkflow(def);
    expect(errors.join("\n")).toContain("can be SKIPPED");
  });

  test("a loop on a tool step is rejected", () => {
    const def = asLoaderWouldName(mutantOf("docs-factory"));
    stepNamed(def, "read").loop = { maxIterations: 2 };
    expect(validateWorkflow(def).join("\n")).toContain('cannot have a "loop"');
  });

  test("an effort outside the closed vocabulary is rejected", () => {
    const def = asLoaderWouldName(mutantOf("docs-factory"));
    stepNamed(def, "extract").model = { effort: "turbo" };
    expect(validateWorkflow(def).join("\n")).toContain("must be one of");
  });

  test("a nested target expressed as a ref is rejected", () => {
    const def = asLoaderWouldName(mutantOf("docs-factory"));
    // The cycle check and the depth cap are DEFINITION-time checks that a
    // run-time name makes uncomputable, which is why this is illegal.
    stepNamed(def, "review-loop").workflow = "$input.child";
    expect(validateWorkflow(def).join("\n")).toContain("must be a literal workflow name");
  });

  test("an approval declaring requireItemConsent with no itemsRef is rejected", () => {
    // The design sketch had exactly this on the publish gate. With no items
    // to consent to, the requirement silently passes — so it is a
    // definition-time error, and the templates ship without it.
    const def = asLoaderWouldName(mutantOf("draft-and-verify"));
    stepNamed(def, "review").requireItemConsent = true;
    expect(validateWorkflow(def).join("\n")).toContain("requireItemConsent");
  });

  test("a model override on a non-agent step is rejected", () => {
    const def = asLoaderWouldName(mutantOf("docs-factory"));
    stepNamed(def, "review-loop").model = { effort: "high" };
    expect(validateWorkflow(def).join("\n")).toContain('cannot specify a "model" override');
  });
});

describe("ez-factory templates — ref integrity (the validator does not check this)", () => {
  test("every $steps ref names a transitive dependency of the step reading it", () => {
    expect(danglingStepRefs(templates)).toEqual([]);
  });

  test("the check discriminates — a one-character typo is reported", () => {
    // The exact mutation that proved `validateWorkflow` misses this:
    // `review-loop` → `review-lop`. It validates clean and dies at run time.
    const def = mutantOf("docs-factory");
    stepNamed(def, "write").input!.content = "$steps.review-lop.output.content";
    expect(danglingStepRefs([def])).toEqual([
      "docs-factory.write.input -> $steps.review-lop.output.content",
    ]);
    expect(validateWorkflow(asLoaderWouldName(def))).toEqual([]);
  });

  test("the check discriminates — reading a step that is not upstream is reported", () => {
    // Not a typo: a real step, but one the executor may run in the same
    // batch. `$steps` refs and `dependsOn` are INDEPENDENT in this engine —
    // nothing makes a reader declare what it reads — so ordering bugs are
    // otherwise only found by running the graph.
    const def = mutantOf("etl-factory");
    delete stepNamed(def, "report").dependsOn;
    // Three, not two: `skippedJson` is a `{{…}}` template, and the
    // template reader finds the same ref the direct `skipped` mapping
    // carries. That both are reported is the point — the C7 spec calls a
    // ref inside a transform template "the ref the validator cannot see".
    expect(danglingStepRefs([def]).sort()).toEqual([
      "etl-factory.report.output -> $steps.classify.output",
      "etl-factory.report.output -> $steps.ingest.output.skipped",
      "etl-factory.report.output -> $steps.ingest.output.skipped",
    ]);
    // And the validator says nothing about any of them.
    expect(validateWorkflow(asLoaderWouldName(def))).toEqual([]);
  });

  test("every $input ref names a declared inputSchema field", () => {
    // A `$input.x` ref is LENIENT — an unset field resolves to `undefined`
    // and the key is still passed on. So a typo here is silent: the tool or
    // agent simply never receives the value.
    expect(undeclaredInputRefs(templates)).toEqual([]);
  });

  test("the check discriminates — an undeclared input field is reported", () => {
    const def = mutantOf("etl-factory");
    stepNamed(def, "write").input!.path = "$input.outputPath";
    expect(undeclaredInputRefs([def])).toEqual([
      "etl-factory.write.input -> $input.outputPath",
    ]);
  });

  test("$loop / $result refs appear only where the grammar allows them", () => {
    expect(misplacedLoopRefs(templates)).toEqual([]);
  });

  test("the check discriminates — a $loop ref on an unlooped step is reported", () => {
    const def = mutantOf("docs-factory");
    stepNamed(def, "draft").input!.prior = "$loop.last.output";
    expect(misplacedLoopRefs([def])).toEqual([
      "docs-factory.draft.input -> $loop.last.output",
    ]);
  });
});

describe("ez-factory templates — no step declares an rbacScope", () => {
  test("not one, across all three templates", () => {
    expect(stepsDeclaringRbacScope(templates)).toEqual([]);
  });

  test("the check discriminates — one scoped approval is reported", () => {
    const def = mutantOf("draft-and-verify");
    stepNamed(def, "review").rbacScope = "approve-gate";
    expect(stepsDeclaringRbacScope([def])).toEqual(["draft-and-verify.review"]);
  });

  test("`approve-gate` IS declared in the manifest — for console buttons only", () => {
    // The scope exists; what is refused is ATTACHING it to a gate. Pinning
    // both halves keeps the next reader from "fixing" the absence by
    // deleting the declaration instead.
    const scopes = manifest.permissions?.rbacScopes as Array<{ name: string }> | undefined;
    expect(scopes?.map((s) => s.name)).toContain("approve-gate");
  });
});

describe("ez-factory templates — every agent step names a seeded agent", () => {
  test("the seeded roster is the three prefixed names", () => {
    expect(seededAgentNames).toEqual([
      "ez-factory extractor",
      "ez-factory writer",
      "ez-factory validator",
    ]);
  });

  test("no agent step names anything outside that roster", () => {
    expect(agentStepsNamingAnUnseededAgent(templates)).toEqual([]);
  });

  test("the check discriminates — an unprefixed name is reported", () => {
    // The exact regression: agent names are ONE flat global map, so a bare
    // `writer` would shadow (or be shadowed by) any user's own agent.
    const def = mutantOf("draft-and-verify");
    stepNamed(def, "revise").agent = "writer";
    expect(agentStepsNamingAnUnseededAgent([def])).toEqual([
      "draft-and-verify.revise -> writer",
    ]);
  });

  test("every agent step's name carries the ez-factory prefix", () => {
    const agentSteps = everyStep().filter((s) => stepKindOf(s) === "agent");
    expect(agentSteps.length).toBeGreaterThan(0);
    for (const step of agentSteps) {
      expect(step.agent).toStartWith(EZ_FACTORY_AGENT_PREFIX);
    }
  });

  test("all three seeded agents are actually used", () => {
    // A seeded agent no template dispatches to is a row nobody asked for.
    const used = new Set(
      everyStep()
        .filter((s) => stepKindOf(s) === "agent")
        .map((s) => s.agent),
    );
    expect([...used].sort()).toEqual([...seededAgentNames].sort());
  });
});

describe("ez-factory templates — per-step model bindings", () => {
  test("every agent step declares an effort from the closed vocabulary", () => {
    // `effort` IS shipped end to end — `WorkflowModelBinding.effort` →
    // this vocabulary → `completeSimple(..., {reasoning})` — and it is the
    // cost lever that needs no configuration at all, so every agent step
    // spends one deliberately.
    const agentSteps = everyStep().filter((s) => stepKindOf(s) === "agent");
    for (const step of agentSteps) {
      expect(VALID_MODEL_EFFORTS).toContain(step.model?.effort as (typeof VALID_MODEL_EFFORTS)[number]);
    }
  });

  test("provider and model are REFS, never hardcoded ids", () => {
    // A hardcoded `provider: anthropic` breaks every install that has not
    // configured it. An unset `$input.x` ref resolves to "no override for
    // this field" (`resolveModelOverride`), so the agent's own binding —
    // including the CURRENT_MODEL_SENTINEL inherit value — stands.
    for (const step of everyStep()) {
      if (stepKindOf(step) !== "agent") continue;
      expect(step.model?.provider).toStartWith("$input.");
      expect(step.model?.model).toStartWith("$input.");
    }
  });

  test("every agent step binds maxTokens well under the step-output cap", () => {
    // A step output over `MAX_STEP_OUTPUT_BYTES` is stored as a sentinel
    // and `resumeWorkflow` turns that into a terminal
    // `refuseTerminal("step-output-unavailable")` — which for these graphs
    // lands AFTER the LLM spend and AFTER a human answered the gate.
    // 4 bytes/token is a generous UTF-8 upper bound for LLM prose.
    const MAX_UTF8_BYTES_PER_TOKEN = 4;
    for (const step of everyStep()) {
      if (stepKindOf(step) !== "agent") continue;
      const maxTokens = step.model?.maxTokens;
      expect(typeof maxTokens).toBe("number");
      expect(maxTokens! * MAX_UTF8_BYTES_PER_TOKEN).toBeLessThan(MAX_STEP_OUTPUT_BYTES);
    }
  });
});

describe("ez-factory templates — approval gates", () => {
  const approvals = (): Array<{ def: WorkflowDefinition; step: WorkflowStep }> =>
    templates.flatMap((def) =>
      def.steps.filter((s) => stepKindOf(s) === "approval").map((step) => ({ def, step })),
    );

  test("the templates ship at least one real approval gate", () => {
    expect(approvals().length).toBeGreaterThan(0);
  });

  test("no approval prompt carries a {{…}} placeholder", () => {
    // `parkWorkflowApproval({ prompt: step.prompt ?? "" })` — stored
    // VERBATIM, never interpolated. A placeholder here reaches a human as
    // literal template source.
    expect(approvalPromptsCarryingATemplate(templates)).toEqual([]);
  });

  test("the check discriminates — one templated prompt is reported", () => {
    const def = mutantOf("draft-and-verify");
    stepNamed(def, "review").prompt = "Publish {{ $steps.verdict.output.content }}?";
    expect(approvalPromptsCarryingATemplate([def])).toEqual(["draft-and-verify.review"]);
  });

  test("every approval bounds its park and times out to abort", () => {
    // `abort` is the default, and stating it is the point: a policy that
    // decides on a human's behalf must never be reachable by omission, and
    // an edit to `approve` has to be visible in a diff.
    for (const { step } of approvals()) {
      expect(Number.isInteger(step.timeoutMs)).toBe(true);
      expect(step.timeoutMs!).toBeGreaterThan(0);
      expect(step.onTimeout).toBe("abort");
    }
  });

  test("no approval declares requireItemConsent", () => {
    // It would need an `itemsRef` resolving to an array of ids or
    // `{id}` objects. Nothing upstream produces one — `read_files` returns
    // path-keyed records and an agent step returns raw text — and
    // `resolveApprovalItemIds` is tolerant, so an unresolvable ref yields
    // an EMPTY set the guard reads as a clean gate. That is consent
    // theatre, so it is not declared.
    for (const { step } of approvals()) {
      expect(step.requireItemConsent).toBeUndefined();
      expect(step.itemsRef).toBeUndefined();
    }
  });
});

describe("ez-factory templates — tool steps", () => {
  test("every tool step targets an ez-factory tool under the host namespace", () => {
    // The registry builds `<manifest.name>__<tool.name>`; naming another
    // extension's tool here would be a cross-extension dispatch this
    // template has no business making.
    const toolSteps = everyStep().filter((s) => stepKindOf(s) === "tool");
    expect(toolSteps.length).toBeGreaterThan(0);
    for (const step of toolSteps) {
      expect(step.tool).toStartWith(`${EZ_FACTORY_EXTENSION_NAME}__`);
    }
  });

  test("the tool steps use exactly the three tools 8.4 ships", () => {
    const tools = new Set(
      everyStep()
        .filter((s) => stepKindOf(s) === "tool")
        .map((s) => s.tool),
    );
    expect([...tools].sort()).toEqual([
      "ez-factory__emit_artifact",
      "ez-factory__read_files",
      "ez-factory__write_file",
    ]);
  });

  test("no tool step carries an agent, and none is looped", () => {
    // Both are definition-time errors, and both are the kind of thing a
    // future editor adds without reading `validateWorkflow` first.
    for (const step of everyStep()) {
      if (stepKindOf(step) !== "tool") continue;
      expect(step.agent).toBeUndefined();
      expect(step.loop).toBeUndefined();
    }
  });
});

describe("ez-factory templates — dry run (the graph actually executes)", () => {
  /**
   * The strongest check in this file, and the only one that RUNS anything.
   *
   * `dryRunWorkflow` evaluates `transform` and `gate` steps for real and
   * substitutes every other kind — so no LLM, no tool dispatch, no
   * `workflow_runs` row and no approval park, but the ref language, the
   * `{{…}}` interpolation and the batching all execute against the real
   * definition. That is what catches a transform whose mapping does not
   * resolve, which no static check in this file or in `validateWorkflow`
   * can see.
   *
   * A gate whose operands came from a stub is recorded and NOT enforced,
   * which is why a clean result is `unverified` rather than `success` —
   * "nothing failed", never "the graph passes".
   */
  const inputs: Record<string, Record<string, unknown>> = {
    "docs-factory": { globs: "docs/**/*.md", outPath: "out/handbook.md" },
    "etl-factory": { globs: "data/**/*.csv", outPath: "out/report.md" },
    "draft-and-verify": { draft: "a draft", sources: "some sources" },
  };

  /**
   * The status each graph must reach, stated per template rather than
   * loosened to "not an error".
   *
   * `unverified` for the two that carry a gate reading a stubbed step —
   * the harness refuses to call an unenforced gate a pass, and a template
   * that drifted into `success` here would mean its gates stopped reading
   * anything real. `draft-and-verify` has no gate at all (the human IS the
   * decision), so `success` is the honest answer for it and asserting
   * `unverified` would be asserting a gate it deliberately does not have.
   */
  const expectedStatus: Record<string, string> = {
    "docs-factory": DRY_RUN_UNVERIFIED,
    "etl-factory": DRY_RUN_UNVERIFIED,
    "draft-and-verify": "success",
  };

  const expectNoFailure = (report: DryRunReport, name: string): void => {
    expect(report.error).toBeUndefined();
    expect(report.steps.filter((s) => s.status === "error")).toEqual([]);
    expect(report.status).toBe(expectedStatus[name]!);
  };

  test.each(Object.keys(inputs))("%s dry-runs to completion with no ref error", async (name) => {
    const report = await dryRunWorkflow(
      asLoaderWouldName(mutantOf(name)),
      inputs[name]!,
    );
    expectNoFailure(report, name);
  });

  test("the two gated templates really did evaluate a gate on stubs", () => {
    // Pins the reason the statuses above differ, so the table is a claim
    // about the graphs rather than three numbers someone tuned to green.
    for (const name of ["docs-factory", "etl-factory"]) {
      const gates = byBareName.get(name)!.steps.filter((s) => (s.kind ?? "agent") === "gate");
      expect(gates.length).toBeGreaterThan(0);
    }
    expect(
      byBareName.get("draft-and-verify")!.steps.filter((s) => (s.kind ?? "agent") === "gate"),
    ).toEqual([]);
  });

  test("the transforms really ran — they are not in the stub list", async () => {
    // If `report` had been stubbed, the `{{$steps.ingest.output.skipped}}`
    // interpolation this template's whole conditional branch depends on
    // would never have been exercised.
    const report = await dryRunWorkflow(
      asLoaderWouldName(mutantOf("etl-factory")),
      inputs["etl-factory"]!,
    );
    expect(report.stubbed).not.toContain("report");
    expect(report.steps.find((s) => s.name === "report")?.mode).toBe("evaluated");
    // And the impure ones were stood in for rather than dispatched.
    expect(report.stubbed).toContain("ingest");
    expect(report.stubbed).toContain("classify");
    expect(report.stubbed).toContain("anomaly-gate");
    expect(report.stubbed).toContain("write");
  });

  test("etl-factory's composed document interpolates — no {{…}} survives", async () => {
    // A run's result is its LAST EXECUTED step's result, and everything
    // below `report` is a stubbed tool/approval — so truncating there is
    // how the transform's own output becomes inspectable. The written
    // document is composed in that transform (a tool step's `input` never
    // interpolates), which makes this the only place the composition can
    // be checked at all.
    const def = asLoaderWouldName(mutantOf("etl-factory"));
    const cut = def.steps.findIndex((s) => s.name === "report");
    def.steps = def.steps.slice(0, cut + 1);
    const report = await dryRunWorkflow(def, inputs["etl-factory"]!);
    expect(report.error).toBeUndefined();
    const output = report.output as Record<string, string>;
    expect(output.document).toContain("Inputs skipped during ingest:");
    // A placeholder that survived means the interpolator never saw it —
    // the classic `{{ $steps… }}` typo that renders as literal source.
    expect(output.document).not.toContain("{{");
    expect(output.skippedJson).not.toContain("{{");
  });

  test("docs-factory's nested step is substituted, never dispatched", async () => {
    const report = await dryRunWorkflow(
      asLoaderWouldName(mutantOf("docs-factory")),
      inputs["docs-factory"]!,
    );
    expect(report.stubbed).toContain("review-loop");
    expect(report.steps.find((s) => s.name === "review-loop")?.mode).toBe("stubbed");
  });

  test("the dry run discriminates — an unresolvable transform ref fails it", async () => {
    // Proves the clean results above are an execution, not a no-op. A
    // `$steps` root naming no step is the one ref error that throws even
    // for a lenient condition, and `validateWorkflow` does not catch it.
    const def = asLoaderWouldName(mutantOf("etl-factory"));
    stepNamed(def, "report").output!.summary = "$steps.doesnotexist.output";
    const report = await dryRunWorkflow(def, inputs["etl-factory"]!);
    expect(report.status).toBe("error");
    expect(report.error).toContain("doesnotexist");
  });
});

describe("ez-factory templates — nesting", () => {
  /** Resolve the extension's own namespaced names against the loaded set,
   *  which is what the live merged cache does at run time. */
  const resolveNamespaced = (name: string): WorkflowDefinition | undefined => {
    for (const def of templates) {
      const named = asLoaderWouldName(def);
      if (named.name === name) return named;
    }
    return undefined;
  };

  test("docs-factory nests exactly one target: ez-factory:draft-and-verify", () => {
    const def = asLoaderWouldName(mutantOf("docs-factory"));
    const nested = def.steps.filter((s) => s.kind === "workflow").map((s) => s.workflow);
    expect(nested).toEqual(["ez-factory:draft-and-verify"]);
  });

  test("draft-and-verify nests nothing — the loop wraps a leaf graph", () => {
    const def = byBareName.get("draft-and-verify")!;
    expect(def.steps.filter((s) => s.kind === "workflow")).toEqual([]);
  });

  test("validating docs-factory against the REAL sibling still passes", () => {
    // With a resolver the closure walk actually runs: cycles and the depth
    // cap are checked against the definition that will really be nested,
    // not against an unresolved forward reference (which is deliberately
    // not an error).
    const def = asLoaderWouldName(mutantOf("docs-factory"));
    expect(validateWorkflow(def, { resolve: resolveNamespaced })).toEqual([]);
  });

  test("the closure is one level deep and resolves", () => {
    const def = asLoaderWouldName(mutantOf("docs-factory"));
    const closure = collectWorkflowClosure(def, resolveNamespaced);
    expect(closure.cycles).toEqual([]);
    expect(closure.tooDeep).toEqual([]);
    expect(closure.unresolved).toEqual([]);
    expect(closure.definitions.map((d) => d.name)).toEqual([
      "ez-factory:docs-factory",
      "ez-factory:draft-and-verify",
    ]);
    expect(closure.definitions.length).toBeLessThanOrEqual(MAX_WORKFLOW_NESTING_DEPTH + 1);
  });

  test("the cycle check discriminates — a child nesting back is named", () => {
    const child = asLoaderWouldName(mutantOf("draft-and-verify"));
    child.steps.push({
      name: "back",
      kind: "workflow",
      workflow: "ez-factory:docs-factory",
    });
    const resolve = (name: string): WorkflowDefinition | undefined =>
      name === child.name ? child : resolveNamespaced(name);
    const def = asLoaderWouldName(mutantOf("docs-factory"));
    expect(validateWorkflow(def, { resolve }).join("\n")).toContain("Nested workflow cycle");
  });
});
