import type {
  WorkflowConditionOp,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepKind,
} from "../types";

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

const VALID_KINDS: readonly WorkflowStepKind[] = ["agent", "transform", "gate"];

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

    // Bound every mapping/template value (untrusted definitions must not
    // smuggle unbounded strings into the interpolator / agent inputs).
    for (const [field, mapping] of [
      ["input", step.input],
      ["output", step.output],
    ] as const) {
      if (!mapping) continue;
      for (const [key, value] of Object.entries(mapping)) {
        if (
          typeof value === "string" &&
          value.length > MAX_MAPPING_VALUE_LENGTH
        ) {
          errors.push(
            `Step "${name}" ${field} mapping value for "${key}" exceeds the maximum length of ${MAX_MAPPING_VALUE_LENGTH} characters`,
          );
        }
      }
    }

    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!names.has(dep)) {
          errors.push(`Step "${name}" depends on unknown step "${dep}"`);
        }
      }
    }

    if (step.loop && kind === "gate") {
      errors.push(`Step "${name}" (kind "gate") cannot have a "loop"`);
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
