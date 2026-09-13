#!/usr/bin/env bun
/**
 * Turn a failed quality-gate run into a short structured summary an AI agent
 * can act on without reading the raw reports.
 *
 * Reads whichever of these exist (each is written by its own gate):
 *   coverage/quality/crap.json             ← scripts/crap-score.ts
 *   coverage/quality/global-coverage.json  ← scripts/check-global-coverage.ts
 *   coverage/quality/mutation.json         ← Stryker's json reporter
 *
 * Emits coverage/quality/summary.json — a flat `findings[]` array where every
 * entry answers the same four questions: WHICH file, WHICH line, WHAT failed,
 * WHAT to do. A fix agent should need nothing else.
 *
 * For a surviving mutant the finding carries the original source text and the
 * replacement that survived. That pair IS the missing assertion: "the tests
 * still pass when `a <= b` becomes `a < b`" tells an agent exactly what to
 * assert, where reading a mutator name alone would not.
 *
 * USAGE
 *   bun scripts/quality-report.ts            # JSON to coverage/quality/summary.json
 *   bun scripts/quality-report.ts --text     # also print a compact digest
 *   bun scripts/quality-report.ts --limit 20 # cap findings (default 25)
 *
 * Always exits 0 — this reports, it does not gate. The gates already failed;
 * a reporter that also failed would just bury their exit codes.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadGates, REPORT_DIR, writeReport } from "./quality-gates.ts";

const args = process.argv.slice(2);
const asText = args.includes("--text");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1] ?? 25) : 25;

type Finding = {
  gate: "mutation" | "crap" | "coverage";
  severity: "error" | "warning";
  file: string;
  line: number | null;
  what: string;
  fix: string;
  detail?: Record<string, unknown>;
};

const findings: Finding[] = [];
const gateStatus: Record<string, unknown> = {};

async function readJson<T>(name: string): Promise<T | null> {
  const p = resolve(REPORT_DIR, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await Bun.file(p).text()) as T;
  } catch (err) {
    console.error(`warning: ${name} is unreadable (${(err as Error).message}) — skipping`);
    return null;
  }
}

const gates = await loadGates();

// ── Global coverage ────────────────────────────────────────────────────────
type CoverageReport = {
  threshold: number;
  linePct: number;
  passed: boolean;
  coveredLines: number;
  totalLines: number;
  worstByMissingLines: { file: string; pct: number; missing: number }[];
};
const cov = await readJson<CoverageReport>("global-coverage.json");
if (cov) {
  gateStatus.coverage = { passed: cov.passed, linePct: cov.linePct, threshold: cov.threshold };
  if (!cov.passed) {
    for (const f of cov.worstByMissingLines.slice(0, 10)) {
      findings.push({
        gate: "coverage",
        severity: "error",
        file: f.file,
        line: null,
        what: `Global line coverage is ${cov.linePct.toFixed(2)}%, below the ${cov.threshold}% floor. This file is missing ${f.missing} covered line(s) (at ${f.pct.toFixed(1)}%).`,
        fix: `Add tests covering the unexecuted lines in ${f.file}. It is one of the largest contributors to the shortfall.`,
        detail: { missingLines: f.missing, filePct: f.pct },
      });
    }
  }
}

// ── CRAP ───────────────────────────────────────────────────────────────────
type CrapReport = {
  scope: string;
  mode: string;
  passed: boolean;
  thresholds: { maxScore: number; warnScore: number; maxFullRepoViolations: number };
  totals: { violations: number; functionsScored: number };
  violations: {
    file: string;
    name: string;
    line: number;
    complexity: number;
    coverage: number;
    uncoveredLines: number[];
    crap: number;
  }[];
};
const crap = await readJson<CrapReport>("crap.json");
if (crap) {
  gateStatus.crap = {
    passed: crap.passed,
    mode: crap.mode,
    violations: crap.totals.violations,
    functionsScored: crap.totals.functionsScored,
    maxScore: crap.thresholds.maxScore,
  };
  // A passing full-repo ratchet still lists its frozen debt — as WARNINGS.
  // Only a gate that actually failed produces errors, so an agent driven by
  // this file works on what broke the build and not on the backlog.
  const crapSeverity: Finding["severity"] = crap.passed ? "warning" : "error";
  for (const v of crap.violations) {
    // Which lever actually moves this score? At high coverage only splitting
    // the function helps (CRAP -> complexity as cov -> 1); at low coverage the
    // (1-cov)^3 term dominates and tests are far cheaper than a refactor.
    const coveragePct = v.coverage * 100;
    const fix =
      coveragePct >= 95
        ? `Split ${v.name}() — it is already ${coveragePct.toFixed(0)}% covered, so its CRAP is essentially its complexity (${v.complexity}). Only reducing complexity below ${crap.thresholds.maxScore} can pass.`
        : `Add tests for the uncovered lines in ${v.name}() (${v.uncoveredLines.slice(0, 12).join(", ")}${v.uncoveredLines.length > 12 ? ", …" : ""}). Coverage is ${coveragePct.toFixed(0)}%; the (1-coverage)^3 term dominates, so tests drop this score fastest.`;
    findings.push({
      gate: "crap",
      severity: crapSeverity,
      file: v.file,
      line: v.line,
      what: `CRAP ${v.crap.toFixed(1)} exceeds ${crap.thresholds.maxScore} for ${v.name}() (complexity ${v.complexity}, coverage ${coveragePct.toFixed(0)}%).`,
      fix,
      detail: {
        function: v.name,
        complexity: v.complexity,
        coverage: Number(v.coverage.toFixed(4)),
        uncoveredLines: v.uncoveredLines,
      },
    });
  }
}

// ── Mutation ───────────────────────────────────────────────────────────────
type Mutant = {
  id: string;
  mutatorName: string;
  replacement: string;
  status: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
};
type MutationReport = {
  files: Record<string, { source: string; mutants: Mutant[] }>;
  projectRoot?: string;
};

/**
 * Squeeze a code fragment onto one short line.
 *
 * Stryker's `replacement` for a block-level mutant can run to many lines and
 * carry the comments attached to the node — one real case expanded a two-word
 * switch arm into a 5-line quote. A finding that long stops being a summary, so
 * comments go, whitespace collapses, and anything past `max` is elided.
 */
