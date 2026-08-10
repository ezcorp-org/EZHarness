/**
 * Cost-tier classification by blended USD-per-1M-token rate.
 *
 * The single numeric rule — blended (input+output) ≤ $3 is `low`, ≤ $30 is
 * `medium`, else `high` — that `src/providers/registry.ts#inferTier` applies
 * to every catalog provider AND `src/providers/kilo.ts#kiloCostTier` applies
 * to Kilo models. Both used to restate the same two thresholds independently
 * because Kilo cannot import `registry.ts` directly: `registry.ts` already
 * imports `kilo.ts` at runtime (for `kiloPickerEntries`/`resolveKiloModel`),
 * so a `kilo.ts -> registry.ts` runtime import back would be a genuine
 * cycle. `registry.ts`'s own name-hint fallback for zero-priced models
 * (`inferTier`'s `blended <= 0` branch) is NOT included here — Kilo's
 * zero-priced rows and the catalog's zero-priced rows resolve that
 * differently on purpose (see each call site), so only the truly identical
 * threshold rule lives here.
 *
 * Pure (no DB, no pi-ai, no imports at all) so both call sites — even though
 * `src/providers/**` itself is excluded from the coverage gate
 * (`scripts/coverage-config.ts`) — get this rule coverage-enforced, same
 * rationale as the sibling `./llm-providers` and `./kilo-catalog`.
 */

export type CostTier = "low" | "medium" | "high";

/** Blended (input+output) USD-per-1M-token thresholds shared by every
 *  provider's cost-tier inference: ≤$3 low, ≤$30 medium, else high. */
export function costTierForBlendedRate(blendedUsdPerMillion: number): CostTier {
  if (blendedUsdPerMillion <= 3) return "low";
  if (blendedUsdPerMillion <= 30) return "medium";
  return "high";
}
