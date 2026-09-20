#!/usr/bin/env bun
/**
 * Turn a quality-gate run into a short structured summary an AI agent can act
 * on without reading the raw reports.
 *
 * Reads the report each gate writes (one file per gate):
 *   coverage/quality/global-coverage.json   ← scripts/check-global-coverage.ts
 *   coverage/quality/crap.json              ← scripts/crap-score.ts
 *   coverage/quality/mutation.json          ← Stryker's json reporter, or
 *   coverage/quality/mutation-summary.json  ← scripts/mutation.ts --changed when
 *                                             the diff had nothing to mutate
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
 *   bun scripts/quality-report.ts --expect coverage,crap          # JSON only
 *   bun scripts/quality-report.ts --expect mutation --text        # + digest
 *   bun scripts/quality-report.ts --expect coverage,crap --limit 20
 *
 * `--expect` is REQUIRED and names the gates the caller ran. FAIL-CLOSED: an
 * expected gate that wrote no report — because it crashed, timed out, or never
 * started — makes the summary `status: "fail"` with a finding naming the gate.
 * Before this, a gate that crashed simply wrote nothing, the reader skipped
 * it, and zero findings became `PASS / No failures`: the nightly reported
 * exactly that on a run in which every gate had died. "No data" must never
 * read as "no problem", and only the caller knows which data it asked for —
 * which is why there is no default. Only expected gates are read; a stale
 * report from a gate this run did not execute is not evidence.
 *
 * Always exits 0 — this reports, it does not gate. The gates already failed;
 * a reporter that also failed would just bury their exit codes.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadGates, REPORT_DIR, writeReport } from "./quality-gates.ts";

export type GateName = "coverage" | "crap" | "mutation";
export const GATE_NAMES: readonly GateName[] = ["coverage", "crap", "mutation"];

/** The report file each gate is responsible for writing. */
export const GATE_REPORT_FILE: Readonly<Record<GateName, string>> = {
  coverage: "global-coverage.json",
  crap: "crap.json",
  mutation: "mutation.json",
};
/** mutation.ts --changed writes this instead when the diff had nothing to mutate. */
export const MUTATION_SKIPPED_FILE = "mutation-summary.json";

export type Finding = {
  gate: GateName;
  severity: "error" | "warning";
  file: string;
  line: number | null;
  what: string;
  fix: string;
  detail?: Record<string, unknown>;
};

export type CoverageReport = {
  threshold: number;
  linePct: number;
  passed: boolean;
  coveredLines: number;
  totalLines: number;
  worstByMissingLines: { file: string; pct: number; missing: number }[];
};

export type CrapReport = {
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

export type Mutant = {
  id: string;
  mutatorName: string;
  replacement: string;
  status: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
};
export type MutationReport = {
  files: Record<string, { source: string; mutants: Mutant[] }>;
  projectRoot?: string;
};
export type MutationSkipped = { skipped: true; reason: string; mode?: string };

export type SummaryInputs = {
  /** The gates the caller ran — every one must have produced a report. */
  expected: readonly GateName[];
  coverage: CoverageReport | null;
  crap: CrapReport | null;
  mutation: MutationReport | null;
  /** mutation.ts's early-exit receipt; satisfies the mutation gate without a score. */
  mutationSkipped: MutationSkipped | null;
  mutationThreshold: number;
  limit: number;
  generatedAt?: string;
};

export type Summary = {
  generatedAt: string;
  status: "pass" | "fail";
  expected: GateName[];
  missing: GateName[];
  gates: Record<string, unknown>;
  totals: { errors: number; warnings: number; reported: number };
  truncated: boolean;
  findings: Finding[];
  warningsSample: Finding[];
};

/**
 * Parse `--expect a,b,c` into gate names. Throws on absence, an empty list,
 * an unknown name, or a duplicate — a typo here must not quietly narrow what
 * the summary is willing to call missing.
 */
export function parseExpected(args: readonly string[]): GateName[] {
  const idx = args.indexOf("--expect");
  const raw = idx >= 0 ? args[idx + 1] : undefined;
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error(
      `--expect <gate,...> is required (gates: ${GATE_NAMES.join(", ")}). ` +
        "Name the gates this run executed so a missing report fails instead of vanishing.",
    );
  }
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) throw new Error("--expect: empty gate list");
  const out: GateName[] = [];
  for (const n of names) {
    if (!(GATE_NAMES as readonly string[]).includes(n)) {
      throw new Error(`--expect: unknown gate "${n}" (gates: ${GATE_NAMES.join(", ")})`);
    }
    if (out.includes(n as GateName)) throw new Error(`--expect: "${n}" listed twice`);
    out.push(n as GateName);
  }
  return out;
}

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

