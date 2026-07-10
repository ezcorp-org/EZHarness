// ── deltas.ts — adjacent-grade % price steps, per grading company ───
//
// From the per-company grade→price map (pricecharting.ts's
// `parseCompanyPrices`), compute the % price difference between each
// adjacent PRICED grade pair per company:
//
//   pct = (higher - lower) / lower * 100, rounded to 1 decimal.
//
// "Adjacent" follows the app's buildGradeRows precedent (% vs the next
// lower PRICED grade): grades sort numerically ascending and null-priced
// grades are skipped, so a gap (e.g. 8 → 9 null → 10) produces one step
// 8→10 rather than dropping the comparison entirely. Companies with
// fewer than two priced grades yield NO entry — the chart has nothing to
// draw for them (the card still lists their prices in the table from the
// raw grades map). Pure functions; no I/O.

import type { CompanyPriceMap } from "./sources/pricecharting";

export interface DeltaStep {
  /** Lower grade label, e.g. "9". */
  from: string;
  /** Higher grade label, e.g. "10". */
  to: string;
  fromPrice: number;
  toPrice: number;
  /** (toPrice - fromPrice) / fromPrice * 100, rounded to 1 decimal. */
  pct: number;
}

export interface CompanyDeltas {
  company: string;
  steps: DeltaStep[];
}

/** Round to one decimal place (spec-locked delta precision). */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Compute per-company adjacent-grade steps. Deterministic output order:
 * companies sorted by name asc; steps low → high grade.
 */
export function computeDeltas(companies: CompanyPriceMap): CompanyDeltas[] {
  const out: CompanyDeltas[] = [];
  for (const company of Object.keys(companies).sort()) {
    const byGrade = companies[company]!;
    // Numeric-ascending priced grades only. A zero/negative price can't
    // anchor a % comparison (division), so it is treated as unpriced.
    const priced = Object.keys(byGrade)
      .filter((g) => {
        const p = byGrade[g];
        return typeof p === "number" && p > 0;
      })
      .sort((a, b) => Number(a) - Number(b));
    if (priced.length < 2) continue;

    const steps: DeltaStep[] = [];
    for (let i = 1; i < priced.length; i++) {
      const from = priced[i - 1]!;
      const to = priced[i]!;
      const fromPrice = byGrade[from] as number;
      const toPrice = byGrade[to] as number;
      steps.push({
        from,
        to,
        fromPrice,
        toPrice,
        pct: round1(((toPrice - fromPrice) / fromPrice) * 100),
      });
    }
    out.push({ company, steps });
  }
  return out;
}
