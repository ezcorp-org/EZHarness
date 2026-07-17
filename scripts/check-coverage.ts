#!/usr/bin/env bun
/**
 * Parse coverage/lcov.info and enforce per-glob thresholds from
 * scripts/coverage-thresholds.json. Exits 1 on any violation.
 */
import { Glob } from "bun";
import { resolve } from "node:path";
import {
  EXCLUDES,
  escapeGlob,
  parseLcov,
  REPO_ROOT,
  wildcardTreeDropouts,
} from "./coverage-config.ts";

const LCOV_PATH = resolve(REPO_ROOT, "coverage/lcov.info");
const THRESHOLDS_PATH = resolve(REPO_ROOT, "scripts/coverage-thresholds.json");

const thresholdsText = await Bun.file(THRESHOLDS_PATH).text();
const thresholds = JSON.parse(thresholdsText) as Record<string, number>;
const thresholdGlobs = Object.keys(thresholds).map((pat) => ({
  pat,
  glob: new Glob(escapeGlob(pat)),
  specificity: pat.replace(/\*/g, "").length,
  threshold: thresholds[pat] ?? 0,
}));
// Sort most-specific first so first match wins.
thresholdGlobs.sort((a, b) => b.specificity - a.specificity);

const excludeGlobs = EXCLUDES.map((p) => new Glob(escapeGlob(p)));

const perFile = parseLcov(await Bun.file(LCOV_PATH).text());

const violations: string[] = [];
const matchedThresholds = new Set<string>();
let enforced = 0;
for (const [file, cov] of perFile) {
  if (excludeGlobs.some((g) => g.match(file))) continue;
  const match = thresholdGlobs.find((t) => t.glob.match(file));
  if (!match) continue;
  matchedThresholds.add(match.pat);
  enforced++;
  if (cov.totalLines === 0) {
    violations.push(
      `${file}: 0 measured lines (file in lcov but no DA records) — ` +
        `coverage script doesn't measure this path. Either add coverage ` +
        `for it, exclude it, or extend test-coverage.sh.`,
    );
    continue;
  }
  const pct = (cov.coveredLines / cov.totalLines) * 100;
  if (pct + 1e-9 < match.threshold) {
    const missedCsv = cov.missed.slice(0, 40).join(",") + (cov.missed.length > 40 ? ",..." : "");
    violations.push(
      `${file}: ${pct.toFixed(2)}% < ${match.threshold}% — missed lines: ${missedCsv}`,
    );
  }
}

// Threshold rules that no lcov file matched at all are silent gates —
// either the source file moved, the threshold key has a typo, or the
// test runner that produces this lcov never exercises that path (e.g.
// vitest-only Svelte components when only bun:test feeds lcov). Surface
// each as a failure so the silence is audible.
//
// Skip threshold patterns whose key is itself covered by an EXCLUDES
// pattern (e.g. a `web/src/lib/**` wildcard with an exclude carve-out)
// — those aren't enforced.
for (const t of thresholdGlobs) {
  if (matchedThresholds.has(t.pat)) continue;
  if (excludeGlobs.some((g) => g.match(t.pat))) continue;
  // Wildcard threshold keys (e.g. `web/src/lib/**`) are expected to
  // produce zero direct matches when more-specific keys catch every
  // file — that's not a missing gate, it's the wildcard-is-fallback
  // pattern. Exact-file keys fail-loud here; wildcard keys get the
  // whole-tree-dropout check below instead.
  if (t.pat.includes("*")) continue;
  violations.push(
    `${t.pat}: listed in thresholds but no lcov data — ` +
      `coverage script doesn't measure this path. Either add coverage ` +
      `for it, exclude it, or extend test-coverage.sh.`,
  );
}

// Wildcard whole-tree-dropout signal (wave 3): a wildcard key whose ENTIRE
// tree is missing from lcov used to be indistinguishable from the benign
// shadowed-by-specific-keys case — a coverage producer silently dying (or a
// leg being unwired) could de-gate a whole subtree while the gate stayed
// green. wildcardTreeDropouts (coverage-config.ts — this file has no
// import.meta.main guard, so testable helpers can't live here) fails loud
// when a pattern matches >=1 non-test/non-type, non-EXCLUDED file on disk
// but lcov contains NONE of its matches (shadowed or not).
const wildcardDropouts = wildcardTreeDropouts(
  thresholdGlobs.filter((t) => t.pat.includes("*")).map((t) => t.pat),
  [...perFile.keys()],
  (pat) => [...new Glob(escapeGlob(pat)).scanSync({ cwd: REPO_ROOT })],
);
violations.push(...wildcardDropouts);

if (violations.length > 0) {
  console.error(`Coverage gate FAILED (${violations.length} file(s) below threshold):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

if (enforced === 0) {
  console.error(
    "Coverage gate: no files matched any threshold rule — empty lcov or misconfigured thresholds",
  );
  process.exit(1);
}

console.log(`Coverage gate PASSED: ${enforced} enforced file(s) at or above threshold.`);
