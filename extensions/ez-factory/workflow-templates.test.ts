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

import type {
  AgentConfig,
  AgentContext,
  AgentResult,
  WorkflowCondition,
  WorkflowDefinition,
  WorkflowStep,
} from "../../src/types";
import { configToAgent } from "../../src/runtime/config-to-agent";
import { validateWorkflow } from "../../src/runtime/workflow-validator";
import { loadExtensionWorkflows } from "../../src/runtime/workflow-extension-loader";
import { namespacedWorkflowName } from "../../src/runtime/workflow-name";
import {
  collectWorkflowClosure,
  MAX_WORKFLOW_NESTING_DEPTH,
} from "../../src/runtime/workflow-closure";
import { MAX_STEP_OUTPUT_BYTES } from "../../src/runtime/workflow-step-output";
import { VALID_MODEL_EFFORTS } from "../../src/runtime/workflow-model";
import { hasTemplate, resolveMapping, templateRefs } from "../../src/runtime/workflow-refs";
import { conditionRefs, evaluateCondition } from "../../src/runtime/workflow-condition";
import type { RefContext } from "../../src/runtime/workflow-refs";
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
import { isFactoryWorkflow, JOB_SETTABLE_INPUT_KEYS } from "./lib/jobs";

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

/**
 * A `gate`'s `condition` or ANY step's `when` that reads `$input.*`.
 *
 * Binding rule, and the reason is mechanical rather than stylistic.
 * `resolveConditionRef` resolves `$input.<field>` LENIENTLY — an absent
 * field is `undefined`, not an error — and `undefined` fails `eq`, `gt`,
 * `exists` and `truthy` alike. So a review gate guarded by
 * `when: {ref: $input.needsReview, op: eq, value: true}` is skipped both by
 * an operator who supplies `false` AND by one who merely omits the key. A
 * human-review gate an operator can disable by omission is not a gate.
 *
 * `$steps.*` is the opposite: an unresolvable ROOT throws, so a guard over
 * a step result fails loudly instead of silently deciding a branch.
 */
