import type { WorkflowDefinition, WorkflowStep, WorkflowStepKind } from "../types";

/** Server-side clamp bounds. Loop budgets are clamped (not rejected) for
 *  out-of-range integers; retries clamp to the historical 0..2. */
export const MAX_ITERATIONS_CEILING = 25;
export const MAX_ITERATIONS_FLOOR = 1;
export const RETRIES_CEILING = 2;

const VALID_KINDS: readonly WorkflowStepKind[] = ["agent", "transform", "gate"];

/** Clamp a loop's declared `maxIterations` to the supported 1..25 range.
 *  Callers validate integer-ness first; this only bounds the value. */
export function clampMaxIterations(n: number): number {
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
    }
  }

  return errors;
}
