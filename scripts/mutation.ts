#!/usr/bin/env bun
/**
 * Mutation-testing entrypoint — StrykerJS over the Vitest leg.
 *
 * The single place that turns scripts/quality-gates.json into a Stryker run, so
 * the break threshold has one home. web/stryker.config.json holds the mechanics
 * (runner, sandbox, reporters); this holds the policy.
 *
 * MODES
 *   bun scripts/mutation.ts --changed    PR gate: mutate only the files this
 *                                        PR touched that are in mutateGlobs.
 *                                        Exits 0 early when the diff touches
 *                                        no mutatable file.
 *   bun scripts/mutation.ts --full       Nightly: the whole mutateGlobs set.
 *   bun scripts/mutation.ts --full --incremental
 *                                        Reuse .cache/stryker-incremental.json.
 *
 *   --report-only   run and report, never exit non-zero (pilot mode)
 *   --dry-run       print the resolved Stryker argv and exit
 *
 * Full-suite mutation is far too slow for a PR — hence --changed. Stryker is
 * invoked from web/ because that is where vitest and its config live.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";
import { escapeGlob, REPO_ROOT } from "./coverage-config.ts";
import { changedLines, loadGates, REPORT_DIR, writeReport } from "./quality-gates.ts";

const WEB_DIR = resolve(REPO_ROOT, "web");
const args = new Set(process.argv.slice(2));
const changedOnly = args.has("--changed");
const full = args.has("--full");
const incremental = args.has("--incremental");
const reportOnly = args.has("--report-only");
const dryRun = args.has("--dry-run");
// Stryker's own dry run: instrument + run the covering tests ONCE, mutate
// nothing. Seconds instead of hours, and it fails on exactly the thing that
// makes a scope invalid — a test that cannot run inside the sandbox. Use it to
// validate mutateGlobs before paying for a full run.
const dryRunOnly = args.has("--dry-run-only");

if (changedOnly === full) {
  console.error("usage: bun scripts/mutation.ts (--changed | --full) [--incremental] [--report-only] [--dry-run]");
  process.exit(2);
}

const gates = await loadGates();

/**
 * Split mutateGlobs into positive and negative patterns and resolve them
 * against a list of web-relative paths. Stryker's own `!` negation syntax is
 * reproduced here so the PR path and the nightly path select from exactly the
 * same pattern list in scripts/quality-gates.json.
 */
function matchMutateGlobs(webRelPaths: string[]): string[] {
  const positive = gates.mutation.mutateGlobs.filter((p) => !p.startsWith("!"));
  const negative = gates.mutation.mutateGlobs
    .filter((p) => p.startsWith("!"))
    .map((p) => new Glob(escapeGlob(p.slice(1))));
  const pos = positive.map((p) => new Glob(escapeGlob(p)));
  return webRelPaths.filter((p) => pos.some((g) => g.match(p)) && !negative.some((g) => g.match(p)));
}

/**
 * The files the VITEST leg can actually measure, read from the
 * `--coverage.include=` allowlist in scripts/test-coverage.sh.
 *
 * This is the capability half of the scope, and skipping it is a measured bug,
 * not a theoretical one. `web/src/lib/workflow-yaml.ts` matches mutateGlobs and
 * is covered to 100% — by the BUN leg. Mutating it under vitest produced 62
 * NoCoverage mutants and a 0.00% file score that dragged a real 88% run down to
 * 80.09%, i.e. the gate nearly failed a PR over a file whose tests are fine.
 *
 * Deriving the list instead of hand-copying it means mutation scope cannot
 * drift from coverage scope: add a module to the vitest leg and it becomes
 * mutatable in the same commit. Note test-coverage.sh's own warning — that leg
 * is two hand-maintained allowlists that must agree; this reads the one that
 * says WHAT IS MEASURED.
 */
const COVERAGE_INCLUDE_SOURCES = [
  "scripts/web-vitest-coverage-includes.sh", // current home (275 patterns)
  "scripts/test-coverage.sh", // former home; kept so a move cannot silently empty the set
];