const controlFlowReadingInput = (defs: WorkflowDefinition[]): string[] =>
  defs.flatMap((def) =>
    def.steps.flatMap((step) =>
      refsOf(step)
        .filter(
          (r) =>
            (r.field === "when" || r.field === "condition") && r.ref.startsWith("$input."),
        )
        .map((r) => `${def.name}.${r.step}.${r.field} -> ${r.ref}`),
    ),
  );

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
    // Severing ONE edge orphans every ref that reached `ingest` through
    // it, downstream steps included — which is what a real ordering bug
    // looks like. All four refs inside the single `{{…}}`-bearing
    // `document` value are reported too: the C7 spec calls a ref inside a
    // transform template "the ref the validator cannot see".
    expect(danglingStepRefs([def]).sort()).toEqual([
      "etl-factory.anomaly-gate.when -> $steps.ingest.output.skippedCount",
      "etl-factory.consent.when -> $steps.ingest.output.skippedCount",
      "etl-factory.report.output -> $steps.classify.output",
      "etl-factory.report.output -> $steps.ingest.output.fileCount",
      "etl-factory.report.output -> $steps.ingest.output.skipped",
      "etl-factory.report.output -> $steps.ingest.output.skippedCount",
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

  test("no gate condition or when reads $input.* — control flow reads $steps only", () => {
    // `$input.*` is LENIENT in a condition: an omitted key resolves to
    // `undefined`, which fails every operator. A gate guarded that way is
    // turned off by an operator who simply leaves the field blank.
    expect(controlFlowReadingInput(templates)).toEqual([]);
  });

  test("the check discriminates — a gate guarded on $input is reported", () => {
    const def = mutantOf("etl-factory");
    stepNamed(def, "anomaly-gate").when = {
      ref: "$input.needsReview",
      op: "eq",
      value: true,
    };
    expect(controlFlowReadingInput([def])).toEqual([
      "etl-factory.anomaly-gate.when -> $input.needsReview",
    ]);
    // And `validateWorkflow` is silent about it, which is why this guard
    // has to exist here.
    expect(validateWorkflow(asLoaderWouldName(def))).toEqual([]);
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

describe("ez-factory templates — the job store's input allowlist", () => {
  /**
   * The keys a SAVED JOB may set — IMPORTED from `lib/jobs.ts`, never
   * restated. The import is the anti-drift mechanism: while this file
   * carried its own copy the two disagreed (the copy still listed
   * `etl-factory.now`, which the store had already dropped) and every
   * assertion below kept passing against the stale copy.
   *
   * The store refuses a job at SAVE time for an unlisted key, so the
   * property that actually matters is one-directional: every input a
   * template REQUIRES has to be settable, or no job targeting it can ever
   * be saved in a runnable state. The converse is not a defect — a
   * template may declare inputs a job cannot set (see `draft-and-verify`).
   */
  const jobSettable = JOB_SETTABLE_INPUT_KEYS;

  /** The allowlist for a template, looked up through the store's own type
   *  guard. The narrowing is the point: an asset whose bare name is not in
   *  `FACTORY_WORKFLOWS` has no allowlist at all, and a job targeting it
   *  could never be saved — so a rename on either side throws here rather
   *  than reading `undefined` and vacuously passing. */
  const settableFor = (name: string): readonly string[] => {
    if (!isFactoryWorkflow(name)) {
      throw new Error(`template "${name}" is not one of FACTORY_WORKFLOWS`);
    }
    return jobSettable[name];
  };

  const requiredKeys = (def: WorkflowDefinition): string[] =>
    Object.entries(def.inputSchema ?? {})
      .filter(([, field]) => field.required === true)
      .map(([key]) => key)
      .sort();

  test("every REQUIRED input of every template is job-settable", () => {
    for (const def of templates) {
      const missing = requiredKeys(def).filter((k) => !settableFor(def.name).includes(k));
      expect({ workflow: def.name, missing }).toEqual({ workflow: def.name, missing: [] });
    }
  });

  test("the check discriminates — a new required input outside the list is reported", () => {
    const def = mutantOf("docs-factory");
    def.inputSchema!.reviewer = { type: "string", label: "Reviewer", required: true };
    const missing = requiredKeys(def).filter((k) => !settableFor("docs-factory").includes(k));
    expect(missing).toEqual(["reviewer"]);
  });

  test("draft-and-verify's loop-carried inputs are declared but NOT job-settable", () => {
    // `priorContent` / `priorVerdict` are supplied by `docs-factory`'s
    // nested-step `input` mapping through `$loop.last.*`, resolved by the
    // executor — they never pass through the job store. Declared because
    // `inputSchema` documents the whole input contract, optional because a
    // standalone first pass has no prior.
    const def = byBareName.get("draft-and-verify")!;
    for (const key of ["priorContent", "priorVerdict"]) {
      expect(def.inputSchema?.[key]).toBeDefined();
      expect(def.inputSchema?.[key]?.required).toBeUndefined();
      expect(jobSettable["draft-and-verify"]).not.toContain(key);
    }
  });

  test("no template declares a model-tier input — the store keeps those off the list", () => {
    // The job store excludes model keys deliberately: a template CAN bind a
    // model by ref, so a job-settable model key could downgrade a
    // verification step. These templates bind no model at all, which closes
    // the same hole from the other side.
    for (const def of templates) {
      for (const key of Object.keys(def.inputSchema ?? {})) {
        expect(key).not.toMatch(/provider|model/i);
      }
    }
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

  test("no agent step binds provider or model — effort and maxTokens only", () => {
    // Two failure modes, one rule. A LITERAL `provider: anthropic` breaks
    // every install that has not configured anthropic. A `$input.*` REF
    // makes the step's model settable by whoever supplies the input — and
    // `draft-and-verify`'s `verify` step is the CHECK, so a caller able to
    // point it at a weaker model quietly disables the verification while
    // the graph still reports a pass. `ez-factory`'s job store keeps model
    // keys off its closed input allowlist for that reason; declaring the
    // ref here would ask for the capability that layer refuses.
    //
    // Omitting both fields leaves each seeded agent's own binding standing
    // (`CURRENT_MODEL_SENTINEL` — whatever the operator configured), which
    // is what makes these templates portable across installs.
    for (const step of everyStep()) {
      if (stepKindOf(step) !== "agent") continue;
      expect(Object.keys(step.model ?? {}).sort()).toEqual(["effort", "maxTokens"]);
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

// ── What gets WRITTEN to the operator's file ────────────────────────
//
// `ez-factory__write_file` puts its `content` argument on disk under a
// path the operator chose, usually with a `.md` on the end. So `content`
// has to resolve to the DOCUMENT — a string.
//
// An agent step does not produce one. All three seeded agents are
// `outputFormat: "json"` (`src/extensions/ez-factory-agents.ts`), so
// `configToAgent` puts `JSON.parse` between the model and the step and
// `$steps.<agentStep>.output` is an OBJECT — for the writer, the
// `{draft, gaps}` envelope its contract declares.
//
// Nothing downstream refuses the wrong type. `requireContent`
// (`lib/tools/shared.ts`) accepts an object and `JSON.stringify(raw, null, 2)`s
// it, so the run finishes `success` having written
// `{"gaps":[…],"draft":"…"}` — the document escaped inside a string field —
// into a file named `.md`. That is not a hypothetical: `docs-factory`
// shipped exactly this ref and produced exactly that file on its first
// real run (`519e3bc4`, 666 bytes of JSON) before it was corrected here.
//
// The ref was CORRECT when it was written — an agent step's output was the
// raw LLM text then — and was falsified by seeding the agents
// `outputFormat: "json"`, an edit in a different file that no test tied
// back to these templates. This block is that tie.
describe("ez-factory templates — write_file publishes a document, not an envelope", () => {
  /** `$steps.<step>.output.<a>.<b>` → `{ step, fields: ["a","b"] }`.
   *  `null` for anything that is not a `$steps` ref (a literal, `$input`,
   *  `$loop`, `$result`). */
  function parseStepsRef(ref: string): { step: string; fields: string[] } | null {
    if (!ref.startsWith("$steps.")) return null;
    const parts = ref.slice("$steps.".length).split(".");
    const step = parts[0];
    if (step === undefined || parts[1] !== "output") return null;
    return { step, fields: parts.slice(2) };
  }

  /**
   * Follow a ref back to the step that actually PRODUCES its value,
   * hopping the two indirections the templates use: a `transform`'s
   * `output` mapping, and a `workflow` step (whose result is the nested
   * graph's last step — the same thing the executor serves for
   * `$result.output.…`).
   *
   * Returns the producing step, the definition it lives in, and the field
   * path still outstanding at that point. An empty `fields` at an `agent`
   * producer is the bug: it means the WHOLE parsed object was taken.
   */
  //
  // `lookup` is the set being CHECKED, never the module-level shipped map:
  // a nested hop that resolved against the shipped assets would ignore a
  // mutation applied to the callee and report clean, which is precisely
  // how a discrimination case passes without discriminating. (It did, on
  // the first draft of this resolver.)
  function resolveProducer(
    lookup: ReadonlyMap<string, WorkflowDefinition>,
    def: WorkflowDefinition,
    ref: string,
    hops = 0,
  ): { def: WorkflowDefinition; step: WorkflowStep; fields: string[] } | null {
    if (hops > 8) return null; // cycle guard; these graphs nest one level
    const parsed = parseStepsRef(ref);
    if (parsed === null) return null;
    const step = def.steps.find((s) => s.name === parsed.step);
    if (step === undefined) return null;
    const kind = stepKindOf(step);

    if (kind === "transform") {
      const next = step.output?.[parsed.fields[0] ?? ""];
      if (typeof next !== "string") return { def, step, fields: parsed.fields };
      return resolveProducer(lookup, def, next, hops + 1) ?? { def, step, fields: parsed.fields };
    }

    if (kind === "workflow") {
      // The nested name is namespaced by the template; the assets are
      // indexed by their BARE declared name.
      const bare = (step.workflow ?? "").split(":").pop() ?? "";
      const nested = lookup.get(bare);
      const last = nested?.steps.at(-1);
      if (nested === undefined || last === undefined) return { def, step, fields: parsed.fields };
      const next = last.output?.[parsed.fields[0] ?? ""];
      if (typeof next !== "string") return { def: nested, step: last, fields: parsed.fields };
      return (
        resolveProducer(lookup, nested, next, hops + 1) ?? {
          def: nested,
          step: last,
          fields: parsed.fields,
        }
      );
    }

    return { def, step, fields: parsed.fields };
  }

  const lookupOf = (defs: WorkflowDefinition[]): ReadonlyMap<string, WorkflowDefinition> =>
    new Map(defs.map((d) => [d.name, d]));

  /**
   * Every `write_file` `content` ref that bottoms out in a WHOLE agent
   * step output, reported as `"<def>.<step>.content -> <def>.<step>"`.
   *
   * Returns a verdict rather than asserting, so the same predicate can be
   * pointed at a deliberately-broken copy below and shown to answer
   * differently.
   */
  const publishedContentTakingAWholeAgentOutput = (defs: WorkflowDefinition[]): string[] => {
    const offenders: string[] = [];
    const lookup = lookupOf(defs);
    for (const def of defs) {
      for (const step of def.steps) {
        if (stepKindOf(step) !== "tool") continue;
        if (step.tool !== `${EZ_FACTORY_EXTENSION_NAME}__write_file`) continue;
        const ref = step.input?.content;
        if (typeof ref !== "string" || !ref.startsWith("$steps.")) continue;
        const producer = resolveProducer(lookup, def, ref);
        if (producer === null) continue;
        if (stepKindOf(producer.step) === "agent" && producer.fields.length === 0) {
          offenders.push(
            `${def.name}.${step.name}.content -> ${producer.def.name}.${producer.step.name}`,
          );
        }
      }
    }
    return offenders;
  };

  test("no shipped template writes a whole agent output to a file", () => {
    expect(publishedContentTakingAWholeAgentOutput(templates)).toEqual([]);
  });

  test("the check discriminates — the pre-fix ref is reported by name", () => {
    // Exactly what `draft-and-verify` shipped before the first real run
    // exposed it: the final transform handing on the writer's whole
    // `{draft, gaps}` object as `content`.
    const mutant = mutantOf("draft-and-verify");
    const verdict = stepNamed(mutant, "verdict");
    verdict.output = { ...verdict.output, content: "$steps.revise.output" };
    const defs = templates.map((d) => (d.name === "draft-and-verify" ? mutant : d));
    expect(publishedContentTakingAWholeAgentOutput(defs)).toEqual([
      "docs-factory.write.content -> draft-and-verify.revise",
    ]);
  });

  test("docs-factory's published content resolves across the nested graph to a FIELD of the writer's output", () => {
    // Pins the whole chain, not just the endpoint: docs-factory's `write`
    // reads the loop's `content`, the loop is `draft-and-verify`, and that
    // graph's last step maps `content` onto a sub-path of the `revise`
    // agent's parsed object.
    const docs = byBareName.get("docs-factory")!;
    const ref = stepNamed(docs, "write").input?.content;
    expect(ref).toBe("$steps.review-loop.output.content");
    const producer = resolveProducer(lookupOf(templates), docs, ref as string);
    expect(producer).not.toBeNull();
    expect(producer!.def.name).toBe("draft-and-verify");
    expect(producer!.step.name).toBe("revise");
    expect(stepKindOf(producer!.step)).toBe("agent");
    expect(producer!.fields).toEqual(["draft"]);
  });

  test("the check discriminates through a TRANSFORM too — etl-factory's composer", () => {
    // The nested-workflow hop reads the callee's last-step mapping inline,
    // so `docs-factory`'s chain alone never exercises the standalone
    // `transform` branch — disabling that branch left every other case in
    // this block green (measured, not assumed). `etl-factory` is the arm
    // that needs it: its `write` reads `$steps.report.output.document` and
    // `report` is a transform. Point that transform at a bare agent output
    // and the guard has to say so.
    const mutant = mutantOf("etl-factory");
    const report = stepNamed(mutant, "report");
    report.output = { ...report.output, document: "$steps.classify.output" };
    const defs = templates.map((d) => (d.name === "etl-factory" ? mutant : d));
    expect(publishedContentTakingAWholeAgentOutput(defs)).toEqual([
      "etl-factory.write.content -> etl-factory.classify",
    ]);
  });

  test("the resolver really hops both indirections — it is not matching a literal", () => {
    // Without the `workflow` hop the chain stops at `review-loop`; without
    // the `transform` hop it stops at `verdict`. Neither is an agent step,
    // so a resolver that did not hop would report nothing and the guard
    // above would be vacuously green. Prove each hop is taken.
    const docs = byBareName.get("docs-factory")!;
    expect(stepKindOf(stepNamed(docs, "review-loop"))).toBe("workflow");
    const dav = byBareName.get("draft-and-verify")!;
    expect(stepKindOf(dav.steps.at(-1)!)).toBe("transform");
    // A ref resolved one hop at a time lands somewhere different each time.
    const oneHop = resolveProducer(lookupOf(templates), docs, "$steps.draft.output.draft");
    expect(oneHop!.step.name).toBe("draft");
    expect(oneHop!.fields).toEqual(["draft"]);
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
    expect(report.stubbed).toContain("write");
    // `anomaly-gate` is SKIPPED here, not stubbed: its guard reads
    // `$steps.ingest.output.skippedCount`, `ingest` is a stub, and `gt` on
    // a non-number is false. A dry run therefore takes the CLEAN side — it
    // never fabricates a reason to ask a human — which is also why the
    // branch tests below substitute the guard to reach the other side.
    expect(report.stubbed).not.toContain("anomaly-gate");
    expect(statusIn(report, "anomaly-gate")).toBe("skipped");
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
    expect(output.document).toContain("file(s) read,");
    expect(output.document).toContain("skipped.");
    // A placeholder that survived means the interpolator never saw it —
    // the classic `{{ $steps… }}` typo that renders as literal source.
    expect(output.document).not.toContain("{{");
  });

  // ── The conditional-approval branch, executed both ways ────────────
  //
  // The shipped guard is `$steps.ingest.output.skippedCount gt 0`, and
  // `ingest` is a TOOL — stubbed in a dry run. A stub answers every path
  // with another stub, and `gt` on a non-number is false, so the real
  // guard could only ever take the clean side here.
  //
  // So the mutant swaps BOTH guards for an equivalent comparison over a
  // literal-valued transform field (a mapping value that does not start
  // with `$` is passed through verbatim by the ref resolver). What that
  // buys is the TOPOLOGY — the executor's real `skipDecision`, the real
  // `skipDependents` propagation and the real `dependsOn` graph run for
  // both cases. The guard's own shape is pinned separately, below, so the
  // substitution cannot hide a change to what the templates actually read.

  const etlBranch = async (taken: boolean): Promise<DryRunReport> => {
    const def = asLoaderWouldName(mutantOf("etl-factory"));
    stepNamed(def, "report").output!.branchPin = taken ? "take" : "skip";
    const when = { ref: "$steps.report.output.branchPin", op: "eq" as const, value: "take" };
    stepNamed(def, "anomaly-gate").when = when;
    stepNamed(def, "consent").when = when;
    return dryRunWorkflow(def, inputs["etl-factory"]!);
  };

  const statusIn = (report: DryRunReport, name: string): string | undefined =>
    report.steps.find((s) => s.name === name)?.status;

  /** The same substitution the two discrimination cases below need: pin the
   *  branch to its CLEAN side so what they demonstrate is the skip
   *  topology, not a coin toss over a stub. */
  const pinCleanBranch = (def: WorkflowDefinition): void => {
    stepNamed(def, "report").output!.branchPin = "skip";
    const when = { ref: "$steps.report.output.branchPin", op: "eq" as const, value: "take" };
    stepNamed(def, "anomaly-gate").when = when;
    const consent = def.steps.find((s) => s.name === "consent");
    if (consent) consent.when = when;
  };

  test("the SHIPPED guard is a scalar count, identical on both branch steps", () => {
    // Pins what the substitution above stands in for. Two properties, both
    // load-bearing:
    //
    //   • `consent` must carry the guard BYTE-IDENTICAL to `anomaly-gate`'s
    //     or it stops skipping in lockstep, and it reads the gate's answer.
    //   • the operand is `skippedCount gt 0`, never the `skipped` ARRAY.
    //     `neq` is `!deepEq(actual, value)`, so comparing a real array
    //     against the string "[]" is unconditionally TRUE and the gate
    //     would fire on every run, clean ones included. There is no
    //     non-empty-array operator; the scalar is the only honest test.
    const def = byBareName.get("etl-factory")!;
    const guard: WorkflowCondition = {
      ref: "$steps.ingest.output.skippedCount",
      op: "gt",
      value: 0,
    };
    expect(stepNamed(def, "anomaly-gate").when).toEqual(guard);
    expect(stepNamed(def, "consent").when).toEqual(guard);
  });

  test("the shipped guard's operand is asserted before anything branches on it", () => {
    // `gt` on a non-number is false, so a `skippedCount` that stopped being
    // returned would read exactly like a clean ingest — the gate would stop
    // gating and nothing would say so. The `schema-ok` gate is what turns
    // that silence into a named failure.
    const def = byBareName.get("etl-factory")!;
    const refs = conditionRefs(stepNamed(def, "schema-ok").condition!);
    expect(refs).toContain("$steps.ingest.output.skippedCount");
  });

  test("CLEAN path: the gate is skipped and write STILL runs", async () => {
    // The whole point of the template, and the exact thing design §6.2 got
    // wrong: with `skipDependents` defaulting to true, a skipped gate takes
    // `write` and `artifact` down with it and the common case writes
    // nothing at all.
    const report = await etlBranch(false);
    expect(report.error).toBeUndefined();
    expect(statusIn(report, "anomaly-gate")).toBe("skipped");
    expect(statusIn(report, "consent")).toBe("skipped");
    expect(statusIn(report, "write")).not.toBe("skipped");
    expect(statusIn(report, "artifact")).not.toBe("skipped");
  });

  test("ANOMALOUS path: the gate is asked, and consent reads its answer", async () => {
    const report = await etlBranch(true);
    expect(report.error).toBeUndefined();
    expect(statusIn(report, "anomaly-gate")).not.toBe("skipped");
    expect(report.stubbed).toContain("anomaly-gate");
    // `consent` is a real gate over the stubbed answer, so its verdict is
    // recorded and NOT enforced — which is why the run still completes.
    expect(report.gatesOnStubs.map((g) => g.name)).toContain("consent");
    expect(statusIn(report, "write")).not.toBe("skipped");
  });

  test("discrimination — design §6.2's default skipDependents kills the clean path", async () => {
    const def = asLoaderWouldName(mutantOf("etl-factory"));
    pinCleanBranch(def);
    delete stepNamed(def, "anomaly-gate").skipDependents;
    delete stepNamed(def, "consent").skipDependents;
    const report = await dryRunWorkflow(def, inputs["etl-factory"]!);
    // Completes "successfully" having written nothing. Silent, which is
    // what makes it worth a test rather than a comment.
    expect(report.error).toBeUndefined();
    expect(statusIn(report, "write")).toBe("skipped");
    expect(statusIn(report, "artifact")).toBe("skipped");
  });

  test("discrimination — skipDependents:false ALONE is not the fix", async () => {
    // The one-line repair (`skipDependents: false` on the gate, keep
    // `write`'s `when` reading the gate's answer) trades a silent no-op for
    // a hard failure: `write` now runs, and its `when` resolves
    // `$steps.anomaly-gate` — a STRICT root ref — against a step that
    // produced no result. `resolveConditionRef` throws, and `skipDecision`
    // deliberately never swallows a ref error out of a `when`.
    //
    // That is why the shipped template splits the branch across `consent`
    // (which carries the same `when`, so it skips in lockstep) instead.
    const def = asLoaderWouldName(mutantOf("etl-factory"));
    pinCleanBranch(def);
    def.steps = def.steps.filter((s) => s.name !== "consent");
    const write = stepNamed(def, "write");
    write.dependsOn = ["anomaly-gate", "report"];
    write.when = { ref: "$steps.anomaly-gate.output.choice", op: "neq", value: "abort" };
    // Definition-legal — this failure is invisible until the run.
    expect(validateWorkflow(def)).toEqual([]);
    const report = await dryRunWorkflow(def, inputs["etl-factory"]!);
    expect(report.status).toBe("error");
    expect(report.error).toContain("SKIPPED");
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

describe("ez-factory templates — the anomaly guard vs REAL read_files output", () => {
  /**
   * The gap this block closes.
   *
   * The dry-run branch tests SUBSTITUTE the guard with a literal
   * comparison, because `ingest` is stubbed there and `gt` on a stub is
   * always false. That proves the skip TOPOLOGY and says nothing whatever
   * about the guard — a guard that could never take the clean side would
   * pass every one of them.
   *
   * So this block takes the guard **as written in the YAML**, never
   * retyped, and runs the production `evaluateCondition` over payloads
   * shaped like `read_files`' confirmed result. A guard that stops being
   * able to fire, or starts firing on every run, fails here.
   */
  const readFilesOutput = (skippedCount: number): AgentResult => ({
    success: true,
    output: {
      root: ".",
      files: [{ path: "data/a.csv", bytes: 12, content: "col\n1\n" }],
      skipped: Array.from({ length: skippedCount }, (_, i) => ({
        path: `data/big-${i}.csv`,
        reason: "file-too-large",
      })),
      fileCount: 1,
      skippedCount,
      truncated: { depth: false, dirs: false, files: false, budget: false },
    },
  });

  const evaluateGuard = (guard: WorkflowCondition, skippedCount: number): boolean => {
    const ctx: RefContext = {
      input: {},
      stepResults: new Map([["ingest", readFilesOutput(skippedCount)]]),
    };
    return evaluateCondition(guard, ctx).passed;
  };

  /** The guard as SHIPPED — read out of the parsed template. */
  const shippedGuard = (stepName: string): WorkflowCondition =>
    stepNamed(byBareName.get("etl-factory")!, stepName).when!;

  test("a CLEAN read fires neither branch step", () => {
    // The failure this exists for: a clean run that still stops to ask a
    // human. Silent — nothing errors, the gate just always parks.
    for (const step of ["anomaly-gate", "consent"]) {
      expect({ step, fires: evaluateGuard(shippedGuard(step), 0) }).toEqual({
        step,
        fires: false,
      });
    }
  });

  test("a read that skipped something fires both", () => {
    for (const step of ["anomaly-gate", "consent"]) {
      expect({ step, fires: evaluateGuard(shippedGuard(step), 2) }).toEqual({
        step,
        fires: true,
      });
    }
  });

  test("discrimination — the array-vs-string form fires on a CLEAN read", () => {
    // `neq` is `!deepEq(actual, value)`, and a real ARRAY is never
    // deep-equal to the STRING "[]" — so this shape is unconditionally
    // true and the gate asks a human on every single run. This is the
    // exact form the guard must never take, and the assertion below is
    // what would have caught it.
    const trap: WorkflowCondition = {
      ref: "$steps.ingest.output.skipped",
      op: "neq",
      value: "[]",
    };
    expect(evaluateGuard(trap, 0)).toBe(true);
    expect(evaluateGuard(shippedGuard("anomaly-gate"), 0)).toBe(false);
  });

  test("discrimination — `exists` is no substitute; it holds for an empty array", () => {
    // The other tempting shape. `exists` is `!== undefined && !== null`,
    // and `[]` is neither — so it too fires on every run.
    const weak: WorkflowCondition = { ref: "$steps.ingest.output.skipped", op: "exists" };
    expect(evaluateGuard(weak, 0)).toBe(true);
  });

  test("the guard survives a read where everything was skipped", () => {
    // `fileCount: 1` in the fixture is incidental; the guard must key on
    // what was MISSED, not on what was read.
    expect(evaluateGuard(shippedGuard("anomaly-gate"), 5)).toBe(true);
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

// ── Ported invariant 8 — an unrecognised decision FAILS CLOSED ────────
//
// Re-homed here from `ez-code-factory/lib/runs.test.ts`
// as part of phase 9 (that tree is deleted). The reference stated it over a
// FINDINGS record: `deserializeFinding` coerced a missing / empty /
// unrecognised `action` to `ask-user`, the value that always BLOCKS, at the
// deserialization boundary rather than in app logic.
//
// **`ez-factory` v1 ships no findings model**, so the row cannot be ported
// field-for-field — `emit_artifact` takes `{name, content, runId}` and the
// validator agent returns `{valid, errors}`. What v1 DOES have is the same
// boundary wearing different clothes: a human's `choice` off an
// `ApprovalStepOutput` is the decision vocabulary, and the question is
// identical — does a value outside the vocabulary publish, or block?
//
// The shipped answer is "block", and it is bought by the SHAPE of two
// conditions in `docs-factory.workflow.yaml`:
//
//   · `review-loop.loop.until` is the NEGATIVE (`not eq revise`), so an
//     unrecognised answer EXITS the loop instead of re-asking until the
//     iteration budget runs out (`docs-factory.workflow.yaml:199-212`).
//   · `accepted` is a POSITIVE allowlist (`eq accept`), so the value that
//     just exited the loop only publishes if it is literally `accept`
//     (`:223-231`).
//
// Both are read out of the parsed YAML and evaluated with the production
// `evaluateCondition` — never retyped — so a future editor who rewrites
// either into a denylist fails a named test here rather than shipping a
// graph that writes a document nobody accepted.
describe("ez-factory templates — the decision vocabulary fails closed", () => {
  const docsFactory = byBareName.get("docs-factory")!;

  /** The `accepted` gate's condition AS SHIPPED. */
  const acceptedGate = stepNamed(docsFactory, "accepted").condition!;
  /** The `review-loop`'s `until` AS SHIPPED. */
  const loopUntil = stepNamed(docsFactory, "review-loop").loop!.until!;

  /** The choices the child approval actually declares — the whole legal
   *  vocabulary, read from the sibling template rather than retyped. */
  const declaredChoices = stepNamed(byBareName.get("draft-and-verify")!, "review").choices!;

  /** `$steps.review-loop.output.choice` = `value`, as the executor sees it
   *  once the loop has exited. `undefined` models the key being absent. */
  const afterLoop = (value: unknown): RefContext => ({
    input: {},
    stepResults: new Map([
      [
        "review-loop",
        {
          success: true,
          output: value === undefined ? {} : { choice: value },
        } as AgentResult,
      ],
    ]),
  });

  /** `$result.output.choice` = `value`, as the loop's `until` sees it. */
  const loopResult = (value: unknown): RefContext => ({
    input: {},
    stepResults: new Map(),
    result: {
      success: true,
      output: value === undefined ? {} : { choice: value },
    } as AgentResult,
  });

  /** Values that are NOT in the declared vocabulary, including the two
   *  shapes a missing projection produces. */
  const OUTSIDE_THE_VOCABULARY: unknown[] = [
    undefined, // the key never arrived
    null, // it arrived empty
    "", // the empty string — the reference's "empty action" case
    "ACCEPT", // case variant; ref resolution is case-sensitive
    " accept", // whitespace-padded
    "approve", // a plausible synonym that is NOT a declared choice
    "publish", // a fourth choice a future edit might add to the child
    true, // a mistyped boolean
    { choice: "accept" }, // double-wrapped — a projection bug
  ];

  test("the vocabulary under test is the one the child actually declares", () => {
    // Anti-vacuity for everything below: if `choices` ever went empty the
    // positive case would have nothing to assert and the negatives would
    // pass for free.
    expect(declaredChoices).toEqual(["accept", "revise", "abort"]);
    for (const bad of OUTSIDE_THE_VOCABULARY) {
      expect(declaredChoices).not.toContain(bad as string);
    }
  });

  test("ONLY `accept` opens the publish gate", () => {
    // The positive first, so the negatives below are a real separation and
    // not a gate that can never pass.
    expect(evaluateCondition(acceptedGate, afterLoop("accept")).passed).toBe(true);
    for (const declined of ["revise", "abort"]) {
      expect({ choice: declined, publishes: evaluateCondition(acceptedGate, afterLoop(declined)).passed }).toEqual({
        choice: declined,
        publishes: false,
      });
    }
  });

  test("every value OUTSIDE the vocabulary is refused by the publish gate", () => {
    // The invariant proper. An unrecognised decision must land on the
    // blocking side — the run fails naming the decisive leaf, which is the
    // honest terminal state for "nobody said yes".
    for (const bad of OUTSIDE_THE_VOCABULARY) {
      expect({ value: bad, publishes: evaluateCondition(acceptedGate, afterLoop(bad)).passed }).toEqual({
        value: bad,
        publishes: false,
      });
    }
  });

  test("an unrecognised answer EXITS the loop rather than re-asking", () => {
    // Without this half the invariant is unreachable: a value that keeps
    // the loop spinning never gets as far as the gate, and the run dies on
    // `onExhausted: fail` after paying for three more LLM passes.
    expect(evaluateCondition(loopUntil, loopResult("revise")).passed).toBe(false); // keep looping
    for (const exits of ["accept", "abort", ...OUTSIDE_THE_VOCABULARY]) {
      expect({ value: exits, exitsLoop: evaluateCondition(loopUntil, loopResult(exits)).passed }).toEqual({
        value: exits,
        exitsLoop: true,
      });
    }
  });

  test("discrimination — a DENYLIST gate publishes on an unrecognised answer", () => {
    // The exact fail-open shape this rule exists to refuse, and the reason
    // the two tests above are not tautologies. `not eq abort` reads as "any
    // answer that is not a refusal", which is how the reference's
    // `action` field would have failed open had it defaulted to `no-op`
    // instead of `ask-user`.
    const denylist: WorkflowCondition = {
      not: { ref: "$steps.review-loop.output.choice", op: "eq", value: "abort" },
    };
    expect(evaluateCondition(denylist, afterLoop("publish")).passed).toBe(true);
    expect(evaluateCondition(denylist, afterLoop(undefined)).passed).toBe(true);
    // The shipped form refuses both.
    expect(evaluateCondition(acceptedGate, afterLoop("publish")).passed).toBe(false);
    expect(evaluateCondition(acceptedGate, afterLoop(undefined)).passed).toBe(false);
  });

  test("discrimination — an `exists` gate publishes on any answer at all", () => {
    // The other tempting shape: "did the human answer?" is not the same
    // question as "did the human say yes?".
    const weak: WorkflowCondition = { ref: "$steps.review-loop.output.choice", op: "exists" };
    expect(evaluateCondition(weak, afterLoop("abort")).passed).toBe(true);
    expect(evaluateCondition(acceptedGate, afterLoop("abort")).passed).toBe(false);
  });
});

// ── What one agent step HANDS the next ──────────────────────────────
//
// The third and last member of the envelope family, and the one that fails
// SILENTLY rather than loudly.
//
// Two guards already cover the other two members, and this block is
// deliberately disjoint from both rather than a third copy of the same
// walk:
//   * "write_file publishes a document, not an envelope" — what reaches a
//     TOOL step's `content`, i.e. the operator's file.
//   * "the nested-workflow boundary" — what a `kind: "workflow"` step
//     hands a CALLEE whose own `inputSchema` says `type: text`.
//   * this one — what an `agent` step hands ANOTHER agent step, where
//     there is no file and no child schema to disagree with. The only
//     contract in the room is the receiving agent's own seeded prompt.
//
// THE INVARIANT, and the reason it is not "never hand an agent an object":
// passing a whole parsed envelope on is CORRECT in this extension when the
// receiver actually needs the extra keys, and the templates do it on
// purpose in two places with written rationales. What decides it is the
// RECEIVER's contract:
//
//   * `docs-factory`'s `facts: $steps.extract.output` stays whole. The
//     extractor returns `{facts, gaps}`, and the WRITER's seeded role says
//     verbatim "If a fact you need is missing, note the gap in the draft
//     rather than inventing it" — it needs both keys.
//   * `draft-and-verify`'s `verify` was handed the writer's whole
//     `{draft, gaps}`, and the VALIDATOR's seeded role names no use for
//     `gaps` at all: it "checks a draft against its sources" and returns
//     `errors[] = {passage, problem}` where `passage` is "the draft
//     passage at fault" — a quotation FROM a document.
//
// So the predicate is: a bare `$steps.<agentStep>.output` handed to
// another agent step is an offender exactly when the producer's declared
// contract carries a key the receiver's own prompt never asks for. Both
// halves are read out of `EZ_FACTORY_AGENTS` in
// `src/extensions/ez-factory-agents.ts`, so this is a CROSS-FILE tie:
// that file is where the falsifying edit happened last time (seeding all
// three agents `outputFormat: "json"`, which turned every agent step's
// output from raw LLM text into an object) and nothing connected it back
// to these templates.
//
// SCOPE, stated because it is a real boundary and not a convenience:
// only DIRECT agent -> agent hops with a BARE ref. A value routed through
// a `transform` is excluded because the transform's mapping is an
// arbitrary reshape — its `verdict: $steps.verify.output` key IS the
// author declaring "this whole object is the verdict", and the producer's
// contract is no longer what governs downstream. The `verdict` transform
// and `revise`'s `priorVerdict` are pinned by shape below so that
// boundary is visible rather than implied.
describe("ez-factory templates — an agent step is handed what its RECEIVER's contract asks for", () => {
  /** One seeded row, reduced to the two fields this block reads. Kept as a
   *  local shape so a mutated copy can be passed to the predicate — the
   *  same "the set under test is the set being checked" discipline the
   *  nested-workflow guard uses for its definition lookup. */
  interface SeededPrompt {
    name: string;
    prompt: string;
  }

  const shippedAgents: SeededPrompt[] = EZ_FACTORY_AGENTS.map((a) => ({
    name: a.name,
    prompt: a.prompt,
  }));

  /**
   * The top-level keys a seeded prompt declares as the object its agent
   * must return.
   *
   * Read out of the prompt TEXT — the exact string the model is given —
   * rather than from a second hand-maintained table, so it cannot drift
   * from the contract the agent is actually under. The contract lines are
   * the only ones in these prompts shaped `- "<key>":`; the steering and
   * output-format bullets are prose after their dash.
   */
  const contractKeysOf = (prompt: string): string[] =>
    [...prompt.matchAll(/^- "([A-Za-z0-9_]+)":/gm)].map((m) => m[1] as string);

  /**
   * Does `prompt` ask for `key`?
   *
   * Matched on the key's singular stem with an optional plural `s`,
   * because these prompts are PROSE and the roles say things like "note
   * the gap in the draft" (singular) for a contract key spelled `gaps`.
   * Word-boundary anchored so `valid` does not match inside "invalidate".
   */
  const promptAsksFor = (prompt: string, key: string): boolean => {
    const stem = key.endsWith("s") ? key.slice(0, -1) : key;
    return new RegExp(`\\b${stem}s?\\b`, "i").test(prompt);
  };

  const seeded = (agents: SeededPrompt[], name: string): SeededPrompt | undefined =>
    agents.find((a) => a.name === name);

  /** A BARE `$steps.<step>.output` — no sub-path. `null` for anything else,
   *  including the corrected `$steps.revise.output.draft`. */
  const bareStepOutput = (ref: string): string | null =>
    /^\$steps\.([^.]+)\.output$/.exec(ref)?.[1] ?? null;

  /**
   * Every direct agent -> agent whole-envelope hop whose receiver's own
   * contract asks for none of it, reported as
   * `"<def>.<step>.<key> -> <producerStep> (unclaimed: …)"`.
   *
   * Takes the agent set so a discrimination case can hand it a MUTATED
   * `ez-factory-agents.ts` and be shown to answer differently — a
   * predicate that read the shipped rows internally could not be shown to
   * consult them at all.
   */
  const envelopeHopsTheReceiverDoesNotAskFor = (
    defs: WorkflowDefinition[],
    agents: SeededPrompt[],
  ): string[] => {
    const offenders: string[] = [];
    for (const def of defs) {
      for (const step of def.steps) {
        if (stepKindOf(step) !== "agent") continue;
        const receiver = seeded(agents, step.agent ?? "");
        if (receiver === undefined) continue;
        for (const [key, ref] of Object.entries(step.input ?? {})) {
          if (typeof ref !== "string") continue;
          const producerName = bareStepOutput(ref);
          if (producerName === null) continue;
          const producerStep = def.steps.find((s) => s.name === producerName);
          if (producerStep === undefined || stepKindOf(producerStep) !== "agent") continue;
          const producer = seeded(agents, producerStep.agent ?? "");
          if (producer === undefined) continue;
          const unclaimed = contractKeysOf(producer.prompt).filter(
            (k) => !promptAsksFor(receiver.prompt, k),
          );
          if (unclaimed.length > 0) {
            offenders.push(
              `${def.name}.${step.name}.${key} -> ${producerStep.name} (unclaimed: ${unclaimed.join(",")})`,
            );
          }
        }
      }
    }
    return offenders;
  };

  /** The shipped rows with one agent's prompt rewritten. */
  const agentsWith = (name: string, rewrite: (p: string) => string): SeededPrompt[] =>
    shippedAgents.map((a) => (a.name === name ? { ...a, prompt: rewrite(a.prompt) } : a));

  const WRITER = `${EZ_FACTORY_AGENT_PREFIX}writer`;
  const VALIDATOR = `${EZ_FACTORY_AGENT_PREFIX}validator`;
  const EXTRACTOR = `${EZ_FACTORY_AGENT_PREFIX}extractor`;

  test("the contract reader really reads the three shipped contracts", () => {
    // Anti-vacuity for everything below: a reader that returned `[]` for
    // every prompt would make the whole block silently green.
    expect(contractKeysOf(seeded(shippedAgents, EXTRACTOR)!.prompt)).toEqual(["facts", "gaps"]);
    expect(contractKeysOf(seeded(shippedAgents, WRITER)!.prompt)).toEqual(["draft", "gaps"]);
    expect(contractKeysOf(seeded(shippedAgents, VALIDATOR)!.prompt)).toEqual(["valid", "errors"]);
  });

  test("the two prompt facts this whole block turns on", () => {
    // Stated as their own assertion rather than buried in the predicate,
    // because they are the ENTIRE reason one whole-envelope hop is correct
    // and its neighbour is a bug. If either flips, the verdicts below flip
    // with it and should — but a reader deserves to see which sentence in
    // `ez-factory-agents.ts` is load-bearing.
    const writer = seeded(shippedAgents, WRITER)!.prompt;
    const validator = seeded(shippedAgents, VALIDATOR)!.prompt;
    expect(writer).toContain("note the gap in the draft rather than inventing it");
    expect(promptAsksFor(writer, "gaps")).toBe(true);
    expect(promptAsksFor(writer, "facts")).toBe(true);
    // The validator's contract is about a document and its passages, and
    // says nothing whatever about the writer's gaps.
    expect(validator).toContain("the draft passage at fault");
    expect(promptAsksFor(validator, "draft")).toBe(true);
    expect(promptAsksFor(validator, "gaps")).toBe(false);
  });

  test("no shipped agent step is handed an envelope its receiver does not ask for", () => {
    expect(envelopeHopsTheReceiverDoesNotAskFor(templates, shippedAgents)).toEqual([]);
  });

  test("the check discriminates — the pre-fix ref is reported by name, with the unclaimed key", () => {
    // Exactly what `draft-and-verify` shipped before this fix: the CHECK
    // handed the writer's whole `{draft, gaps}` object. Observed on run
    // 49051ac8, where `verify.resolvedInput.draft` was
    // `{gaps:[…], draft:"…"}` and the validator still answered
    // `valid: true` — the silent wrong answer this guard exists for.
    const mutant = mutantOf("draft-and-verify");
    stepNamed(mutant, "verify").input!.draft = "$steps.revise.output";
    const defs = templates.map((d) => (d.name === "draft-and-verify" ? mutant : d));
    expect(envelopeHopsTheReceiverDoesNotAskFor(defs, shippedAgents)).toEqual([
      "draft-and-verify.verify.draft -> revise (unclaimed: gaps)",
    ]);
  });

  test("NON-VACUITY — the predicate does examine `facts: $steps.extract.output`, and clears it", () => {
    // The clean verdict above is not "nothing ever matches". `docs-factory`
    // really does hand a whole agent envelope to another agent step, the
    // predicate really does reach it, and it passes only because the
    // WRITER's prompt asks for both of the extractor's keys. Point the same
    // ref at a receiver whose prompt asks for neither and it is reported.
    const shipped = stepNamed(byBareName.get("docs-factory")!, "draft");
    expect(shipped.input!.facts).toBe("$steps.extract.output");
    expect(bareStepOutput(shipped.input!.facts)).toBe("extract");

    const mutant = mutantOf("docs-factory");
    stepNamed(mutant, "draft").agent = VALIDATOR;
    const defs = templates.map((d) => (d.name === "docs-factory" ? mutant : d));
    expect(envelopeHopsTheReceiverDoesNotAskFor(defs, shippedAgents)).toEqual([
      "docs-factory.draft.facts -> extract (unclaimed: facts,gaps)",
    ]);
  });

  test("THE RECEIVER IS REALLY CONSULTED — teach the validator about gaps and the report empties", () => {
    // With the broken ref in place, the ONLY thing that makes it an
    // offender is the validator's prompt not asking for `gaps`. Without
    // this case a predicate that ignored the receiver entirely would pass
    // every other test in this block identically.
    const mutant = mutantOf("draft-and-verify");
    stepNamed(mutant, "verify").input!.draft = "$steps.revise.output";
    const defs = templates.map((d) => (d.name === "draft-and-verify" ? mutant : d));
    const taught = agentsWith(
      VALIDATOR,
      (p) => `${p}\n- Read the writer's gaps and account for each one in your verdict.`,
    );
    expect(envelopeHopsTheReceiverDoesNotAskFor(defs, taught)).toEqual([]);
    // …and it is still reported against the SHIPPED rows, so the empty
    // verdict above is the patch's doing and not the mutation wearing off.
    expect(envelopeHopsTheReceiverDoesNotAskFor(defs, shippedAgents)).toHaveLength(1);
  });

  test("THE PRODUCER IS REALLY CONSULTED — drop `gaps` from the writer's contract and the report empties", () => {
    // The other half of the cross-file tie. The offending key is read from
    // the PRODUCER's declared contract, never hardcoded here: with `gaps`
    // gone from `ez-factory-agents.ts` the writer's envelope is just
    // `{draft}`, the validator does ask for a draft, and the same broken
    // ref stops being an offender.
    const mutant = mutantOf("draft-and-verify");
    stepNamed(mutant, "verify").input!.draft = "$steps.revise.output";
    const defs = templates.map((d) => (d.name === "draft-and-verify" ? mutant : d));
    const narrowed = agentsWith(WRITER, (p) =>
      p
        .split("\n")
        .filter((line) => !line.startsWith('- "gaps":'))
        .join("\n"),
    );
    expect(contractKeysOf(seeded(narrowed, WRITER)!.prompt)).toEqual(["draft"]);
    expect(envelopeHopsTheReceiverDoesNotAskFor(defs, narrowed)).toEqual([]);
  });

  test("CROSS-FILE TIE — the shipped ref addresses a key the writer's stored contract declares", () => {
    // The failure that was missed last time, in the other direction:
    // renaming the writer's `"draft"` contract key in
    // `src/extensions/ez-factory-agents.ts` would leave this YAML
    // addressing a field that no longer exists, and every static check in
    // this file would still be green. This is the one that goes red.
    const ref = stepNamed(byBareName.get("draft-and-verify")!, "verify").input!.draft;
    expect(ref).toBe("$steps.revise.output.draft");
    const producer = stepNamed(byBareName.get("draft-and-verify")!, "revise");
    expect(producer.agent).toBe(WRITER);
    expect(contractKeysOf(seeded(shippedAgents, WRITER)!.prompt)).toContain("draft");
  });

  test("SCOPE — the two deliberate whole-object decisions lie outside this predicate BY SHAPE", () => {
    // Not "the predicate happens not to flag them": the shapes that
    // exclude them are asserted, so a future edit that moves one of them
    // into this predicate's scope shows up here rather than as a surprise
    // failure above.
    const dav = byBareName.get("draft-and-verify")!;

    // 1. `verdict: $steps.verify.output` is a bare whole-object ref, but on
    //    a TRANSFORM. A transform's mapping is an arbitrary reshape and its
    //    key name IS the author declaring what the whole object is called.
    const verdict = dav.steps.at(-1) as WorkflowStep;
    expect(verdict.name).toBe("verdict");
    expect(stepKindOf(verdict)).toBe("transform");
    expect(verdict.output!.verdict).toBe("$steps.verify.output");

    // 2. `revise.priorVerdict` is how that object reaches an agent, and it
    //    is excluded twice over — a SUB-PATH, off a TRANSFORM.
    const priorVerdict = stepNamed(dav, "revise").input!.priorVerdict;
    expect(bareStepOutput(priorVerdict)).toBeNull();
    expect(stepKindOf(stepNamed(dav, "prior"))).toBe("transform");

    // 3. `docs-factory.review-loop` is the nested-workflow boundary, which
    //    the sibling guard above owns. Not an agent step, so this predicate
    //    never reaches it and the two do not duplicate each other.
    expect(stepKindOf(stepNamed(byBareName.get("docs-factory")!, "review-loop"))).toBe("workflow");
  });

  // ── The same question, put to the PRODUCTION resolver ──────────────
  //
  // Everything above reads the YAML as data. These run the real
  // `resolveMapping` and the real `configToAgent` over the shipped mapping
  // and a realistic writer result, so the claim is about what the executor
  // does rather than about what the ref looks like.

  /** `revise` has produced `output`, and `$input.sources` is set — the
   *  context `verify`'s input mapping is resolved against. */
  const afterRevise = (output: unknown): RefContext => ({
    input: { sources: "timetable.md: departs every 40 minutes from Pier 2." },
    stepResults: new Map([["revise", { success: true, output } as AgentResult]]),
  });

  const WRITER_OUTPUT = {
    draft: "# Bellhaven Ferry\n\nDeparts Pier 2 every 40 minutes.",
    gaps: ["crossing_duration"],
  };

  test("the shipped mapping resolves `draft` to the DOCUMENT — a string", () => {
    const mapping = stepNamed(byBareName.get("draft-and-verify")!, "verify").input!;
    const resolved = resolveMapping(mapping, afterRevise(WRITER_OUTPUT));
    expect(typeof resolved.draft).toBe("string");
    expect(resolved.draft).toBe(WRITER_OUTPUT.draft);
    // `sources` is the ORIGINAL input, never anything a previous step made
    // of it — the validator checks the draft against the sources, not
    // against a restatement of them.
    expect(resolved.sources).toBe("timetable.md: departs every 40 minutes from Pier 2.");
  });

  test("the pre-fix mapping resolves `draft` to the ENVELOPE — same resolver, same context", () => {
    // The paired negative, so the positive above is a separation rather
    // than a resolver that returns a string no matter what.
    const mutant = mutantOf("draft-and-verify");
    stepNamed(mutant, "verify").input!.draft = "$steps.revise.output";
    const resolved = resolveMapping(stepNamed(mutant, "verify").input!, afterRevise(WRITER_OUTPUT));
    expect(resolved.draft).toEqual(WRITER_OUTPUT);
  });

  test("the sub-path is STRICT — a writer that stops returning `draft` fails BY NAME", () => {
    // The second thing the fix buys, and it only shows up on the failure
    // path: the corrected ref throws naming the missing field, while the
    // bare form cannot fail at all — it would keep handing the validator
    // whatever shape it got.
    const noDraft = afterRevise({ gaps: ["everything"] });
    const shipped = stepNamed(byBareName.get("draft-and-verify")!, "verify").input!;
    expect(() => resolveMapping(shipped, noDraft)).toThrow(
      /field "output\.draft" is missing on step "revise"'s result/,
    );

    const mutant = mutantOf("draft-and-verify");
    stepNamed(mutant, "verify").input!.draft = "$steps.revise.output";
    expect(resolveMapping(stepNamed(mutant, "verify").input!, noDraft).draft).toEqual({
      gaps: ["everything"],
    });
  });

  test("END TO END — what the validator's model actually reads, through the real configToAgent", () => {
    // `configToAgent` renders a step's resolved input as bare `key: value`
    // lines and `JSON.stringify`s any non-string. That is the mechanism
    // that turns the envelope into something a validator cannot quote a
    // passage out of, and it is production code, so this asserts against
    // it rather than describing it.
    const validator = seeded(shippedAgents, VALIDATOR)!;
    const sent: string[] = [];
    const config: AgentConfig = {
      name: validator.name,
      description: "seeded validator",
      capabilities: ["llm"],
      prompt: validator.prompt,
      outputFormat: "json",
    };
    const ctxFor = (input: Record<string, unknown>): AgentContext =>
      ({
        input,
        llm: {
          complete: async (messages: { content: string }[]) => {
            sent.push(messages[0]!.content);
            return { text: '{"valid":true,"errors":[]}' };
          },
        },
      }) as unknown as AgentContext;

    const shipped = stepNamed(byBareName.get("draft-and-verify")!, "verify").input!;
    const mutant = mutantOf("draft-and-verify");
    stepNamed(mutant, "verify").input!.draft = "$steps.revise.output";

    const agent = configToAgent(config);
    return Promise.all([
      agent.execute(ctxFor(resolveMapping(shipped, afterRevise(WRITER_OUTPUT)))),
      agent.execute(ctxFor(resolveMapping(stepNamed(mutant, "verify").input!, afterRevise(WRITER_OUTPUT)))),
    ]).then(() => {
      const [fixed, broken] = sent as [string, string];
      // Fixed: the document arrives as itself, real newlines and all, so a
      // quoted `passage` can match it.
      expect(fixed).toContain("draft: # Bellhaven Ferry\n\nDeparts Pier 2 every 40 minutes.");
      expect(fixed).not.toContain("gaps");
      // Broken: one line of JSON with the document escaped inside a string
      // field, and the writer's self-reported gaps riding along under the
      // key the validator was told is the draft.
      expect(broken).toContain('draft: {"draft":"# Bellhaven Ferry\\n\\nDeparts Pier 2');
      expect(broken).toContain("crossing_duration");
    });
  });
});
