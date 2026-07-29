/**
 * Pure builder logic for WorkflowBuilder.svelte / WorkflowStepForm.svelte.
 * Kept framework-free so it is unit-testable at 100% (the `.svelte`
 * components stay thin bindings over these functions). Mirrors the
 * definition-time rules the server enforces in `workflow-validator.ts`,
 * but for the client-side form UX (immediate feedback before POST).
 */

/**
 * `tool` is included because the EDITOR round-trips a saved definition
 * through this shape. A form that could not represent a `tool` step would
 * silently DELETE every tool step in a workflow the moment the user
 * pressed Save from the form tab — the builder previously modelled only
 * three kinds because it could only ever CREATE, never load.
 */
export type StepKind = "agent" | "transform" | "gate" | "tool";

export interface Pair {
  key: string;
  value: string;
}

export interface StepDraft {
  name: string;
  kind: StepKind;
  agent: string;
  /** Runtime-namespaced extension tool (`<extension>__<tool>`). */
  tool: string;
  inputPairs: Pair[];
  outputPairs: Pair[];
  conditionText: string;
  dependsOn: string[];
  loopEnabled: boolean;
  maxIterations: number;
  untilText: string;
  onExhausted: "fail" | "pass";
  retries: number;
  /**
   * Per-step model binding as raw JSON text. Carried verbatim rather than
   * decomposed into fields for the same round-trip reason as `tool`:
   * `validateModelOverride` owns the vocabulary, and a form that modelled
   * only the fields it knew about would drop the rest on save.
   */
  modelText: string;
}

/** A fresh, empty `agent` step draft with an auto-generated name. */
export function blankStep(index: number): StepDraft {
  return {
    name: `step-${index + 1}`,
    kind: "agent",
    agent: "",
    tool: "",
    inputPairs: [],
    outputPairs: [],
    conditionText: "",
    dependsOn: [],
    loopEnabled: false,
    maxIterations: 3,
    untilText: "",
    onExhausted: "fail",
    retries: 0,
    modelText: "",
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
    // Only an agent step runs an LLM, and the server rejects a `model` on
    // any other kind — so the binding is emitted here and nowhere else.
    const model = parseJsonField(step.modelText);
    if (!model.ok) throw `Step "${step.name}": model binding is not valid JSON`;
    if (model.value !== undefined) out.model = model.value;
  } else if (step.kind === "transform") {
    // No `input` on a transform: the executor never reads it (the editor is
    // hidden for this kind too) — emitting it would be dead payload.
    out.output = pairsToRecord(step.outputPairs);
  } else if (step.kind === "tool") {
    out.tool = step.tool;
    const input = pairsToRecord(step.inputPairs);
    if (Object.keys(input).length > 0) out.input = input;
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
  /** Workflow-level model binding as raw JSON text (editor only). */
  defaultModelText = "",
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
    if (step.kind === "tool" && !step.tool.trim()) {
      return { error: `Step "${step.name}" (tool) needs a tool` };
    }
  }

  let stepPayloads: Record<string, unknown>[];
  try {
    stepPayloads = steps.map(stepToPayload);
  } catch (e) {
    return { error: typeof e === "string" ? e : "Invalid step configuration" };
  }

  const defaultModel = parseJsonField(defaultModelText);
  if (!defaultModel.ok) return { error: "Workflow default model is not valid JSON" };

  return {
    error: null,
    payload: {
      name: name.trim(),
      description: description.trim(),
      steps: stepPayloads,
      ...(defaultModel.value !== undefined ? { defaultModel: defaultModel.value } : {}),
    },
  };
}

/** Render a value back into the raw-JSON text a draft field carries.
 *  `undefined` / `null` become the empty string, which is how the draft
 *  spells "absent" — never the literal `"null"`. */
function jsonFieldText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return JSON.stringify(value, null, 2);
}

/** Turn a `Record<string, string>` mapping back into ordered pairs. */
function recordToPairs(value: unknown): Pair[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).map(([key, v]) => ({
    key,
    value: typeof v === "string" ? v : String(v),
  }));
}

/**
 * The INVERSE of {@link stepToPayload} — load a saved definition into
 * form drafts.
 *
 * This function is why the draft carries `tool` and `modelText` at all.
 * The builder previously only ever CREATED, so it could model three step
 * kinds and ignore model bindings with no consequence. The editor LOADS,
 * and a form that silently dropped what it could not represent would
 * delete a user's tool steps and model bindings the first time they
 * pressed Save from the form tab — with no error anywhere.
 *
 * `stepToPayload(definitionToDrafts(def)[i])` must reproduce `def.steps[i]`
 * for every step the API accepts. Pinned by the round-trip test in
 * `workflow-builder-logic.test.ts`.
 */
export function definitionToDrafts(steps: unknown): StepDraft[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((raw, index) => {
    const step = (raw ?? {}) as Record<string, unknown>;
    const kind = (step.kind as StepKind) ?? "agent";
    const loop = (step.loop ?? undefined) as Record<string, unknown> | undefined;
    return {
      ...blankStep(index),
      name: typeof step.name === "string" ? step.name : `step-${index + 1}`,
      kind,
      agent: typeof step.agent === "string" ? step.agent : "",
      tool: typeof step.tool === "string" ? step.tool : "",
      inputPairs: recordToPairs(step.input),
      outputPairs: recordToPairs(step.output),
      conditionText: jsonFieldText(step.condition),
      dependsOn: Array.isArray(step.dependsOn) ? (step.dependsOn as string[]) : [],
      loopEnabled: loop !== undefined,
      maxIterations: typeof loop?.maxIterations === "number" ? loop.maxIterations : 3,
      untilText: jsonFieldText(loop?.until),
      onExhausted: loop?.onExhausted === "pass" ? "pass" : "fail",
      retries: typeof step.retries === "number" ? step.retries : 0,
      modelText: jsonFieldText(step.model),
    };
  });
}

/** Render a workflow-level `defaultModel` into its editor text field. */
export function defaultModelToText(value: unknown): string {
  return jsonFieldText(value);
}