async function vitestMeasuredGlobs(): Promise<Glob[]> {
  // Both quoting styles: the manifest uses "--coverage.include=<p>" while the
  // older inline form was --coverage.include='<p>'. Matching only one is how
  // this silently returned zero patterns when the list moved between files.
  const RE = /--coverage\.include=(?:'([^']+)'|"([^"]+)"|([^\s"']+))/g;
  const patterns: string[] = [];
  for (const rel of COVERAGE_INCLUDE_SOURCES) {
    const file = Bun.file(resolve(REPO_ROOT, rel));
    if (!(await file.exists())) continue;
    const text = await file.text();
    for (const m of text.matchAll(RE)) {
      const pat = m[1] ?? m[2] ?? m[3];
      if (pat) patterns.push(pat);
    }
  }
  if (patterns.length === 0) {
    throw new Error(
      `no --coverage.include patterns found in ${COVERAGE_INCLUDE_SOURCES.join(" or ")} — ` +
        "the vitest leg's allowlist moved again. Refusing to mutate an unbounded set.",
    );
  }
  return [...new Set(patterns)].map((p) => new Glob(escapeGlob(p)));
}

const measuredGlobs = await vitestMeasuredGlobs();
const isVitestMeasured = (webRelPath: string): boolean =>
  measuredGlobs.some((g) => g.match(webRelPath));

let mutateArgs: string[] = [];

if (changedOnly) {
  const baseRef = process.env.BASE_REF ?? "origin/main";
  // Same merge-base diff the CRAP and patch-coverage gates read, so all three
  // agree on what "this PR changed". Keyed by REPO-relative path.
  const touchedLines = changedLines(baseRef);
  // Stryker runs with cwd=web/ and its patterns are web-relative, so strip the
  // prefix before matching.
  const webRel = [...touchedLines.keys()]
    .filter((f) => f.startsWith("web/"))
    .map((f) => f.slice("web/".length));
  const wanted = matchMutateGlobs(webRel).filter((p) => existsSync(resolve(WEB_DIR, p)));
  const selected = wanted.filter(isVitestMeasured);

  for (const skipped of wanted.filter((p) => !isVitestMeasured(p))) {
    console.log(
      `Mutation: skipping web/${skipped} — the vitest leg does not measure it ` +
        `(not in test-coverage.sh's --coverage.include list). Its tests, if any, run under bun.`,
    );
  }

  if (selected.length === 0) {
    console.log(
      `Mutation: no mutatable file in the diff against ${baseRef} ` +
        `(scope: ${gates.mutation.mutateGlobs.join(", ")}) — nothing to do.`,
    );
    await writeReport("mutation-summary.json", {
      generatedAt: new Date().toISOString(),
      mode: "changed",
      skipped: true,
      reason: "no mutatable files in diff",
      threshold: gates.mutation.scoreThreshold,
    });
    process.exit(0);
  }
  // Mutate only the LINES this PR touched, not whole files. Stryker accepts a
  // mutation range (`path:startLine-endLine`), and using it makes this gate
  // agree with the CRAP and patch-coverage gates about what a PR is answerable
  // for. Whole-file scoping punishes whoever edits one line of a weakly-tested
  // module: measured on main, `src/lib/format-duration.ts` scores 9.46%, so a
  // one-line change there would fail a PR for assertions its author never
  // wrote. That is how a gate gets bypassed instead of obeyed.
  const ranges: string[] = [];
  for (const f of selected) {
    const lines = [...(touchedLines.get(`web/${f}`) ?? new Set<number>())].sort((a, b) => a - b);
    if (lines.length === 0) continue;
    // Collapse the changed line numbers into contiguous runs.
    let start = lines[0] as number;
    let prev = start;
    for (const ln of lines.slice(1)) {
      if (ln === prev + 1) {
        prev = ln;
        continue;
      }
      ranges.push(`${f}:${start}-${prev}`);
      start = ln;
      prev = ln;
    }
    ranges.push(`${f}:${start}-${prev}`);
  }
  console.log(
    `Mutation: ${selected.length} changed file(s), ${ranges.length} changed line-range(s) in scope:`,
  );
  for (const f of selected) console.log(`  web/${f}`);
  mutateArgs = ["--mutate", ranges.join(",")];
} else {
  // --full: the same intersection, resolved over the tree rather than a diff.
  // The nightly must not inherit the NoCoverage trap either — and passing an
  // explicit list keeps the committed stryker.config.json `mutate` patterns
  // from silently widening the set.
  const positive = gates.mutation.mutateGlobs.filter((p) => !p.startsWith("!"));
  const found = new Set<string>();
  for (const pattern of positive) {
    for await (const rel of new Glob(pattern).scan({ cwd: WEB_DIR, onlyFiles: true })) {
      found.add(rel);
    }
  }
  const selected = matchMutateGlobs([...found]).filter(isVitestMeasured).sort();
  if (selected.length === 0) {
    console.error(
      "✗ --full selected 0 files. mutation.mutateGlobs and test-coverage.sh's " +
        "--coverage.include list no longer intersect — refusing to report a vacuous pass.",
    );
    process.exit(1);
  }
  console.log(
    `Mutation: ${selected.length} file(s) in scope ` +
      `(${found.size} matched mutateGlobs, ${found.size - selected.length} not measured by vitest)`,
  );
  mutateArgs = ["--mutate", selected.join(",")];
}

