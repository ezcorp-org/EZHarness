#!/usr/bin/env bun
/**
 * CRAP (Change Risk Anti-Patterns) gate.
 *
 *     CRAP(f) = complexity(f)^2 * (1 - coverage(f))^3 + complexity(f)
 *
 * Complexity is McCabe cyclomatic complexity from the TypeScript AST; coverage
 * is the line coverage of that function's own lines, read from the
 * `coverage/lcov.info` the existing coverage pipeline already merges. The two
 * inputs are the ones the repo already trusts — this gate adds no new
 * instrumentation and never re-runs the suite.
 *
 * WHY A SCRIPT AND NOT A PACKAGE: no maintained CRAP tool fits this repo.
 * Measured on npm 2026-09-13 — crap-score (2287 dl/wk) and crap4ts (379) want
 * Istanbul JSON, which neither `bun --coverage` nor this pipeline emits;
 * crap4js (124 dl/wk) reads lcov but is beta; all three insist on driving the
 * test run themselves, which would mean a second, disagreeing coverage number
 * next to the gate's. Reading the merged lcov keeps one source of truth.
 *
 * The metric's own guidance sets the threshold: at 100% coverage CRAP equals
 * complexity, so a limit of 30 lets complexity <=5 pass untested and makes
 * complexity >30 unpassable at any coverage. That is the point — it is a
 * change-RISK signal, not a style rule.
 *
 * USAGE
 *   bun scripts/crap-score.ts                  # score everything, enforce
 *   bun scripts/crap-score.ts --changed        # only files in this PR's diff
 *   bun scripts/crap-score.ts --report-only    # never exit non-zero
 *   bun scripts/crap-score.ts --top 20         # print the N worst
 *
 * Writes coverage/quality/crap.json for quality-report.ts to consume.
 * Exits 1 if any scored function exceeds crap.maxScore.
 */
import { Glob } from "bun";
import { resolve } from "node:path";
import ts from "typescript";
import { escapeGlob, isExcluded, isTestOrTypeFile, REPO_ROOT } from "./coverage-config.ts";
import { changedLines, loadGates, loadLcov, writeReport } from "./quality-gates.ts";

// ── AST: cyclomatic complexity ─────────────────────────────────────────────

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

/**
 * Does `node` add a branch to the control-flow graph?
 *
 * Classic McCabe (if/loop/case/catch/ternary) plus the short-circuit operators
 * `&&`, `||`, `??`. Including them is what every JS/TS complexity tool does and
 * it matters here: idiomatic TypeScript expresses branches as `a ?? b` far more
 * often than as an `if`, and a metric blind to that would score a dense guard
 * chain as complexity 1.
 *
 * A `CaseClause` counts only when it has statements — a fall-through label
 * (`case 'a': case 'b': return x`) is one branch, not two.
 */
function isDecisionPoint(node: ts.Node): boolean {
  switch (node.kind) {
    case ts.SyntaxKind.IfStatement:
    case ts.SyntaxKind.ConditionalExpression:
    case ts.SyntaxKind.ForStatement:
    case ts.SyntaxKind.ForInStatement:
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.WhileStatement:
    case ts.SyntaxKind.DoStatement:
    case ts.SyntaxKind.CatchClause:
      return true;
    case ts.SyntaxKind.CaseClause:
      return (node as ts.CaseClause).statements.length > 0;
    case ts.SyntaxKind.BinaryExpression: {
      const op = (node as ts.BinaryExpression).operatorToken.kind;
      return (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      );
    }
    default:
      return false;
  }
}

/**
 * McCabe complexity of one function, NOT counting nested functions.
 *
 * A callback's branches belong to the callback — it is scored as its own entry.
 * Rolling them into the parent would make every module with an inline
 * `.map(x => ...)` look like one giant untestable function.
 */
