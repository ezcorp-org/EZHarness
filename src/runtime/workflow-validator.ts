import type {
  WorkflowConditionOp,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepKind,
} from "../types";
import { validateModelOverride } from "./workflow-model";

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

/**
 * Validate a workflow definition at definition time. Returns a list of
 * human-readable error strings (empty ⇒ valid). Shared by the API
 * create/update route (400 with the first message) and the YAML loader
 * (warn-and-skip). Out-of-range integer loop budgets are NOT errors — they
 * are clamped at run time; only missing / non-integer `maxIterations` is
 * rejected.
 */
export function validateWorkflow(def: WorkflowDefinition): string[] {
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

    // `loop` is supported on `agent` and `transform` only. A gate has no
    // result to iterate on; a `tool` step would repeat a side-effecting
    // call (install / write / shell) N times with no LLM in the middle to
    // notice it went wrong — deliberately out of scope for v1, and
    // rejected LOUDLY here rather than silently mis-dispatched by
    // `runLoop` (whose non-transform branch runs the AGENT path).
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

  return errors;
}
