/**
 * "Cheapest model per provider family" for **host-internal** LLM calls (the
 * `/goal` evaluator and the memory compaction merge).
 *
 * A DERIVED VIEW, not a second registry: the ids live once, on the `fast` rung
 * of `runtime/routing/tier-ladder`'s DEFAULT_TIER_LADDER, so a model
 * deprecation stays a single edit and the ladder the operator edits in
 * Settings → Models cannot drift from what host-internal callers use. This
 * map's own consumers keep working unchanged.
 *
 * NOTE: this is deliberately NOT shared with the per-extension
 * `allowedModels` ceilings in `bundled.ts` / `bundled-ceiling.ts`. Those
 * are security boundaries kept verbatim per extension — widening them must
 * be an explicit, reviewed change, not a side effect of editing the ladder.
 */

import { DEFAULT_TIER_LADDER } from "../runtime/routing/tier-ladder";

/** Explicit provider keys (always present) plus a string index signature so
 *  callers can also look up by a dynamic provider string. Dynamic access
 *  returns `string | undefined` under `noUncheckedIndexedAccess`; the four
 *  named keys are guaranteed defined. */
interface CheapModelRegistry extends Record<string, string> {
  anthropic: string;
  google: string;
  openai: string;
  ollama: string;
}

// The cast asserts what the ladder's `fast` rung guarantees: an entry for each
// of the four named providers. `src/__tests__/tier-ladder.test.ts` asserts the
// guarantee holds, so a rung deleted from the ladder fails a test instead of
// handing a caller `undefined` at runtime.
export const CHEAP_MODEL_BY_PROVIDER = Object.fromEntries(
  DEFAULT_TIER_LADDER.fast.map((entry) => [entry.provider, entry.model]),
) as Readonly<CheapModelRegistry>;
