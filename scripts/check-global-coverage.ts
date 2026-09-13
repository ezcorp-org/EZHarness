#!/usr/bin/env bun
/**
 * Aggregate line-coverage floor over the merged coverage/lcov.info.
 *
 * This does NOT replace scripts/check-coverage.ts — it sits beside it and
 * catches a different failure. The per-file ratchet asks "is THIS module
 * covered to its key?", which is blind to a hundred files each drifting two
 * points under their own catch-all. This asks "is the TREE still covered?".
 * A PR must satisfy both.
 *
 * Threshold: coverage.globalLineThreshold in scripts/quality-gates.json.
 * Measured 96.19% on 2026-09-13, so the 90% floor has ~6 points of headroom —
 * it is a floor against drift, not a target to code up to.
 *
 * Writes coverage/quality/global-coverage.json. Exits 1 below the floor.
 */
import { isExcluded } from "./coverage-config.ts";
import { loadGates, loadLcov, writeReport } from "./quality-gates.ts";

const gates = await loadGates();
const { perFile } = await loadLcov();

let totalLines = 0;
let coveredLines = 0;
let files = 0;
const perFileOut: { file: string; pct: number; covered: number; total: number }[] = [];

for (const [file, cov] of perFile) {
  // EXCLUDES is the coverage pipeline's own un-gating list. Honouring it here
  // keeps this gate's denominator identical to the per-file gate's — two gates
  // reading the same lcov must never disagree about what counts as source.
  if (isExcluded(file)) continue;
  if (cov.totalLines === 0) continue;
  files++;
  totalLines += cov.totalLines;
  coveredLines += cov.coveredLines;
  perFileOut.push({
    file,
    pct: (cov.coveredLines / cov.totalLines) * 100,
    covered: cov.coveredLines,
    total: cov.totalLines,
  });
}

if (totalLines === 0) {
  console.error(
    "✗ global coverage: lcov contains no measurable lines — the coverage " +
      "producers did not run. Refusing to pass a gate with no data.",
  );
  process.exit(1);
}

const pct = (coveredLines / totalLines) * 100;
const threshold = gates.coverage.globalLineThreshold;
const passed = pct + 1e-9 >= threshold;

// The worst files are the actionable part of a failure: they name where the
// missing lines actually are, weighted by how many each one owes.
const worst = perFileOut
  .map((f) => ({ ...f, missing: f.total - f.covered }))
  .filter((f) => f.missing > 0)
  .sort((a, b) => b.missing - a.missing)
  .slice(0, 25);

await writeReport("global-coverage.json", {
  generatedAt: new Date().toISOString(),
  threshold,
  linePct: Number(pct.toFixed(4)),
  coveredLines,
  totalLines,
  files,
  passed,
  worstByMissingLines: worst,
});

console.log(
  `\nGlobal line coverage: ${pct.toFixed(2)}% ` +
    `(${coveredLines}/${totalLines} lines across ${files} files), floor ${threshold}%`,
);

if (!passed) {
  const deficit = Math.ceil((threshold / 100) * totalLines - coveredLines);
  console.error(`\n✗ below the ${threshold}% floor — ${deficit} more covered line(s) needed.`);
  console.error("\n  Files owing the most lines:");
  for (const f of worst.slice(0, 15)) {
    console.error(`    ${String(f.missing).padStart(5)} missing  ${f.pct.toFixed(1).padStart(5)}%  ${f.file}`);
  }
  console.error("\n  Report: coverage/quality/global-coverage.json");
  process.exit(1);
}

console.log(`✓ at or above the ${threshold}% floor (margin ${(pct - threshold).toFixed(2)} points)`);
