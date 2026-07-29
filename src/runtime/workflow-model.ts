/**
 * Per-step model bindings for workflows: the vocabulary, the
 * definition-time shape check, and the run-time ref resolution.
 *
 * One module so the validator (definition time) and the executor (run
 * time) share a single definition of what a model override may say — the
 * same DRY rule `workflow-refs.ts` follows for the ref grammar and
 * `workflow-name.ts` for the name grammar.
 */
import type {
  ModelEffort,
  ModelOverride,
  WorkflowDefinition,
  WorkflowModelBinding,
  WorkflowStep,
} from "../types";
import { resolveMapping, type RefContext } from "./workflow-refs";

/** The reasoning-effort vocabulary (pi-ai's `ThinkingLevel`). Kept as a
 *  value — not only a type — so the definition-time validator can reject
 *  an unknown effort before it reaches a provider. */
export const VALID_MODEL_EFFORTS: readonly ModelEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Fields carrying a string (and therefore possibly a ref). */
const STRING_FIELDS = ["provider", "model", "effort"] as const;
/** Fields carrying a number (never a ref — a ref is a string). */
const NUMERIC_FIELDS = ["temperature", "maxTokens"] as const;
const KNOWN_FIELDS: readonly string[] = [...STRING_FIELDS, ...NUMERIC_FIELDS];

/** Sampling bounds. `temperature` is the union of every provider's
 *  accepted range (0..2); `maxTokens` is bounded simply because workflow
 *  definitions are untrusted — a chat-scoped user can submit one. */
export const MAX_MODEL_TEMPERATURE = 2;
export const MAX_MODEL_MAX_TOKENS = 1_000_000;
/** Provider ids and model ids are short; this only stops an untrusted
 *  definition smuggling an unbounded string into a provider request. */
export const MAX_MODEL_FIELD_LENGTH = 200;

/**
 * True for a value that is a workflow REF rather than a literal.
 *
 * Every ref root in `workflow-refs.ts` (`$input.` / `$prev` / `$steps.` /
 * `$loop.` / `$result` / `$iteration`) starts with `$`, and no real
 * provider or model id does. A ref's VALUE is unknowable at definition
 * time, so vocabulary checks (the `effort` enum) are deferred to
 * {@link resolveModelOverride}, which re-checks the resolved value and
 * fails loudly there.
 */
function isRef(value: string): boolean {
  return value.startsWith("$");
}

/**
 * Validate a model override's SHAPE at definition time. Returns
 * human-readable errors, each prefixed with `label` (e.g.
 * `Step "verify" model`). Empty ⇒ valid shape.
 *
 * **Deliberately shape-only for `provider` / `model`.** The obvious
 * stronger check — "is this a real provider, and does it offer this
 * model?" — cannot be made here, and shipping a half-check would reject
 * valid definitions:
 *
 *   1. `validateWorkflow` is SYNCHRONOUS and runs in the YAML loader at
 *      boot, before the DB is necessarily wired. The host's real model
 *      universe is only reachable through I/O: `provider:customModels`
 *      and `provider:discoveredModels:<p>` are `settings` rows read by
 *      `getModelRegistry()` / `resolveDiscoveredModel()` (both async).
 *   2. pi-ai's static catalog (`getProviders()` / `getModels()`) is sync
 *      but INCOMPLETE — it has no `ollama` / local provider (custom
 *      models default to `ollama`), no `ezcorp-mock` (the e2e harness
 *      provider), and none of the models a `refresh-models` discovery
 *      added. Validating against it would reject working setups.
 *   3. A value may be a REF (`$input.verifyModel`), whose value simply
 *      does not exist until the run resolves it.
 *
 * So the definition-time contract is: shape, bounds and the closed
 * `effort` vocabulary (for literals). An unresolvable provider/model
 * still fails at the provider with that provider's own error, exactly as
 * a mistyped agent-config binding does today.
 */
