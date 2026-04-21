#!/usr/bin/env bun
/**
 * Parse coverage/lcov.info and enforce per-glob thresholds from
 * scripts/coverage-thresholds.json. Exits 1 on any violation.
 */
import { Glob } from "bun";
import { relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const LCOV_PATH = resolve(REPO_ROOT, "coverage/lcov.info");
const THRESHOLDS_PATH = resolve(REPO_ROOT, "scripts/coverage-thresholds.json");

// Files matching any of these globs are NOT enforced (generated / vendor / markup).
const EXCLUDES = [
  "src/extensions/sdk/init.ts",
  "src/db/migrations/**",
  "src/providers/**",
  "web/src/routes/**/+*.svelte",
  "web/e2e/**",
];

type FileCov = { totalLines: number; coveredLines: number; missed: number[] };

const thresholdsText = await Bun.file(THRESHOLDS_PATH).text();
const thresholds = JSON.parse(thresholdsText) as Record<string, number>;
const thresholdGlobs = Object.keys(thresholds).map((pat) => ({
  pat,
  glob: new Glob(pat),
  specificity: pat.replace(/\*/g, "").length,
  threshold: thresholds[pat] ?? 0,
}));
// Sort most-specific first so first match wins.
thresholdGlobs.sort((a, b) => b.specificity - a.specificity);

const excludeGlobs = EXCLUDES.map((p) => new Glob(p));

const lcov = await Bun.file(LCOV_PATH).text();
const perFile = new Map<string, FileCov>();
let curRec: FileCov | null = null;

for (const line of lcov.split("\n")) {
  if (line.startsWith("SF:")) {
    const abs = line.slice(3);
    const rel = relative(REPO_ROOT, abs);
    curRec = { totalLines: 0, coveredLines: 0, missed: [] };
    perFile.set(rel, curRec);
  } else if (!curRec) {
    continue;
  } else if (line === "end_of_record") {
    curRec = null;
  } else if (line.startsWith("DA:")) {
    const [lineNoStr, hitsStr] = line.slice(3).split(",");
    if (lineNoStr === undefined || hitsStr === undefined) continue;
    const hits = Number(hitsStr);
    curRec.totalLines++;
    if (hits > 0) curRec.coveredLines++;
    else curRec.missed.push(Number(lineNoStr));
  }
}

const violations: string[] = [];
let enforced = 0;
for (const [file, cov] of perFile) {
  if (excludeGlobs.some((g) => g.match(file))) continue;
  const match = thresholdGlobs.find((t) => t.glob.match(file));
  if (!match) continue;
  enforced++;
  if (cov.totalLines === 0) continue;
  const pct = (cov.coveredLines / cov.totalLines) * 100;
  if (pct + 1e-9 < match.threshold) {
    const missedCsv = cov.missed.slice(0, 40).join(",") + (cov.missed.length > 40 ? ",..." : "");
    violations.push(
      `${file}: ${pct.toFixed(2)}% < ${match.threshold}% — missed lines: ${missedCsv}`,
    );
  }
}

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