// Stryker 10 exposes NO --thresholds.* CLI flag (`stryker run --help` lists
// none), so the break score can only reach it through a config file. Rather
// than duplicate the number into web/stryker.config.json — two homes for one
// threshold, which is exactly what quality-gates.json exists to prevent — we
// derive a run config: the committed config, plus the threshold, written to a
// gitignored file that is deleted on the way out.
const BASE_CONFIG = resolve(WEB_DIR, "stryker.config.json");
const RUN_CONFIG = resolve(WEB_DIR, ".stryker-run.json");

const baseConfig = JSON.parse(await Bun.file(BASE_CONFIG).text()) as Record<string, unknown>;
delete baseConfig._comment; // documentation, not configuration
delete baseConfig.$schema; // relative to the committed file's name
const runConfig = {
  ...baseConfig,
  thresholds: {
    break: gates.mutation.scoreThreshold,
    // `low`/`high` only colour the reporter. Pinning them to the break score
    // keeps the console output from calling a failing run "high quality".
    low: gates.mutation.scoreThreshold,
    high: gates.mutation.scoreThreshold,
  },
};

const strykerArgs = [
  "stryker",
  "run",
  ".stryker-run.json",
  ...mutateArgs,
  ...(incremental ? ["--incremental"] : []),
  ...(dryRunOnly ? ["--dryRunOnly"] : []),
];

if (dryRun) {
  console.log(`cwd: ${WEB_DIR}`);
  console.log(`npx ${strykerArgs.join(" ")}`);
  console.log(`derived config: ${JSON.stringify(runConfig.thresholds)}`);
  process.exit(0);
}

// `.svelte-kit/tsconfig.json` is generated and gitignored; web/tsconfig.json
// extends it, and Stryker's sandbox is seeded from git. A missing one kills the
// run inside vite's dep optimizer with an error that never names the cause, so
// generate it up front rather than let that happen. See web/stryker.config.json.
if (!existsSync(resolve(WEB_DIR, ".svelte-kit/tsconfig.json"))) {
  console.log("Mutation: .svelte-kit/tsconfig.json missing — running svelte-kit sync");
  const sync = spawnSync("bunx", ["svelte-kit", "sync"], { cwd: WEB_DIR, stdio: "inherit" });
  if (sync.status !== 0) {
    console.error("✗ svelte-kit sync failed — Stryker cannot resolve web/tsconfig.json");
    process.exit(1);
  }
}

console.log(
  `\nMutation: break threshold ${gates.mutation.scoreThreshold}% ` +
    `(mutation.scoreThreshold in scripts/quality-gates.json)\n`,
);

