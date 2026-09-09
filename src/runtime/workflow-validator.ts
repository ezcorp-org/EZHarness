import type {
  WorkflowCondition,
  WorkflowConditionOp,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepKind,
} from "../types";
import { validateModelOverride } from "./workflow-model";
import { conditionRefs } from "./workflow-condition";
import { hasTemplate, templateRefs } from "./workflow-refs";
import {
  collectWorkflowClosure,
  MAX_WORKFLOW_NESTING_DEPTH,
  type WorkflowResolver,
} from "./workflow-closure";
import { isResolvableWorkflowName } from "./workflow-name";
import { getWorkflowRuntime } from "./workflow/runtime-registry";

/** Server-side clamp bounds. Loop budgets are clamped (not rejected) for
 *  out-of-range integers; retries clamp to the historical 0..2. */
export const MAX_ITERATIONS_CEILING = 25;
export const MAX_ITERATIONS_FLOOR = 1;
export const RETRIES_CEILING = 2;

/** Definition-time caps. Workflow definitions are untrusted (a chat-scoped
 *  user can submit one), so bound the surface a single definition can
 *  occupy: oversized ones are rejected at create (API 400 / loader
 *  warn-skip), never clamped. */
export const MAX_STEPS_PER_WORKFLOW = 100;
export const MAX_MAPPING_VALUE_LENGTH = 10_000;
export const MAX_CONDITION_DEPTH = 20;

const VALID_KINDS: readonly WorkflowStepKind[] = [
  "agent",
  "transform",
  "gate",
  "tool",
  "approval",
  "workflow",
];

/** The 9 leaf operators. Kept here (not just in the union type) so the
 *  definition-time validator can reject an unknown `op` before it reaches
 *  the evaluator. */
export const VALID_CONDITION_OPS: readonly WorkflowConditionOp[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "exists",
  "truthy",
];

/**
 * Validate a condition tree's SHAPE at definition time (not its runtime
 * truth). Dispatch mirrors the evaluator ({@link evaluateCondition}):
 * `all`/`any` must be non-empty arrays, `not` must be an object, otherwise
 * it is a leaf which needs a non-empty string `ref` and an `op` from the
 * 9-op enum. Recursive. Returns human-readable errors, each prefixed with
 * `label` (e.g. `Step "check" condition`). Empty ⇒ valid shape. Without
 * this a `condition: {}` passes create and then dies at run with a raw
 * `TypeError` inside the ref resolver.
 */
export function validateCondition(
  cond: unknown,
  label: string,
  depth = 0,
): string[] {
  if (depth > MAX_CONDITION_DEPTH) {
    return [
      `${label} exceeds the maximum condition nesting depth of ${MAX_CONDITION_DEPTH}`,
    ];
  }
  if (cond === null || typeof cond !== "object") {
    return [`${label} must be an object`];
  }
  const c = cond as Record<string, unknown>;

  if ("all" in c || "any" in c) {
    const key = "all" in c ? "all" : "any";
    const arr = c[key];
    if (!Array.isArray(arr) || arr.length === 0) {
      return [`${label} "${key}" must be a non-empty array`];
    }
    return arr.flatMap((child, i) =>
      validateCondition(child, `${label} ${key}[${i}]`, depth + 1),
    );
  }

  if ("not" in c) {
    return validateCondition(c.not, `${label} not`, depth + 1);
  }

  // Leaf.
  const errors: string[] = [];
  if (typeof c.ref !== "string" || c.ref.trim() === "") {
    errors.push(`${label} leaf requires a non-empty string "ref"`);
  }
  if (
    typeof c.op !== "string" ||
    !VALID_CONDITION_OPS.includes(c.op as WorkflowConditionOp)
  ) {
    errors.push(
      `${label} leaf has an invalid or missing "op" (expected one of: ${VALID_CONDITION_OPS.join(", ")})`,
    );
  }
  return errors;
}

/**
 * Validate a workflow's `outputTemplate` shape in isolation — a string
 * within the shared mapping-value length cap, referencing no ref root
 * other than `$output`. Standalone (rather than inlined into
 * `validateWorkflow`) for the same reason `validateModelOverride` is: `PUT
 * /api/workflows/[name]` is a partial update, so a body carrying only
 * `outputTemplate` has no `steps` to hand the whole-definition validator,
 * and this is what it calls directly instead. One rule either way.
 *
 * `renderOutputTemplate` is deliberately lenient at run time (a missing
 * path renders empty, never throws), so THIS is the one gate a malformed
 * template ever passes through: the only thing worth rejecting here is a
 * ref root the renderer does not resolve — `$steps`/`$prev`/`$input`/
 * `$loop`/`$result` would silently render as empty text forever, which is
 * a confusing, undebuggable form of the "I set it and nothing happened"
 * bug this module already refuses for a non-agent step's `model` binding.
 */
