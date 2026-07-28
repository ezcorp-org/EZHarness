/**
 * Pollen banding — the SINGLE source of truth for turning a pollen
 * total into a severity band.
 *
 * The band is computed HERE, host-side, and shipped in the result
 * envelope as `pollen.band`. Nothing downstream re-derives it: the card
 * renders the string it is given. Keeping the thresholds in one module
 * is the whole point — a second copy in a Svelte file is how "moderate"
 * on the card and "high" in the transcript start disagreeing.
 *
 * Thresholds (pinned by tasks/city-conditions-contract.md):
 *   null → none | <1 → low | <20 → moderate | <100 → high | else very-high
 */

/** The six grains Open-Meteo's air-quality API publishes. */
export const POLLEN_GRAINS = ["alder", "birch", "grass", "mugwort", "olive", "ragweed"] as const;

export type PollenGrain = (typeof POLLEN_GRAINS)[number];

export type PollenBand = "none" | "low" | "moderate" | "high" | "very-high";

/** Per-grain µg/m³, or `null` where the provider has no value here. */
export type PollenGrains = Record<PollenGrain, number | null>;

/**
 * Sum the non-null grains to 1dp. Returns `null` when EVERY grain is
 * null — "the provider has nothing for this location", which is a
 * different fact from "the count is zero" and must not be flattened
 * into `0`.
 */
export function totalPollenIndex(grains: PollenGrains): number | null {
  let sum = 0;
  let measured = false;
  for (const grain of POLLEN_GRAINS) {
    const value = grains[grain];
    if (value === null) continue;
    sum += value;
    measured = true;
  }
  return measured ? Number(sum.toFixed(1)) : null;
}

/** Map a total index onto its band. `null` (nothing measured) → `none`. */
export function pollenBand(totalIndex: number | null): PollenBand {
  if (totalIndex === null) return "none";
  if (totalIndex < 1) return "low";
  if (totalIndex < 20) return "moderate";
  if (totalIndex < 100) return "high";
  return "very-high";
}