function coverageFindings(cov: CoverageReport, gateStatus: Record<string, unknown>): Finding[] {
  gateStatus.coverage = { passed: cov.passed, linePct: cov.linePct, threshold: cov.threshold };
  if (cov.passed) return [];
  return cov.worstByMissingLines.slice(0, 10).map((f) => ({
    gate: "coverage" as const,
    severity: "error" as const,
    file: f.file,
    line: null,
    what: `Global line coverage is ${cov.linePct.toFixed(2)}%, below the ${cov.threshold}% floor. This file is missing ${f.missing} covered line(s) (at ${f.pct.toFixed(1)}%).`,
    fix: `Add tests covering the unexecuted lines in ${f.file}. It is one of the largest contributors to the shortfall.`,
    detail: { missingLines: f.missing, filePct: f.pct },
  }));
}

function crapFindings(crap: CrapReport, gateStatus: Record<string, unknown>): Finding[] {
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
  const severity: Finding["severity"] = crap.passed ? "warning" : "error";
  return crap.violations.map((v) => {
    // Which lever actually moves this score? At high coverage only splitting
    // the function helps (CRAP -> complexity as cov -> 1); at low coverage the
    // (1-cov)^3 term dominates and tests are far cheaper than a refactor.
    const coveragePct = v.coverage * 100;
    const fix =
      coveragePct >= 95
        ? `Split ${v.name}() — it is already ${coveragePct.toFixed(0)}% covered, so its CRAP is essentially its complexity (${v.complexity}). Only reducing complexity below ${crap.thresholds.maxScore} can pass.`
        : `Add tests for the uncovered lines in ${v.name}() (${v.uncoveredLines.slice(0, 12).join(", ")}${v.uncoveredLines.length > 12 ? ", …" : ""}). Coverage is ${coveragePct.toFixed(0)}%; the (1-coverage)^3 term dominates, so tests drop this score fastest.`;
    return {
      gate: "crap" as const,
      severity,
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
    };
  });
}

export type MutationTotals = {
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  /** Stryker's mutation score, 0-100: timeouts count as killed; NoCoverage counts against you. */
  score: number;
};

/**
 * Count a Stryker report the way Stryker scores it. Shared with
 * merge-mutation-reports.ts so the nightly's merged verdict and this summary
 * cannot disagree about what the score is.
 */
export function mutationTotals(mut: MutationReport): MutationTotals {
  const t = { killed: 0, timeout: 0, survived: 0, noCoverage: 0 };
  for (const rec of Object.values(mut.files)) {
    for (const m of rec.mutants) {
      if (m.status === "Killed") t.killed++;
      else if (m.status === "Timeout") t.timeout++;
      else if (m.status === "Survived") t.survived++;
      else if (m.status === "NoCoverage") t.noCoverage++;
    }
  }
  const detected = t.killed + t.timeout;
  const valid = detected + t.survived + t.noCoverage;
  return { ...t, score: valid > 0 ? (detected / valid) * 100 : 100 };
}

function mutationFindings(
  mut: MutationReport,
  threshold: number,
  gateStatus: Record<string, unknown>,
): Finding[] {
  const { killed, timeout, survived, noCoverage, score } = mutationTotals(mut);
  const survivors: { file: string; m: Mutant; source: string }[] = [];
  for (const [file, rec] of Object.entries(mut.files)) {
    for (const m of rec.mutants) {
      if (m.status === "Survived" || m.status === "NoCoverage") {
        survivors.push({ file, m, source: rec.source });
      }
    }
  }
  const passed = score + 1e-9 >= threshold;
  gateStatus.mutation = {
    score: Number(score.toFixed(2)),
    threshold,
    passed,
    killed,
    timeout,
    survived,
    noCoverage,
  };
  // Same rule as CRAP: survivors under a PASSING score are useful context, not
  // a build failure. Reporting them as errors would send a fix agent chasing
  // mutants on a green run.
  const severity: Finding["severity"] = passed ? "warning" : "error";

  // Survivors first (a test exists but does not assert), then NoCoverage
  // (no test reaches the line at all) — the first class is the higher-value
  // fix, because the test file to edit already exists.
  survivors.sort((a, b) => (a.m.status === b.m.status ? 0 : a.m.status === "Survived" ? -1 : 1));

  return survivors.map(({ file, m, source }) => {
    const rel = file.startsWith("/") ? file : `web/${file}`;
    const original = condense(originalText(source, m.location));
    const replacement = condense(m.replacement);
    const isNoCov = m.status === "NoCoverage";
    return {
      gate: "mutation" as const,
      severity,
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
    };
  });
}

/** The finding for an expected gate that left no report behind. */
function missingGateFinding(gate: GateName): Finding {
  const file = `coverage/quality/${GATE_REPORT_FILE[gate]}`;
  return {
    gate,
    severity: "error",
    file,
    line: null,
    what: `The ${gate} gate was expected to run but wrote no report (${file} is missing or unreadable). It crashed, timed out, or never started — nothing was measured, so this is not a pass.`,
    fix: `Read the ${gate} step's log for the error and fix the pipeline, not the code under test. A gate that produces no data must fail the run; do not treat this summary as green.`,
  };
}

