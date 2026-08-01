/**
 * USD cost of one workflow step (or one loop iteration) from what the row
 * already records: `provider`, `model`, and the two token counts.
 *
 * ## Why this is a lookup + a call, not a price table
 *
 * The per-token rates already exist and are already used in production —
 * `modelPrices` (`src/providers/registry.ts`) reads them off the resolved
 * `Model`, and `priceSegment` (`./usage/cache-stats.ts`) owns every
 * arithmetic decision including "is this model priced at all?".
 * `db/queries/analytics.ts` composes exactly these two. This module is the
 * same composition for workflow steps, in one place, so the parent-step
 * writer and the iteration writer cannot drift apart on it.
 *
 * Nothing here does arithmetic of its own. Adding a second cost formula
 * next to `priceSegment` is how two answers to "what did this cost" get
 * born, and they only ever disagree in production.
 *
 * ## NULL is a real answer and it is NOT zero
 *
 * This returns `null` — never `"0"` — whenever a cost could not be
 * MEASURED, and callers persist that as SQL NULL. Three distinct
 * situations produce it, and none of them means "free":
 *
 *   1. **No LLM ran.** `tool` / `transform` / `gate` steps report no
 *      tokens at all, so there is nothing to price. **Their real-world
 *      cost is not zero — it is unmeasured.** A spend cap summing this
 *      column bounds LLM spend and nothing else; anything that treats
 *      `SUM(cost_usd)` as total spend is wrong about tool steps, and
 *      coercing this to 0 would hide that instead of surfacing it.
 *   2. **The provider reported no usage** — a cached response, a stream
 *      that errored mid-flight. The call happened; the measurement did
 *      not.
 *   3. **The model is unpriced.** `priceSegment` returns `null` for an
 *      all-zero rate table, which is exactly how OAuth-SUBSCRIPTION
 *      models arrive: they are rate-limited rather than billed per token,
 *      so no per-token cost exists to record.
 *
 * A PRICED model that genuinely consumed zero tokens is a different fact
 * and returns `"0.000000"`. That zero is data — it says "measured, and it
 * was free" — and the distinction between it and NULL is what lets a
 * reader tell a free step from an unpriceable one. Pinned by
 * "an unpriced model yields null, not a zero cost" in
 * `workflow-step-cost.test.ts`.
 *
 * ## Cache tokens
 *
 * `workflow_step_runs` records only input and output tokens — there is no
 * per-step cache breakdown — so the cache lines price at zero rather than
 * being guessed at. A workflow step's cost is therefore a floor, not a
 * ceiling, on a provider that bills cache reads separately.
 */
import { priceSegment, type ModelPrices } from "./usage/cache-stats";
import { modelPrices } from "../providers/registry";

/** Resolve per-1M-token rates for a provider+model. Injectable so a test
 *  pins its own rates instead of depending on the live model catalog,
 *  which changes whenever pi-ai ships a new price. */
export type PriceLookup = (provider: string, model: string) => ModelPrices | undefined;

/** The subset of a step / iteration row this needs. Deliberately shaped as
 *  the loose intersection of both upsert types, so either can pass its own
 *  row without a projection. */
export interface StepCostInput {
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * Decimal places written to the `numeric(12, 6)` columns.
 *
 * A step costing less than $0.000001 therefore records as `"0.000000"`.
 * That is the column's declared resolution (chosen when the column landed,
 * not here), and it is the one case where a measured cost is
 * indistinguishable from a measured zero.
 */
export const STEP_COST_SCALE = 6;

/**
 * Cost of one step / iteration as a fixed-point string for the `numeric`
 * column, or `null` when it could not be measured (see the module doc —
 * `null` is never "free").
 *
 * A string rather than a number because the column is `NUMERIC`: routing a
 * decimal through a JS float on the way in is how a cost dashboard starts
 * accumulating error, which is the reason the column is not
 * `DOUBLE PRECISION` in the first place.
 */
export function stepCostUsd(
  row: StepCostInput,
  lookup: PriceLookup = modelPrices,
): string | null {
  const { provider, model } = row;
  // No resolved binding ⇒ nothing to look up. This is the "running" write,
  // which happens before the agent has resolved anything.
  if (!provider || !model) return null;

  // Neither counter reported ⇒ no measurement was taken. Situations 1 and
  // 2 in the module doc land here, and both must stay NULL.
  const { inputTokens, outputTokens } = row;
  if (inputTokens == null && outputTokens == null) return null;

  const cost = priceSegment(
    {
      input: inputTokens ?? 0,
      output: outputTokens ?? 0,
      // No per-step cache breakdown exists — see the module doc.
      cacheRead: 0,
      cacheWrite: 0,
    },
    lookup(provider, model),
  );
  // Situation 3: an unpriced model. `priceSegment` already decided this,
  // and re-deciding it here would be the second opinion this module exists
  // to avoid.
  if (cost === null) return null;
  return cost.total.toFixed(STEP_COST_SCALE);
}