function complexityOf(fn: FunctionLike): number {
  let complexity = 1;
  const visit = (node: ts.Node): void => {
    if (node !== fn && isFunctionLike(node)) return; // nested fn scored separately
    if (isDecisionPoint(node)) complexity++;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return complexity;
}

/**
 * A readable name for the report. Arrow functions and function expressions are
 * usually bound to something (`const parse = () => …`, `{ handler: () => … }`);
 * walk one level up for that binding before giving up and using the position.
 */
function nameOf(fn: FunctionLike, sf: ts.SourceFile): string {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn) && fn.name) {
    return fn.name.getText(sf);
  }
  if (ts.isConstructorDeclaration(fn)) {
    const cls = fn.parent;
    return ts.isClassLike(cls) && cls.name ? `${cls.name.getText(sf)}.constructor` : "constructor";
  }
  const p = fn.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyAssignment(p)) return p.name.getText(sf);
  if (ts.isPropertyDeclaration(p) && p.name) return p.name.getText(sf);
  if (ts.isCallExpression(p) && ts.isIdentifier(p.expression)) {
    return `${p.expression.text}() callback`;
  }
  const { line } = sf.getLineAndCharacterOfPosition(fn.getStart(sf));
  return `<anonymous@${line + 1}>`;
}

// ── Scoring ────────────────────────────────────────────────────────────────

export type CrapEntry = {
  file: string;
  name: string;
  line: number;
  endLine: number;
  complexity: number;
  /** 0..1 over the function's own MEASURED lines. */
  coverage: number;
  coveredLines: number;
  measuredLines: number;
  uncoveredLines: number[];
  crap: number;
};

/** CRAP = comp^2 * (1 - cov)^3 + comp, with `cov` in 0..1. */
export function crapScore(complexity: number, coverage: number): number {
  const uncovered = 1 - coverage;
  return complexity ** 2 * uncovered ** 3 + complexity;
}

/**
 * Score every function in one file.
 *
 * Functions whose lines carry NO lcov record are skipped, not scored as 0%.
 * An unmeasured function means "no producer covers this path" — that is the
 * per-file coverage gate's complaint to make (it already fails on
 * `0 measured lines`), and scoring it here would double-report one defect as
 * a pile of fake CRAP violations.
 */
