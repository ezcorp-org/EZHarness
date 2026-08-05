/**
 * Does a resolved model honour a reasoning-`effort` request — and what do
 * we say when it does not?
 *
 * ── The mechanism, documented once ──
 * A workflow step's `model: { effort }` reaches pi-ai as the `reasoning`
 * option on `completeSimple`/`streamSimple` (`../executor-helpers.ts`). Every
 * wire path pi-ai has for that option is gated on the MODEL's own
 * `reasoning` flag:
 *
 *   - `getSupportedThinkingLevels(model)` returns `["off"]` outright when
 *     `!model.reasoning`, so `clampThinkingLevel(model, "high")` clamps to
 *     `"off"` and the api layer turns `"off"` into `undefined`.
 *   - Independently, every `thinkingFormat` branch in
 *     `api/openai-completions` (zai / qwen / deepseek / openrouter /
 *     together / string-thinking / the plain OpenAI `reasoning_effort`) is
 *     `… && model.reasoning`.
 *
 * So on a model flagged `reasoning: false` the request is dropped before it
 * is serialized: the outgoing body carries no reasoning field at all. Not an
 * error, not a degraded setting — silence.
 *
 * ── Why this matters for LOCAL and CUSTOM models specifically ──
 * `resolveModelObject` (`src/providers/registry.ts`) SYNTHESIZES an entry for
 * any provider/model pair pi-ai's catalog does not know, and both of its
 * synthesis branches hardcode `reasoning: false`. That is exactly how an
 * Ollama / llama.cpp / vLLM / LM Studio model — or any id typed into the
 * custom-model form — arrives at the runtime. There is currently no way for
 * an operator to say otherwise: `provider:customModels` rows are threaded
 * into `resolveModelObject` by `baseUrl` alone.
 *
 * ── Purity (why this lives in src/runtime, not src/providers) ──
 * Same rationale as the sibling `./tier-ladder` and `./custom-models`:
 * `src/providers/**` is excluded from the coverage gate
 * (`scripts/coverage-config.ts`), and this decides what a user is TOLD about
 * their own run. So it is pure — no DB, no pi-ai, no registry import — and
 * the caller passes the already-resolved model in.
 *
 * ── One definition, two callers ──
 * The delegation consent preview
 * (`web/src/routes/api/workflows/delegations/preview/+server.ts`) warns about
 * this BEFORE a delegation is granted; `createPiLlmAdapter` warns about it
 * AT the call that drops it. Both ask this module, so the pre-flight warning
 * and the run-time one can never disagree about what counts as a no-op.
 */

/**
 * The shape both callers can supply: the delegation preview holds a pi-ai
 * `Model<any>` from `resolveModelObject`, the adapter holds the `piModel`
 * the call is about to ship. Structural, not a type import, to keep this
 * module free of any `src/providers` / pi-ai dependency.
 */
export interface EffortCapableModel {
  reasoning?: boolean;
}

/**
 * True only when the model will actually apply a reasoning effort.
 *
 * Deliberately `=== true` rather than truthy: a synthesized entry carries a
 * literal `false`, but a hand-written row or a partially-populated discovery
 * result can carry `undefined`, and "we do not know" must read the same as
 * "no" — the whole point of the warning this feeds is that everything in it
 * is TRUE. Claiming a model honours effort when we cannot tell would be the
 * one failure worse than the silence we are fixing.
 */
export function modelHonoursEffort(model: EffortCapableModel | null | undefined): boolean {
  return model?.reasoning === true;
}

/**
 * The sentence shown when an effort request is dropped.
 *
 * Worded to exactly what was DERIVED — the resolved model's `reasoning`
 * flag — with the local/custom case named because it is the one that
 * surprises people. Claiming "this is a local model" outright would be a
 * guess; a locally-served or custom model is the REASON the flag is false,
 * not the thing the flag reports. Kept verbatim in step with the consent
 * dialog's copy (`web/src/lib/workflow-delegations-logic.ts`), so a person
 * who saw the warning at grant time recognises it in the run log.
 */
export function effortIgnoredNotice(binding: {
  provider: string;
  model: string;
  effort: string;
}): string {
  return (
    `Reasoning effort "${binding.effort}" was ignored: the bound model ` +
    `${binding.provider}/${binding.model} does not accept a reasoning setting. ` +
    "Local and custom models never do."
  );
}