export function validateOutputTemplate(
  value: unknown,
  label = 'Workflow "outputTemplate"',
): string[] {
  if (typeof value !== "string") {
    return [`${label} must be a string`];
  }
  if (value.length > MAX_MAPPING_VALUE_LENGTH) {
    return [`${label} exceeds the maximum length of ${MAX_MAPPING_VALUE_LENGTH} characters`];
  }
  const errors: string[] = [];
  for (const ref of templateRefs(value)) {
    if (ref !== "$output" && !ref.startsWith("$output.")) {
      errors.push(
        `${label} references "${ref}", but the only ref root a template may use is "$output" ` +
          `(the run's own final output) — refer to "$output.<field>" or bare "$output" for the ` +
          `whole object`,
      );
    }
  }
  return errors;
}

/** Clamp a loop's declared `maxIterations` to the supported 1..25 range.
 *  Callers validate integer-ness first; this only bounds the value. A
 *  non-finite value (`NaN`, `±Infinity`) is malformed input — clamp it to
 *  the floor of 1 rather than let `NaN` short-circuit the loop into a silent
 *  zero-iteration pass (or `Infinity` run the full ceiling of expensive
 *  agent iterations). */
export function clampMaxIterations(n: number): number {
  if (!Number.isFinite(n)) return MAX_ITERATIONS_FLOOR;
  const floored = Math.floor(n);
  if (floored < MAX_ITERATIONS_FLOOR) return MAX_ITERATIONS_FLOOR;
  if (floored > MAX_ITERATIONS_CEILING) return MAX_ITERATIONS_CEILING;
  return floored;
}

/** Clamp a step's declared retry budget to 0..2. Absent / non-integer /
 *  negative ⇒ 0 (no retry). */
export function clampRetries(retries: number | undefined): number {
  if (typeof retries !== "number" || !Number.isFinite(retries)) return 0;
  const n = Math.floor(retries);
  if (n < 0) return 0;
  return n > RETRIES_CEILING ? RETRIES_CEILING : n;
}

/** The effective kind of a step (`kind` defaults to `"agent"`). */
export function stepKind(step: WorkflowStep): WorkflowStepKind {
  return step.kind ?? "agent";
}

/** The step a `$steps.<name>[.path]` ref addresses, or `undefined` for
 *  anything that is not such a ref. */
function stepNameOfRef(ref: unknown): string | undefined {
  if (typeof ref !== "string" || !ref.startsWith("$steps.")) return undefined;
  const rest = ref.slice("$steps.".length);
  const dot = rest.indexOf(".");
  const name = dot === -1 ? rest : rest.slice(0, dot);
  return name === "" ? undefined : name;
}

/**
 * Every step this step READS through `$steps.…`, from every field that can
 * carry a ref.
 *
 * The field list mirrors the resolver exactly, including the asymmetry
 * that matters: `input` values are direct refs (`resolveMapping` never
 * interpolates), while `output` values may be `{{…}}` templates
 * (`resolveOutputMapping` does). Scanning `output` as a direct ref only
 * would miss `{{ $steps.draft.output.text }}` inside a transform — which
 * the C7 spec calls out by name as the ref the validator "cannot see".
 */
function referencedStepNames(step: WorkflowStep): Set<string> {
  const names = new Set<string>();
  const add = (ref: unknown): void => {
    const name = stepNameOfRef(ref);
    if (name !== undefined) names.add(name);
  };
  for (const value of Object.values(step.input ?? {})) add(value);
  for (const value of Object.values(step.output ?? {})) {
    if (typeof value === "string" && hasTemplate(value)) {
      for (const ref of templateRefs(value)) add(ref);
      continue;
    }
    add(value);
  }
  const conditions: Array<WorkflowCondition | undefined> = [
    step.condition,
    step.when,
    step.loop?.until,
  ];
  for (const cond of conditions) {
    if (cond) for (const ref of conditionRefs(cond)) add(ref);
  }
  add(step.itemsRef);
  for (const value of Object.values(step.model ?? {})) add(value);
  return names;
}