export function scoreFile(
  relPath: string,
  source: string,
  measured: Set<number>,
  hits: Set<number>,
): CrapEntry[] {
  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true);
  const out: CrapEntry[] = [];

  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && node.body) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

      let measuredCount = 0;
      let coveredCount = 0;
      const uncovered: number[] = [];
      for (let ln = start; ln <= end; ln++) {
        if (!measured.has(ln)) continue;
        measuredCount++;
        if (hits.has(ln)) coveredCount++;
        else uncovered.push(ln);
      }

      if (measuredCount > 0) {
        const complexity = complexityOf(node);
        const coverage = coveredCount / measuredCount;
        out.push({
          file: relPath,
          name: nameOf(node, sf),
          line: start,
          endLine: end,
          complexity,
          coverage,
          coveredLines: coveredCount,
          measuredLines: measuredCount,
          uncoveredLines: uncovered.slice(0, 40),
          crap: crapScore(complexity, coverage),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

// ── CLI ────────────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const reportOnly = args.has("--report-only");
const changedOnly = args.has("--changed");
const topArg = process.argv.indexOf("--top");
const topN = topArg >= 0 ? Number(process.argv[topArg + 1] ?? 15) : 15;

const gates = await loadGates();
const { hits, measured } = await loadLcov();

const enforceGlobs = gates.crap.enforceGlobs.map((p) => new Glob(escapeGlob(p)));
const inScope = (f: string): boolean =>
  !isExcluded(f) && !isTestOrTypeFile(f) && enforceGlobs.some((g) => g.match(f));

// Candidate set: every file the merged lcov measured, optionally narrowed to
// this PR's diff. Driving off lcov (not a filesystem walk) means the gate can
// only ever judge files coverage actually measured.
let candidates = [...measured.keys()].filter(inScope);

// In --changed mode the gate judges only the functions the PR TOUCHED, not
// every function in a file it happened to open. Scoring whole files would make
// a one-line fix in a legacy module inherit that module's worst function — the
// gate would then punish the person who came nearest to it, which is how
// quality gates get bypassed instead of obeyed.
let touchedLines: Map<string, Set<number>> | null = null;
if (changedOnly) {
  const baseRef = process.env.BASE_REF ?? "origin/main";
  touchedLines = changedLines(baseRef);
  candidates = candidates.filter((f) => (touchedLines?.get(f)?.size ?? 0) > 0);
  console.log(`CRAP: --changed against ${baseRef} → ${candidates.length} measured file(s) in diff`);
}

const entries: CrapEntry[] = [];
for (const rel of candidates) {
  const abs = resolve(REPO_ROOT, rel);
  const file = Bun.file(abs);
  if (!(await file.exists())) continue; // deleted in this diff
  let scored = scoreFile(
    rel,
    await file.text(),
    measured.get(rel) ?? new Set(),
    hits.get(rel) ?? new Set(),
  );
  if (touchedLines) {
    const added = touchedLines.get(rel) ?? new Set<number>();
    scored = scored.filter((e) => {
      for (const ln of added) if (ln >= e.line && ln <= e.endLine) return true;
      return false;
    });
  }
  entries.push(...scored);
}

entries.sort((a, b) => b.crap - a.crap);
const violations = entries.filter((e) => e.crap > gates.crap.maxScore);
const warnings = entries.filter(
  (e) => e.crap > gates.crap.warnScore && e.crap <= gates.crap.maxScore,
);

// The VERDICT differs by mode and quality-report.ts must not re-derive it:
// in --changed mode any violation fails, but in full-repo mode the gate passes
// while the count stays at or under the ratchet ceiling. Recording `passed`
// here is what stops the reporter from calling 71 items of frozen, known debt
// a build failure.
const passed = changedOnly
  ? violations.length === 0
  : violations.length <= gates.crap.maxFullRepoViolations;

await writeReport("crap.json", {
  generatedAt: new Date().toISOString(),
  scope: changedOnly ? "changed" : "all",
  mode: changedOnly ? "touched-functions" : "full-repo-ratchet",
  passed,
  thresholds: {
    maxScore: gates.crap.maxScore,
    warnScore: gates.crap.warnScore,
    maxFullRepoViolations: gates.crap.maxFullRepoViolations,
  },
  totals: {
    filesScored: candidates.length,
    functionsScored: entries.length,
    violations: violations.length,
    warnings: warnings.length,
  },
  violations,
  worst: entries.slice(0, 50),
});

const fmt = (e: CrapEntry): string =>
  `  ${e.crap.toFixed(1).padStart(7)}  cc=${String(e.complexity).padStart(3)} ` +
  `cov=${(e.coverage * 100).toFixed(0).padStart(3)}%  ${e.file}:${e.line} ${e.name}`;

console.log(
  `\nCRAP: ${entries.length} functions in ${candidates.length} files ` +
    `(max ${gates.crap.maxScore}, warn ${gates.crap.warnScore})`,
);
if (entries.length > 0) {
  console.log(`\nWorst ${Math.min(topN, entries.length)}:`);
  for (const e of entries.slice(0, topN)) console.log(fmt(e));
}
if (warnings.length > 0) {
  console.log(`\n${warnings.length} function(s) above the warn line (not failing).`);
}

const HOW_TO_FIX =
  "\n  fix: add tests for the uncovered lines (the (1-cov)^3 term falls fastest),\n" +
  "       or split the function (lowers the comp^2 term). Report: coverage/quality/crap.json";

if (changedOnly) {
  // PR mode: every function this PR touched must clear the bar.
  if (violations.length > 0) {
    console.log(`\n✗ ${violations.length} function(s) you touched are over CRAP ${gates.crap.maxScore}:`);
    for (const e of violations) console.log(fmt(e));
    console.log(HOW_TO_FIX);
    if (!reportOnly) process.exit(1);
  } else {
    console.log(`\n✓ no touched function exceeds CRAP ${gates.crap.maxScore}`);
  }
} else {
  // Full-repo mode: ratchet the EXISTING debt. The count may fall, never rise.
  const ceiling = gates.crap.maxFullRepoViolations;
  if (violations.length > ceiling) {
    console.log(
      `\n✗ CRAP ratchet broken: ${violations.length} function(s) over ${gates.crap.maxScore}, ` +
        `ceiling is ${ceiling} (crap.maxFullRepoViolations).`,
    );
    for (const e of violations.slice(0, 25)) console.log(fmt(e));
    console.log(HOW_TO_FIX);
    if (!reportOnly) process.exit(1);
  } else {
    console.log(
      `\n✓ CRAP ratchet holds: ${violations.length} violation(s) <= ceiling ${ceiling}` +
        (violations.length < ceiling
          ? `\n  debt fell by ${ceiling - violations.length} — lower crap.maxFullRepoViolations to ` +
            `${violations.length} in scripts/quality-gates.json to lock the win in.`
          : ""),
    );
  }
}
