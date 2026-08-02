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
  /** Runtime-namespaced extension tool (`<extension>__<tool>`) for a `tool`
   *  step. Empty on every other kind. */
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

/** The kinds that accept an `input` mapping. Both dispatch the same ref
 *  language; a transform reads `output` instead and a gate reads
 *  `condition`, so surfacing the input editor there would be dead UX. */
export function acceptsInputMapping(kind: StepKind): boolean {
  return kind === "agent" || kind === "tool";
}

/** The kinds that may carry a `loop`. The validator rejects a loop on a
 *  gate, and on a tool because repeating a side-effecting call with no LLM
 *  in the middle is deliberately out of scope. */
export function acceptsLoop(kind: StepKind): boolean {
  return kind === "agent" || kind === "transform";
}

/** Only an agent step retries — `retries` is read exclusively by the
 *  executor's agent path, so emitting it elsewhere is dead payload. */
export function acceptsRetries(kind: StepKind): boolean {
  return kind === "agent";
}

/** The default iteration budget for a newly enabled loop (server clamp is
 *  1..25). */
export const DEFAULT_MAX_ITERATIONS = 3;

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
    maxIterations: DEFAULT_MAX_ITERATIONS,
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

  // Each branch emits ONLY the field that distinguishes its kind.
  // `input`, `retries` and `loop` are emitted once, below, through the
  // `acceptsX` predicates — a per-branch copy is how the two drifted.
  if (step.kind === "agent") {
    out.agent = step.agent;
    // Only an agent step runs an LLM, and the server rejects a `model` on
    // any other kind — so the binding is emitted here and nowhere else.
    const model = parseJsonField(step.modelText);
    if (!model.ok) throw `Step "${step.name}": model binding is not valid JSON`;
    if (model.value !== undefined) out.model = model.value;
  } else if (step.kind === "tool") {
    // A tool step carries `tool` and never `agent` — the validator rejects
    // a step that specifies both.
    out.tool = step.tool;
  } else if (step.kind === "transform") {
    out.output = pairsToRecord(step.outputPairs);
  } else {
    const parsed = parseJsonField(step.conditionText);
    if (!parsed.ok) throw `Step "${step.name}": condition is not valid JSON`;
    out.condition = parsed.value;
  }

  // Agent and tool steps share ONE input-mapping grammar (there is
  // deliberately no second ref language), so they share one emit path. A
  // transform reads `output` and a gate reads `condition`; the executor
  // never looks at `input` on either, so emitting it would be dead payload.
  if (acceptsInputMapping(step.kind)) {
    const input = pairsToRecord(step.inputPairs);
    if (Object.keys(input).length > 0) out.input = input;
  }

  if (acceptsRetries(step.kind) && !step.loopEnabled && step.retries > 0) {
    out.retries = step.retries;
  }

  if (step.dependsOn.length > 0) out.dependsOn = step.dependsOn;

  if (step.loopEnabled && acceptsLoop(step.kind)) {
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

/** The step shape {@link workflowToDrafts} consumes — structurally the
 *  `WorkflowStep` the API serves, declared locally so this module stays
 *  free of both the client and the server type trees. */
export interface StoredStep {
  name?: string;
  kind?: string;
  agent?: string;
  tool?: string;
  input?: Record<string, string>;
  output?: Record<string, string>;
  condition?: unknown;
  dependsOn?: string[];
  retries?: number;
  loop?: { maxIterations?: number; until?: unknown; onExhausted?: string };
}

/** Narrow an arbitrary stored `kind` to one the builder can render.
 *  `kind` is optional in the schema and defaults to `"agent"`; anything
 *  unrecognized also lands there rather than producing an unrenderable
 *  draft. */
function toStepKind(kind: string | undefined): StepKind {
  if (kind === "transform" || kind === "gate" || kind === "tool") return kind;
  return "agent";
}

/**
 * Inflate a stored workflow's steps into editable drafts — the FORM's entry
 * point, and what makes editing an existing workflow possible at all.
 *
 * The only thing this adds over {@link definitionToDrafts} is the empty
 * case: a form with zero rows renders nothing the user can type into and no
 * way to add a row, so an absent or empty step list opens on one blank
 * step. Everything else delegates, because two independent inverses of
 * `stepToPayload` is precisely how one of them ends up quietly dropping a
 * field the other carries — the per-step `model` binding was already lost
 * that way once.
 */
export function workflowToDrafts(steps: StoredStep[] | undefined): StepDraft[] {
  const drafts = definitionToDrafts(steps);
  return drafts.length > 0 ? drafts : [blankStep(0)];
}

/**
 * The name a duplicate starts life with.
 *
 * Names are unique, so a copy cannot reuse the original's. The extension
 * namespace is stripped rather than carried: `some-ext:deploy` copied
 * verbatim would create a `workflow_definitions` row squatting on that
 * extension's namespace, and the loader puts extension assets FIRST in the
 * merged cache — so the copy would be permanently shadowed by the original
 * and never resolve. Only the local half is kept.
 */
export function duplicateName(name: string): string {
  const at = name.indexOf(":");
  const local = at >= 0 ? name.slice(at + 1) : name;
  return `${local}-copy`;
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
    if (step.kind === "tool" && !step.tool) {
      return { error: `Step "${step.name}" (tool) needs a tool` };
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
    // Narrowed, not cast: `kind` is optional in the schema and arrives off
    // the wire, and an unrecognized value would bind the form to no branch
    // at all — an unrenderable row the user cannot fix.
    const kind = toStepKind(typeof step.kind === "string" ? step.kind : undefined);
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
      maxIterations:
        typeof loop?.maxIterations === "number" ? loop.maxIterations : DEFAULT_MAX_ITERATIONS,
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