/**
 * Every step that CAN be skipped at run time: one that declares `when`,
 * plus everything transitively suppressed by one through `dependsOn`.
 *
 * Computed to a fixpoint rather than one hop, because the executor's own
 * transitive skip is transitive — a reader two hops downstream of a `when`
 * has exactly the same problem as a direct one, and checking only the
 * direct case would leave the deeper reader to discover it at run time.
 *
 * `skipDependents: false` cuts the propagation at that step: its dependents
 * run regardless, so they are not skippable BY IT (they may still be
 * skippable through another edge, which the fixpoint handles).
 */
function skippableSteps(steps: WorkflowStep[]): Set<string> {
  const byName = new Map<string, WorkflowStep>();
  for (const step of steps) {
    if (step && typeof step.name === "string") byName.set(step.name, step);
  }
  const skippable = new Set<string>();
  for (const step of steps) {
    if (step?.when !== undefined && typeof step.name === "string") skippable.add(step.name);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of steps) {
      if (!step || typeof step.name !== "string" || skippable.has(step.name)) continue;
      for (const dep of step.dependsOn ?? []) {
        const parent = byName.get(dep);
        if (!skippable.has(dep) || parent?.skipDependents === false) continue;
        skippable.add(step.name);
        grew = true;
        break;
      }
    }
  }
  return skippable;
}

/**
 * How a nested `kind: "workflow"` target is looked up at definition time.
 *
 * Defaults to public non-extension entries in the provenance-carrying live
 * cache. User-facing callers supply their authorized resolver to validate
 * private graphs without disclosing another principal's nested names.
 *
 * Falls back to "this definition only" when nothing is registered (a
 * backend-only boot, the CLI, or the YAML loader running before web init).
 * That still catches the one cycle that is ALWAYS statically knowable — a
 * workflow nesting itself — and the executor's run-time depth counter is
 * the authoritative backstop for everything else.
 */
function definitionResolver(
  def: WorkflowDefinition,
  supplied: WorkflowResolver | undefined,
): WorkflowResolver {
  if (supplied) return supplied;
  const registered = getWorkflowRuntime();
  if (!registered) return (name) => (name === def.name ? def : undefined);
  return (name) => name === def.name ? def : registered.getCachedWorkflows?.().find(entry => entry.source !== "extension" && entry.visibility === "system" && entry.definition.name === name)?.definition;
}

export interface ValidateWorkflowOptions {
  /** Resolve a nested workflow name to its definition — see
   *  {@link definitionResolver} for the default. */
  resolve?: WorkflowResolver;
}

/**
 * Validate a workflow definition at definition time. Returns a list of
 * human-readable error strings (empty ⇒ valid). Shared by the API
 * create/update route (400 with the first message) and the YAML loader
 * (warn-and-skip). Out-of-range integer loop budgets are NOT errors — they
 * are clamped at run time; only missing / non-integer `maxIterations` is
 * rejected.
 */
