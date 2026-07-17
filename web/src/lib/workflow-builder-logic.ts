/**
 * Pure builder logic for WorkflowBuilder.svelte / WorkflowStepForm.svelte.
 * Kept framework-free so it is unit-testable at 100% (the `.svelte`
 * components stay thin bindings over these functions). Mirrors the
 * definition-time rules the server enforces in `workflow-validator.ts`,
 * but for the client-side form UX (immediate feedback before POST).
 */

export type StepKind = "agent" | "transform" | "gate";

export interface Pair {
  key: string;
  value: string;
}

export interface StepDraft {
  name: string;
  kind: StepKind;
  agent: string;
  inputPairs: Pair[];
  outputPairs: Pair[];
  conditionText: string;
  dependsOn: string[];
  loopEnabled: boolean;
  maxIterations: number;
  untilText: string;
  onExhausted: "fail" | "pass";
  retries: number;
}

/** A fresh, empty `agent` step draft with an auto-generated name. */
export function blankStep(index: number): StepDraft {
  return {
    name: `step-${index + 1}`,
    kind: "agent",
    agent: "",
    inputPairs: [],
    outputPairs: [],
    conditionText: "",
    dependsOn: [],
    loopEnabled: false,
    maxIterations: 3,
    untilText: "",
    onExhausted: "fail",
    retries: 0,
  };
}

/** Collapse key/value pairs into a record, trimming keys and dropping blanks
 *  (last duplicate key wins). */
export function pairsToRecord(pairs: Pair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (key) out[key] = pair.value;
  }
  return out;
}

/** Parse a JSON field (gate condition / loop until). Empty ⇒ `{ ok: true,
 *  value: undefined }`; invalid JSON ⇒ `{ ok: false, error }`. */
export function parseJsonField(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
}

/** Build the API payload for one step from its draft. Throws a string
 *  error (surfaced by the form) on a malformed gate/loop JSON field. */
export function stepToPayload(step: StepDraft): Record<string, unknown> {
  const out: Record<string, unknown> = { name: step.name };
  if (step.kind !== "agent") out.kind = step.kind;

  if (step.kind === "agent") {
    out.agent = step.agent;
    const input = pairsToRecord(step.inputPairs);
    if (Object.keys(input).length > 0) out.input = input;
    if (!step.loopEnabled && step.retries > 0) out.retries = step.retries;
  } else if (step.kind === "transform") {
    // No `input` on a transform: the executor never reads it (the editor is
    // hidden for this kind too) — emitting it would be dead payload.
    out.output = pairsToRecord(step.outputPairs);
  } else {
    const parsed = parseJsonField(step.conditionText);
    if (!parsed.ok) throw `Step "${step.name}": condition is not valid JSON`;
    out.condition = parsed.value;
  }

  if (step.dependsOn.length > 0) out.dependsOn = step.dependsOn;

  if (step.loopEnabled && step.kind !== "gate") {
    const loop: Record<string, unknown> = {
      maxIterations: step.maxIterations,
      onExhausted: step.onExhausted,
    };
    const until = parseJsonField(step.untilText);
    if (!until.ok) throw `Step "${step.name}": loop until-condition is not valid JSON`;
    if (until.value !== undefined) loop.until = until.value;
    out.loop = loop;
  }

  return out;
}

/** On step rename, retarget every sibling's `dependsOn` entry from the old
 *  name to the new one — otherwise a rename silently orphans the references
 *  (mirrors {@link pruneDependsOn} for removal). */
export function remapDependsOn(
  steps: Pick<StepDraft, "dependsOn">[],
  oldName: string,
  newName: string,
): void {
  if (oldName === newName) return;
  for (const step of steps) {
    step.dependsOn = step.dependsOn.map((d) => (d === oldName ? newName : d));
  }
}

/** On step removal, drop the removed step's name from every remaining
 *  sibling's `dependsOn`. */
export function pruneDependsOn(
  steps: Pick<StepDraft, "dependsOn">[],
  removedName: string,
): void {
  for (const step of steps) {
    step.dependsOn = step.dependsOn.filter((d) => d !== removedName);
  }
}

/**
 * Validate the whole builder and build the create payload. Returns
 * `{ error }` (first failure) or `{ error: null, payload }`. Mirrors the
 * server rules for the fields the form can express.
 */
export function buildWorkflowPayload(
  name: string,
  description: string,
  steps: StepDraft[],
): { error: string } | { error: null; payload: Record<string, unknown> } {
  if (!name.trim()) return { error: "Workflow name is required" };
  if (steps.length === 0) return { error: "At least one step is required" };

  const seen = new Set<string>();
  for (const step of steps) {
    if (!step.name.trim()) return { error: "Each step needs a name" };
    if (seen.has(step.name)) return { error: `Duplicate step name "${step.name}"` };
    seen.add(step.name);
    if (step.kind === "agent" && !step.agent) {
      return { error: `Step "${step.name}" (agent) needs an agent` };
    }
    if (step.kind === "transform" && Object.keys(pairsToRecord(step.outputPairs)).length === 0) {
      return { error: `Step "${step.name}" (transform) needs an output mapping` };
    }
    if (step.kind === "gate" && !step.conditionText.trim()) {
      return { error: `Step "${step.name}" (gate) needs a condition` };
    }
  }

  let stepPayloads: Record<string, unknown>[];
  try {
    stepPayloads = steps.map(stepToPayload);
  } catch (e) {
    return { error: typeof e === "string" ? e : "Invalid step configuration" };
  }

  return {
    error: null,
    payload: {
      name: name.trim(),
      description: description.trim(),
      steps: stepPayloads,
    },
  };
}
