/**
 * The shared "this model has no per-token price" test fixture.
 *
 * `priceSegment` (src/runtime/usage/cache-stats.ts) reports UNPRICED off an
 * all-zero rate table, and `modelPrices` (src/providers/registry.ts) produces
 * one for exactly two classes of model: an OAuth-subscription model, which is
 * rate-limited rather than billed per token, and any id `resolveModelObject`
 * has to SYNTHESIZE because no catalog lists it.
 *
 * WHY A SYNTHETIC ID AND NOT A REAL ONE
 * -------------------------------------
 * Both cost suites used to spell this fixture `claude-opus-5`, which was
 * unpriced only because pi-ai 0.80.6's catalog did not list that model.
 * pi-ai 0.83.0 added it WITH real rates, and three assertions across
 * `workflow-step-telemetry.test.ts` and `workflow-run-trace.test.ts` went red
 * at once — a catalog refresh, not a code change, silently redefined what
 * "unpriced" meant. (The old comment predicted precisely this and named the
 * right remedy: "a different unpriced id, not a weakened assertion.")
 *
 * Every model EZCorp ships is priced as of 0.83.0, so there is no durable
 * real-model choice. A catalog-ABSENT id reaches the same all-zero rate table
 * BY CONSTRUCTION, which no upstream catalog change can undo — and it is
 * shared from here so the next catalog bump cannot stale two copies of the
 * same fact independently.
 */
export const UNPRICED_MODEL = "ezcorp-test-unpriced-model";