export function validateWorkflow(
  def: WorkflowDefinition,
  opts?: ValidateWorkflowOptions,
): string[] {
  const errors: string[] = [];

  if (!def.name || typeof def.name !== "string" || def.name.trim() === "") {
    errors.push("Workflow must have a non-empty name");
  }
  // Checked BEFORE the steps early-return: a definition-level model
  // binding is wrong whether or not the step list is also wrong, and
  // reporting it only for well-formed step lists would hide it behind an
  // unrelated fix.
  if (def.defaultModel !== undefined) {
    errors.push(...validateModelOverride(def.defaultModel, 'Workflow "defaultModel"'));
  }
  // ── outputTemplate ──
  //
  // Same treatment as `defaultModel`, and checked before the same
  // early-return: a definition-level field is wrong (or not) independently
  // of the step list. Delegates to the standalone `validateOutputTemplate`
  // (below) — the SAME function `PUT /api/workflows/[name]` calls directly
  // for a body that carries `outputTemplate` with no `steps` (a partial
  // update has nothing to hand this whole-definition validator), exactly
  // mirroring how `validateModelOverride` is shared between the two.
  if (def.outputTemplate !== undefined) {
    errors.push(...validateOutputTemplate(def.outputTemplate));
  }
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    errors.push("Workflow must have at least one step");
    return errors;
  }
  if (def.steps.length > MAX_STEPS_PER_WORKFLOW) {
    errors.push(
      `Workflow has ${def.steps.length} steps (maximum ${MAX_STEPS_PER_WORKFLOW})`,
    );
    return errors;
  }

  const seen = new Set<string>();
  const names = new Set<string>();
  for (const step of def.steps) {
    if (step && typeof step.name === "string") names.add(step.name);
  }
  // Computed once, over the whole graph, because the rule it feeds is a
  // relation BETWEEN steps rather than a property of one.
  const skippable = skippableSteps(def.steps);

  for (const step of def.steps) {
    const name = step?.name;
    if (!name || typeof name !== "string" || name.trim() === "") {
      errors.push("Every step must have a non-empty name");
      continue;
    }
    if (seen.has(name)) {
      errors.push(`Duplicate step name "${name}"`);
    }
    seen.add(name);

    const kind = stepKind(step);
    if (!VALID_KINDS.includes(kind)) {
      errors.push(`Step "${name}" has unknown kind "${kind}"`);
    }

    if (kind === "agent" && !step.agent) {
      errors.push(`Step "${name}" (kind "agent") requires an "agent"`);
    }
    if (kind === "transform" && !step.output) {
      errors.push(`Step "${name}" (kind "transform") requires an "output" mapping`);
    }
    if (kind === "gate" && !step.condition) {
      errors.push(`Step "${name}" (kind "gate") requires a "condition"`);
    }
    if (kind === "gate" && step.condition) {
      errors.push(...validateCondition(step.condition, `Step "${name}" condition`));
    }
    if (kind === "tool" && !step.tool) {
      errors.push(`Step "${name}" (kind "tool") requires a "tool"`);
    }
    // A tool step invokes a deterministic tool; an agent step invokes an
    // LLM. Carrying both is ambiguous rather than additive, and the
    // executor dispatches on `kind` alone — so reject it at definition
    // time instead of silently ignoring one of the two.
    if (kind === "tool" && step.agent) {
      errors.push(`Step "${name}" (kind "tool") cannot also specify an "agent"`);
    }

    // ── workflow kind ──
    //
    // Without a target the executor could only fail at dispatch, halfway
    // through a graph whose earlier steps already had their effects.
    if (kind === "workflow" && !step.workflow) {
      errors.push(`Step "${name}" (kind "workflow") requires a "workflow"`);
    }
    if (kind === "workflow" && (step.agent || step.tool)) {
      errors.push(
        `Step "${name}" (kind "workflow") cannot also specify an "agent" or "tool"`,
      );
    }
    // ── The nested target is a LITERAL name, never a ref ──
    //
    // The ref language would happily resolve one — `resolveMapping` is
    // right there, and this step already uses it for `input`. Refusing is
    // the deliberate choice, and the three things it buys are all
    // structural rather than stylistic:
    //
    //   • the cycle check and the depth cap below are DEFINITION-time
    //     checks, and neither is computable against a name that is not
    //     known until the run — a cycle would then be caught only by
    //     hitting the cap, after real nested runs had applied side effects;
    //   • the definition hash and version pinning claim "this is the graph
    //     that ran", which is untrue if the graph can pick its own children;
    //   • C3's delegated-execution consent hashes the TRANSITIVE CLOSURE of
    //     nested workflows, so a human would otherwise be consenting to a
    //     graph that decides later what it calls.
    //
    // Enforced by the shared name grammar rather than by a bespoke `$`
    // check, so `$input.x`, `$steps.pick.output.name` and `{{ … }}` are all
    // rejected by the same rule that already rejects whitespace and path
    // characters — and the executor uses `step.workflow` VERBATIM as its
    // lookup key (`runNestedWorkflow`), which is what makes this the only
    // place the decision lives.
    if (kind === "workflow" && step.workflow && !isResolvableWorkflowName(step.workflow)) {
      errors.push(
        `Step "${name}" (kind "workflow") "workflow" must be a literal workflow name ` +
          `(optionally namespaced "<extension>:<name>"), not a ref or template — ` +
          `the nested graph has to be knowable from the definition`,
      );
    }

    // ── approval kind ──
    //
    // Every one of these is a structural error the executor could only
    // discover at run time — by which point the workflow has already
    // parked a human on a question with no valid answers, or suspended
    // itself with no prompt to render. Definition time is where this
    // subsystem puts structural errors, so they belong here.
    if (kind === "approval") {
      if (!step.prompt) {
        errors.push(`Step "${name}" (kind "approval") requires a "prompt"`);
      }
      if (!Array.isArray(step.choices) || step.choices.length === 0) {
        errors.push(`Step "${name}" (kind "approval") requires a non-empty "choices" array`);
      } else {
        if (step.choices.some((c) => typeof c !== "string" || c.trim() === "")) {
          errors.push(`Step "${name}" (kind "approval") has an empty or non-string choice`);
        }
        // A duplicate makes the answer ambiguous the moment anyone picks
        // it, and it would resolve into `$steps.<step>.output.choice`
        // indistinguishably.
        if (new Set(step.choices).size !== step.choices.length) {
          errors.push(`Step "${name}" (kind "approval") has duplicate choices`);
        }
      }
      if (step.agent || step.tool) {
        errors.push(`Step "${name}" (kind "approval") cannot also specify an "agent" or "tool"`);
      }
      // `requireItemConsent` without a source of items is almost
      // certainly a mistake: the guard would read an empty set as a clean
      // gate and wave every answer through ids-free, which is the exact
      // opposite of what the author asked for. Loud beats silent.
      if (step.requireItemConsent && !step.itemsRef) {
        errors.push(
          `Step "${name}" (kind "approval") sets "requireItemConsent" but no "itemsRef" — ` +
            `with no items to consent to the requirement would silently pass`,
        );
      }
      if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs <= 0)) {
        errors.push(`Step "${name}" (kind "approval") "timeoutMs" must be a positive integer`);
      }
      if (step.onTimeout !== undefined && !["abort", "approve", "skip"].includes(step.onTimeout)) {
        errors.push(
          `Step "${name}" (kind "approval") has unknown "onTimeout" "${step.onTimeout}" ` +
            `(expected abort | approve | skip)`,
        );
      }
      // `onTimeout: approve` decides on a human's behalf, so it may only
      // be reached deliberately — never as a side effect of a missing
      // timeout that some later default fills in.
      if (step.onTimeout === "approve" && step.timeoutMs === undefined) {
        errors.push(
          `Step "${name}" (kind "approval") sets "onTimeout: approve" without a "timeoutMs"`,
        );
      }
      // The timeout sweep answers with the POLICY NAME as the choice
      // (C4 §4.4), and the consent guard rejects a choice the definition
      // never declared — an answer outside the set is rejected, never
      // coerced. So `onTimeout: approve` over `choices: [ship, hold]` is
      // a policy that can only ever fail, and it would fail at 3am, on a
      // deadline, by cancelling the run instead of approving it. The
      // coupling is real; this is where it becomes visible.
      if (
        (step.onTimeout === "approve" || step.onTimeout === "skip") &&
        Array.isArray(step.choices) &&
        !step.choices.includes(step.onTimeout)
      ) {
        errors.push(
          `Step "${name}" (kind "approval") sets "onTimeout: ${step.onTimeout}" but does not ` +
            `declare "${step.onTimeout}" in its "choices" — the timeout sweep answers with the ` +
            `policy name, and an undeclared choice is rejected`,
        );
      }
    }
    // An approval step's answer is a human decision, not a retryable
    // computation: re-asking on a loop or a retry would either re-park
    // the same question or silently reuse the first answer.
    if (kind === "approval" && step.retries !== undefined) {
      errors.push(`Step "${name}" (kind "approval") cannot specify "retries"`);
    }

    // A model binding only means something where an LLM runs. On a
    // transform / gate / tool step it would be silently ignored by the
    // executor — the classic "I set it and nothing happened" bug — so
    // reject it at definition time instead.
    if (step.model !== undefined) {
      if (kind !== "agent") {
        errors.push(
          `Step "${name}" (kind "${kind}") cannot specify a "model" override — only agent steps run an LLM`,
        );
      } else {
        errors.push(...validateModelOverride(step.model, `Step "${name}" model`));
      }
    }

    // Every mapping value must be a string ref/template — the resolver
    // calls `ref.startsWith(...)` (the zod schema protects the API, but the
    // YAML loader would otherwise crash at run time on `output: { n: 42 }`)
    // — and is bounded so untrusted definitions can't smuggle unbounded
    // strings into the interpolator / agent inputs.
    for (const [field, mapping] of [
      ["input", step.input],
      ["output", step.output],
    ] as const) {
      if (!mapping) continue;
      for (const [key, value] of Object.entries(mapping)) {
        if (typeof value !== "string") {
          errors.push(
            `Step "${name}" ${field} mapping value for "${key}" must be a string ref, template or literal (got ${typeof value})`,
          );
          continue;
        }
        if (value.length > MAX_MAPPING_VALUE_LENGTH) {
          errors.push(
            `Step "${name}" ${field} mapping value for "${key}" exceeds the maximum length of ${MAX_MAPPING_VALUE_LENGTH} characters`,
          );
        }
      }
    }

    // ── control flow: `when` / `skipDependents` ──
    //
    // Same grammar as a gate's `condition`, so the same shape check —
    // a `when: {}` would otherwise pass create and die at run time inside
    // the ref resolver with a raw TypeError.
    if (step.when !== undefined) {
      errors.push(...validateCondition(step.when, `Step "${name}" when`));
    }
    // A truthy non-boolean here reads as "on" and a string "false" reads as
    // "on" too, which is the wrong default in the one place the field
    // exists to make the SAFE behaviour opt-out-able.
    if (step.skipDependents !== undefined && typeof step.skipDependents !== "boolean") {
      errors.push(`Step "${name}" "skipDependents" must be a boolean`);
    }

    // ── The skip/ref rule (C7 §1.3 rule 3) ──
    //
    // `dependsOn` and refs are INDEPENDENT today: nothing requires a step
    // reading `$steps.X` to declare `dependsOn: [X]`, and the resolver
    // never consults the graph. So `skipDependents` alone does not protect
    // an undeclared reader — it would run, hit the strict ref, and throw,
    // failing a run that C7 promises succeeds.
    //
    // Converting that into a definition-time error is what makes the
    // promise true. It only fires for steps that CAN be skipped, so no
    // graph that predates `when` is affected.
    const declaredDeps = new Set(step.dependsOn ?? []);
    for (const target of referencedStepNames(step)) {
      if (!skippable.has(target) || declaredDeps.has(target) || target === name) continue;
      errors.push(
        `Step "${name}" references $steps."${target}", which can be SKIPPED, ` +
          `without declaring dependsOn: ["${target}"] — a skipped step produces ` +
          `no result, so the reference would fail at run time`,
      );
    }

    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (dep === name) {
          // Would otherwise pass create and then fail EVERY run with a
          // "Circular dependency" error — reject at definition time.
          errors.push(`Step "${name}" cannot depend on itself`);
        } else if (!names.has(dep)) {
          errors.push(`Step "${name}" depends on unknown step "${dep}"`);
        }
      }
    }

    // `loop` is supported on `agent`, `transform` and `workflow`. A gate
    // has no result to iterate on; a `tool` step would repeat a
    // side-effecting call (install / write / shell) N times with no LLM in
    // the middle to notice it went wrong — still out of scope, and rejected
    // LOUDLY here rather than silently mis-dispatched by `runLoop`.
    //
    // `workflow` joined the allow list in C7 and the `tool` ban did NOT
    // loosen: what a looped nested run repeats is a GRAPH with an LLM or a
    // gate in it, which is bounded re-execution (fix → re-validate). The
    // nested graph may itself contain a tool step; the bound that matters
    // is that the loop wraps a decision, not a bare install/write/shell.
    if (step.loop && (kind === "gate" || kind === "tool" || kind === "approval")) {
      errors.push(`Step "${name}" (kind "${kind}") cannot have a "loop"`);
    }
    if (step.loop && step.retries !== undefined) {
      errors.push(`Step "${name}" cannot combine "loop" and "retries" (mutually exclusive)`);
    }
    if (step.loop) {
      const m = step.loop.maxIterations;
      if (typeof m !== "number" || !Number.isInteger(m)) {
        errors.push(`Step "${name}" loop requires an integer "maxIterations"`);
      }
      if (step.loop.until) {
        errors.push(
          ...validateCondition(step.loop.until, `Step "${name}" loop until`),
        );
      }
    }
  }

  // ── Nesting: cycles and depth, at DEFINITION time ──
  //
  // A cycle would otherwise be discovered by the run-time depth counter
  // after three real child runs had already executed — with their side
  // effects. Naming the loop here is the difference between "your graph is
  // wrong, here it is" and "run 4 died at depth 4".
  //
  // An UNRESOLVED nested name is deliberately NOT an error: a resolver only
  // sees the world as it is right now, and rejecting a forward reference
  // would make "create the parent, then the child" impossible. The run-time
  // lookup reports it, loudly, when it actually matters.
  const closure = collectWorkflowClosure(def, definitionResolver(def, opts?.resolve));
  for (const cycle of closure.cycles) {
    errors.push(`Nested workflow cycle: ${cycle.join(" -> ")}`);
  }
  for (const deep of new Set(closure.tooDeep)) {
    errors.push(
      `Nested workflow "${deep}" is more than ${MAX_WORKFLOW_NESTING_DEPTH} levels below "${def.name}"`,
    );
  }

  return errors;
}