await Bun.write(RUN_CONFIG, `${JSON.stringify(runConfig, null, 2)}\n`);
let run: ReturnType<typeof spawnSync>;
try {
  run = spawnSync("npx", strykerArgs, {
    cwd: WEB_DIR,
    stdio: "inherit",
    // PR runs are budgeted; the nightly is not. A diff big enough to blow the
    // budget would hold the merge queue behind a check nobody waits for, and
    // an unbounded PR gate is how mutation testing gets switched off.
    ...(changedOnly ? { timeout: gates.mutation.prBudgetMinutes * 60_000 } : {}),
  });
} finally {
  // finally, not a trailing unlink: a crash or a Stryker non-zero exit must
  // still not leave a stale derived config next to the committed one.
  rmSync(RUN_CONFIG, { force: true });
}

// A budget kill is NOT a quality verdict — say so, and fail regardless of
// --report-only. Silently passing a run that never finished would be the
// worst outcome available: a green check over an unmeasured diff.
if (run.signal === "SIGTERM" && changedOnly) {
  console.error(
    `\n✗ mutation run exceeded its ${gates.mutation.prBudgetMinutes}-minute budget ` +
      `(mutation.prBudgetMinutes) and was killed. This is not a score — nothing was ` +
      `measured. Split the PR, or raise the budget if the diff is legitimately large.`,
  );
  process.exit(1);
}

/**
 * Fail on any mutated file whose mutants are 100% NoCoverage.
 *
 * This is the guard against Stryker's `related` filter failing silently. That
 * filter cannot resolve $lib-aliased imports, and when it misses a file EVERY
 * mutant in it comes back NoCoverage — indistinguishable, in the score, from
 * genuinely untested code. Measured: 4 files scored 0% that way and pulled a
 * real suite down to 66.04%, while their tests existed and passed. Mutating a
 * file no test executes produces a number that means nothing, so the run must
 * say so rather than average it in.
 *
 * A file here is EITHER out of scope (its tests live in the bun leg — exclude
 * it in mutation.mutateGlobs) OR its tests import in a form vitest's module
 * graph cannot follow. Both are fixable; neither is a mutation score.
 */
async function unmeasuredFiles(): Promise<string[]> {
  const reportPath = resolve(REPORT_DIR, "mutation.json");
  if (!existsSync(reportPath)) return [];
  const report = JSON.parse(await Bun.file(reportPath).text()) as {
    files?: Record<string, { mutants: { status: string }[] }>;
  };
  const out: string[] = [];
  for (const [file, rec] of Object.entries(report.files ?? {})) {
    const total = rec.mutants.length;
    if (total === 0) continue;
    if (rec.mutants.every((m) => m.status === "NoCoverage")) out.push(file);
  }
  return out;
}

const unmeasured = await unmeasuredFiles();
if (unmeasured.length > 0) {
  console.error(
    `\n✗ ${unmeasured.length} mutated file(s) had NO test coverage at all — the score ` +
      `below is meaningless for them:\n`,
  );
  for (const f of unmeasured) console.error(`    web/${f}`);
  console.error(
    "\n  This is almost always Stryker's vitest `related` filter failing to follow a\n" +
      "  $lib-aliased import (it warns: 'Vitest failed to find test files related to\n" +
      "  mutated files'), NOT missing tests. Fix by either:\n" +
      "    - excluding the file in mutation.mutateGlobs if the bun leg owns its tests, or\n" +
      "    - having its test import the module by a path vitest's graph can follow.\n" +
      "  Verify a scope change cheaply: bun scripts/mutation.ts --full --dry-run-only",
  );
  if (!reportOnly) process.exit(1);
}

// Stryker exits 1 when the score is under thresholds.break. Anything else
// non-zero is an infrastructure failure and must stay loud either way —
// --report-only suppresses only the THRESHOLD verdict, never a broken run.
const code = run.status ?? 1;
if (code !== 0 && reportOnly) {
  console.log(`\n(--report-only: Stryker exited ${code}; not failing the build)`);
  process.exit(0);
}
process.exit(code);