/**
 * Fold the gate reports into one summary. Pure: no I/O, so the fail-closed
 * rule can be tested directly.
 */
export function buildSummary(inputs: SummaryInputs): Summary {
  const gateStatus: Record<string, unknown> = {};
  const findings: Finding[] = [];
  const missing: GateName[] = [];

  for (const gate of inputs.expected) {
    switch (gate) {
      case "coverage":
        if (inputs.coverage) findings.push(...coverageFindings(inputs.coverage, gateStatus));
        else missing.push(gate);
        break;
      case "crap":
        if (inputs.crap) findings.push(...crapFindings(inputs.crap, gateStatus));
        else missing.push(gate);
        break;
      case "mutation":
        if (inputs.mutation?.files) {
          findings.push(...mutationFindings(inputs.mutation, inputs.mutationThreshold, gateStatus));
        } else if (inputs.mutationSkipped?.skipped === true) {
          // The diff touched nothing mutatable. The gate ran and said so; that
          // receipt is the report for this run.
          gateStatus.mutation = { skipped: true, reason: inputs.mutationSkipped.reason };
        } else {
          missing.push(gate);
        }
        break;
    }
  }
  for (const gate of missing) {
    gateStatus[gate] = { ran: false };
    findings.push(missingGateFinding(gate));
  }

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  return {
    generatedAt: inputs.generatedAt ?? new Date().toISOString(),
    status: errors.length > 0 ? "fail" : "pass",
    expected: [...inputs.expected],
    missing,
    gates: gateStatus,
    totals: {
      errors: errors.length,
      warnings: warnings.length,
      reported: Math.min(errors.length, inputs.limit),
    },
    truncated: errors.length > inputs.limit,
    /** Only failures. Known-debt items are in `warningsSample`. */
    findings: errors.slice(0, inputs.limit),
    warningsSample: warnings.slice(0, 5),
  };
}

/** The compact digest printed under --text. */
export function renderText(summary: Summary, limit: number): string {
  const lines: string[] = [`\n=== Quality gates: ${summary.status.toUpperCase()} ===`];
  lines.push(`  expected: ${summary.expected.join(", ")}`);
  if (summary.missing.length > 0) lines.push(`  MISSING REPORT: ${summary.missing.join(", ")}`);
  for (const [name, st] of Object.entries(summary.gates)) {
    lines.push(`  ${name}: ${JSON.stringify(st)}`);
  }
  const { errors, warnings } = summary.totals;
  if (errors === 0) {
    lines.push(
      `\nNo failures.${warnings > 0 ? ` (${warnings} known-debt warning(s) recorded, not blocking.)` : ""}`,
    );
  } else {
    lines.push(`\n${errors} finding(s)${summary.truncated ? ` (showing ${limit})` : ""}:\n`);
    for (const f of summary.findings) {
      lines.push(`[${f.gate}] ${f.file}${f.line ? `:${f.line}` : ""}`);
      lines.push(`  what: ${f.what}`);
      lines.push(`  fix:  ${f.fix}\n`);
    }
  }
  return lines.join("\n");
}

async function readJson<T>(name: string): Promise<T | null> {
  const p = resolve(REPORT_DIR, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await Bun.file(p).text()) as T;
  } catch (err) {
    // Unreadable counts as absent: the gate that wrote it did not finish.
    console.error(`warning: ${name} is unreadable (${(err as Error).message}) — treating as missing`);
    return null;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let expected: GateName[];
  try {
    expected = parseExpected(args);
  } catch (err) {
    console.error(`usage: bun scripts/quality-report.ts --expect <gate,...> [--text] [--limit N]`);
    console.error(`  ${(err as Error).message}`);
    process.exit(2);
  }
  const asText = args.includes("--text");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1] ?? 25) : 25;
  const gates = await loadGates();

  const summary = buildSummary({
    expected,
    coverage: expected.includes("coverage")
      ? await readJson<CoverageReport>(GATE_REPORT_FILE.coverage)
      : null,
    crap: expected.includes("crap") ? await readJson<CrapReport>(GATE_REPORT_FILE.crap) : null,
    mutation: expected.includes("mutation")
      ? await readJson<MutationReport>(GATE_REPORT_FILE.mutation)
      : null,
    mutationSkipped: expected.includes("mutation")
      ? await readJson<MutationSkipped>(MUTATION_SKIPPED_FILE)
      : null,
    mutationThreshold: gates.mutation.scoreThreshold,
    limit,
  });
  const out = await writeReport("summary.json", summary);
  if (asText) console.log(renderText(summary, limit));
  console.log(`Structured summary: ${out}`);
}

if (import.meta.main) await main();