function condense(code: string, max = 120): string {
  const flat = code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)\/\/[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Slice the exact source text a mutant replaced, using its 1-based location. */
function originalText(source: string, loc: Mutant["location"]): string {
  const lines = source.split("\n");
  const { start, end } = loc;
  if (start.line === end.line) {
    return (lines[start.line - 1] ?? "").slice(start.column - 1, end.column - 1);
  }
  const first = (lines[start.line - 1] ?? "").slice(start.column - 1);
  const mid = lines.slice(start.line, end.line - 1);
  const last = (lines[end.line - 1] ?? "").slice(0, end.column - 1);
  return [first, ...mid, last].join("\n");
}

const mut = await readJson<MutationReport>("mutation.json");
if (mut?.files) {
  let killed = 0;
  let survived = 0;
  let noCoverage = 0;
  let timeout = 0;
  const survivors: { file: string; m: Mutant; source: string }[] = [];

  for (const [file, rec] of Object.entries(mut.files)) {
    for (const m of rec.mutants) {
      switch (m.status) {
        case "Killed":
          killed++;
          break;
        case "Timeout":
          timeout++;
          break;
        case "Survived":
          survived++;
          survivors.push({ file, m, source: rec.source });
          break;
        case "NoCoverage":
          noCoverage++;
          survivors.push({ file, m, source: rec.source });
          break;
      }
    }
  }
  // Stryker's score: timeouts count as killed; NoCoverage counts against you.
  const detected = killed + timeout;
  const valid = detected + survived + noCoverage;
  const score = valid > 0 ? (detected / valid) * 100 : 100;
  const threshold = gates.mutation.scoreThreshold;
  const mutationPassed = score + 1e-9 >= threshold;
  gateStatus.mutation = {
    score: Number(score.toFixed(2)),
    threshold,
    passed: mutationPassed,
    killed,
    timeout,
    survived,
    noCoverage,
  };
  // Same rule as CRAP: survivors under a PASSING score are useful context, not
  // a build failure. Reporting them as errors would send a fix agent chasing
  // mutants on a green run.
  const mutationSeverity: Finding["severity"] = mutationPassed ? "warning" : "error";

  // Survivors first (a test exists but does not assert), then NoCoverage
  // (no test reaches the line at all) — the first class is the higher-value
  // fix, because the test file to edit already exists.
  survivors.sort((a, b) => (a.m.status === b.m.status ? 0 : a.m.status === "Survived" ? -1 : 1));

  for (const { file, m, source } of survivors) {
    const rel = file.startsWith("/") ? file : `web/${file}`;
    const original = condense(originalText(source, m.location));
    const replacement = condense(m.replacement);
    const isNoCov = m.status === "NoCoverage";
    findings.push({
      gate: "mutation",
      severity: mutationSeverity,
      file: rel,
      line: m.location.start.line,
      what: isNoCov
        ? `No test executes this code, so the ${m.mutatorName} mutant \`${original}\` → \`${replacement}\` was never even run.`
        : `Surviving ${m.mutatorName} mutant: the suite still passes when \`${original}\` becomes \`${replacement}\`.`,
      fix: isNoCov
        ? `Add a test that executes ${rel}:${m.location.start.line}, then assert the behavior that \`${original}\` controls.`
        : `Add or tighten an assertion that fails when \`${original}\` is replaced by \`${replacement}\`. An existing test already runs this line — it just does not check the result.`,
      detail: {
        mutator: m.mutatorName,
        original,
        replacement,
        status: m.status,
        endLine: m.location.end.line,
      },
    });
  }
}

// ── Emit ───────────────────────────────────────────────────────────────────
const errors = findings.filter((f) => f.severity === "error");
const warnings = findings.filter((f) => f.severity === "warning");
const summary = {
  generatedAt: new Date().toISOString(),
  status: errors.length > 0 ? "fail" : "pass",
  gates: gateStatus,
  totals: {
    errors: errors.length,
    warnings: warnings.length,
    reported: Math.min(errors.length, LIMIT),
  },
  truncated: errors.length > LIMIT,
  /** Only failures. Known-debt items are in `warningsSample`. */
  findings: errors.slice(0, LIMIT),
  warningsSample: warnings.slice(0, 5),
};
const out = await writeReport("summary.json", summary);

if (asText) {
  console.log(`\n=== Quality gates: ${summary.status.toUpperCase()} ===`);
  for (const [name, st] of Object.entries(gateStatus)) {
    console.log(`  ${name}: ${JSON.stringify(st)}`);
  }
  if (errors.length === 0) {
    console.log(
      `\nNo failures.${warnings.length > 0 ? ` (${warnings.length} known-debt warning(s) recorded, not blocking.)` : ""}`,
    );
  } else {
    console.log(`\n${errors.length} finding(s)${summary.truncated ? ` (showing ${LIMIT})` : ""}:\n`);
    for (const f of errors.slice(0, LIMIT)) {
      console.log(`[${f.gate}] ${f.file}${f.line ? `:${f.line}` : ""}`);
      console.log(`  what: ${f.what}`);
      console.log(`  fix:  ${f.fix}\n`);
    }
  }
}
console.log(`Structured summary: ${out}`);