export function validateModelOverride(value: unknown, label: string): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [`${label} must be an object`];
  }
  const o = value as Record<string, unknown>;
  const errors: string[] = [];

  for (const key of Object.keys(o)) {
    if (!KNOWN_FIELDS.includes(key)) {
      errors.push(
        `${label} has an unknown field "${key}" (expected one of: ${KNOWN_FIELDS.join(", ")})`,
      );
    }
  }

  for (const field of STRING_FIELDS) {
    const v = o[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.trim() === "") {
      errors.push(`${label} "${field}" must be a non-empty string`);
      continue;
    }
    if (v.length > MAX_MODEL_FIELD_LENGTH) {
      errors.push(
        `${label} "${field}" exceeds the maximum length of ${MAX_MODEL_FIELD_LENGTH} characters`,
      );
      continue;
    }
    // A literal effort is checked against the closed vocabulary; a ref is
    // checked at run time against its RESOLVED value instead.
    if (field === "effort" && !isRef(v) && !VALID_MODEL_EFFORTS.includes(v as ModelEffort)) {
      errors.push(
        `${label} "effort" must be one of: ${VALID_MODEL_EFFORTS.join(", ")} (got "${v}")`,
      );
    }
  }

  const temperature = o.temperature;
  if (temperature !== undefined) {
    if (typeof temperature !== "number" || !Number.isFinite(temperature)) {
      errors.push(`${label} "temperature" must be a number`);
    } else if (temperature < 0 || temperature > MAX_MODEL_TEMPERATURE) {
      errors.push(
        `${label} "temperature" must be between 0 and ${MAX_MODEL_TEMPERATURE} (got ${temperature})`,
      );
    }
  }

  const maxTokens = o.maxTokens;
  if (maxTokens !== undefined) {
    if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens)) {
      errors.push(`${label} "maxTokens" must be an integer`);
    } else if (maxTokens < 1 || maxTokens > MAX_MODEL_MAX_TOKENS) {
      errors.push(
        `${label} "maxTokens" must be between 1 and ${MAX_MODEL_MAX_TOKENS} (got ${maxTokens})`,
      );
    }
  }

  return errors;
}

/**
 * The override that applies to a step: its own `model`, else the
 * definition's `defaultModel`, else none.
 *
 * Whole-bundle `??`, NOT a field-by-field merge — a step that names
 * `model` replaces the default outright, so it can drop back to the
 * provider's own sampling defaults without silently inheriting a
 * definition-level `maxTokens`.
 */
export function effectiveModelOverride(
  step: WorkflowStep,
  workflow: Pick<WorkflowDefinition, "defaultModel">,
): WorkflowModelBinding | undefined {
  return step.model ?? workflow.defaultModel;
}

/**
 * Resolve an override's ref-bearing fields against the SAME ref context
 * the step's `input` is resolved with (`resolveMapping` — there is
 * deliberately no second resolver).
 *
 * Two lenient/loud rules, both deliberate:
 *   - a `$input.x` ref whose field is unset resolves to `undefined`, which
 *     means "no override for THIS field" — the agent's own binding stands.
 *     An unset optional knob must not become a broken model id.
 *   - anything else that fails to be a usable value (a ref resolving to a
 *     number/object, an effort outside the vocabulary) THROWS with the
 *     step named, matching the subsystem's loud-failure rule. Silently
 *     dropping it would run an expensive step on the wrong model.
 *
 * Returns `undefined` when nothing survives resolution, so a fully-unset
 * override is indistinguishable from no override at all.
 */
export function resolveModelOverride(
  override: WorkflowModelBinding | undefined,
  ctx: RefContext,
  stepName: string,
): ModelOverride | undefined {
  if (!override) return undefined;

  const mapping: Record<string, string> = {};
  for (const field of STRING_FIELDS) {
    const v = override[field];
    if (typeof v === "string") mapping[field] = v;
  }
  const resolved = resolveMapping(mapping, ctx);

  const str = (field: (typeof STRING_FIELDS)[number]): string | undefined => {
    if (!(field in resolved)) return undefined;
    const v = resolved[field];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(
        `Step "${stepName}" model override "${field}" resolved to a non-string value ` +
          `(${JSON.stringify(v)}); it must resolve to a non-empty string.`,
      );
    }
    return v;
  };

  const out: ModelOverride = {};
  const provider = str("provider");
  if (provider !== undefined) out.provider = provider;
  const model = str("model");
  if (model !== undefined) out.model = model;
  const effort = str("effort");
  if (effort !== undefined) {
    if (!VALID_MODEL_EFFORTS.includes(effort as ModelEffort)) {
      throw new Error(
        `Step "${stepName}" model override "effort" resolved to "${effort}"; ` +
          `expected one of: ${VALID_MODEL_EFFORTS.join(", ")}.`,
      );
    }
    out.effort = effort as ModelEffort;
  }
  for (const field of NUMERIC_FIELDS) {
    const v = override[field];
    if (v !== undefined) out[field] = v;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
