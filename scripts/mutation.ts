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
 *   bun scripts/mutation.ts --full --shard I/N
 *                                        One of N deterministic slices of that
 *                                        set (see shardOf). The nightly runs
 *                                        the slices as a matrix and merges the
 *                                        reports with merge-mutation-reports.ts,
 *                                        because the whole set does not fit a
 *                                        hosted runner: 18797 mutants reached
 *                                        99.4% at 5h52m and the job cap is 6h.
 *   bun scripts/mutation.ts --full --incremental
 *                                        Reuse .cache/stryker-incremental.json.
 *
 *   --report-only   run and report; a score under the threshold does not exit
 *                   non-zero (pilot mode). ONLY the threshold verdict is
 *                   suppressed: a run that never produced a report — a timed-out
 *                   dry run, a crashed worker, a missing binary — still fails,
 *                   because nothing was measured. See mutationExitCode().
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
import {
  changedLines,
  loadGates,
  MUTATION_REPORT_FILE,
  MUTATION_SKIPPED_FILE,
  REPORT_DIR,
  writeReport,
} from "./quality-gates.ts";

const WEB_DIR = resolve(REPO_ROOT, "web");
/** Stryker's derived run config writes here. */
const MUTATION_REPORT = resolve(REPORT_DIR, MUTATION_REPORT_FILE);
/** --changed's early-exit receipt when the diff touched nothing mutatable. */
const MUTATION_SKIPPED = resolve(REPORT_DIR, MUTATION_SKIPPED_FILE);

export type StrykerRun = { status: number | null; signal: NodeJS.Signals | null };
export type MutationVerdict = { code: number; reason: string };

/** Add runtime-only mutation policy to Stryker's committed mechanics config. */
export function deriveStrykerRunConfig(
  baseConfig: Readonly<Record<string, unknown>>,
  scoreThreshold: number,
): Record<string, unknown> {
  return {
    ...baseConfig,
    // Keep Stryker's generated report aligned with every script that reads it.
    jsonReporter: {
      ...(baseConfig.jsonReporter as Record<string, unknown>),
      fileName: `../coverage/quality/${MUTATION_REPORT_FILE}`,
    },
    thresholds: {
      break: scoreThreshold,
      // `low`/`high` only colour the reporter. Pinning them to the break score
      // keeps the console output from calling a failing run "high quality".
      low: scoreThreshold,
      high: scoreThreshold,
    },
  };
}

/**
 * Turn a finished Stryker process into this script's exit code, honouring
 * --report-only for the THRESHOLD VERDICT ONLY.
 *
 * Stryker exits 1 both for "score under thresholds.break" and for "something
 * broke" — a timed-out initial test run, a crashed worker, a config error — so
 * the exit code alone cannot tell a verdict from a failure. The JSON report
 * can: Stryker writes it only after every mutant has been tested, so its
 * presence means the run completed and any non-zero exit IS the verdict, the
 * one thing --report-only exists to suppress. No report means nothing was
 * measured, and a green check over an unmeasured scope is the worst outcome
 * available — the nightly ran exactly that way for five nights, its dry run
 * timing out at 5 minutes and --report-only turning the exit into a pass.
 *
 * `reportProduced` must mean "written by THIS run": the caller deletes any
 * earlier report before starting Stryker, otherwise yesterday's file would
 * vouch for today's crash.
 */
export function mutationExitCode(
  run: StrykerRun,
  opts: { reportProduced: boolean; reportOnly: boolean },
): MutationVerdict {
  if (run.signal) {
    return { code: 1, reason: `Stryker was killed by ${run.signal} — nothing was measured` };
  }
  const code = run.status ?? 1;
  if (code === 0) return { code: 0, reason: "ok" };
  if (!opts.reportProduced) {
    return {
      code,
      reason:
        `Stryker exited ${code} without writing ${MUTATION_REPORT} — an infrastructure ` +
        "failure, not a score. Nothing was measured, so --report-only does not apply.",
    };
  }
  if (opts.reportOnly) {
    return {
      code: 0,
      reason: `--report-only: Stryker exited ${code} on the threshold verdict; not failing the build`,
    };
  }
  return { code, reason: `Stryker exited ${code}: score under the break threshold` };
}

export type Shard = { index: number; count: number };

/** Parse `I/N` (0-based index, 1-based count). Throws on anything else. */
export function parseShard(arg: string | undefined): Shard {
  const m = /^(\d+)\/(\d+)$/.exec(arg ?? "");
  if (!m) throw new Error(`--shard expects I/N (e.g. 2/6), got "${arg ?? ""}"`);
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (count < 1) throw new Error(`--shard: N must be >= 1, got ${count}`);
  if (index >= count) throw new Error(`--shard: I must be < N, got ${index}/${count}`);
  return { index, count };
}

/**
 * Slice `index` of `count` over an already-sorted list: every item lands in
 * exactly one slice, round-robin, so neighbouring files in one directory are
 * spread across shards rather than stacked into one. Deterministic for a given
 * input order, which is what lets N matrix jobs agree on a partition with no
 * coordination.
 */
export function shardOf<T>(items: readonly T[], shard: Shard): T[] {
  return items.filter((_, i) => i % shard.count === shard.index);
}

/**
 * Split mutateGlobs into positive and negative patterns and resolve them
 * against a list of web-relative paths. Stryker's own `!` negation syntax is
 * reproduced here so the PR path and the nightly path select from exactly the
 * same pattern list in scripts/quality-gates.json.
 */
function matchMutateGlobs(mutateGlobs: readonly string[], webRelPaths: string[]): string[] {
  const positive = mutateGlobs.filter((p) => !p.startsWith("!"));
  const negative = mutateGlobs
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

/**
 * Every mutated file whose mutants are 100% NoCoverage.
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
export function filesWithoutCoverage(report: {
  files?: Record<string, { mutants: { status: string }[] }>;
}): string[] {
  const out: string[] = [];
  for (const [file, rec] of Object.entries(report.files ?? {})) {
    const total = rec.mutants.length;
    if (total === 0) continue;
    if (rec.mutants.every((m) => m.status === "NoCoverage")) out.push(file);
  }
  return out;
}

async function unmeasuredFiles(): Promise<string[]> {
  if (!existsSync(MUTATION_REPORT)) return [];
  return filesWithoutCoverage(JSON.parse(await Bun.file(MUTATION_REPORT).text()));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
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
  const shardIdx = argv.indexOf("--shard");
  let shard: Shard | null = null;
  try {
    shard = shardIdx >= 0 ? parseShard(argv[shardIdx + 1]) : null;
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(2);
  }

  if (changedOnly === full || (shard && !full)) {
    console.error(
      "usage: bun scripts/mutation.ts (--changed | --full [--shard I/N]) [--incremental] [--report-only] [--dry-run]",
    );
    process.exit(2);
  }

  const gates = await loadGates();
  const measuredGlobs = await vitestMeasuredGlobs();
  const isVitestMeasured = (webRelPath: string): boolean =>
    measuredGlobs.some((g) => g.match(webRelPath));

  // Nothing from an earlier run may vouch for this one. mutationExitCode()
  // reads the report's presence as "Stryker finished", and quality-report.ts
  // reads either file as "the gate ran" — a stale copy would turn today's
  // crash into yesterday's pass.
  rmSync(MUTATION_REPORT, { force: true });
  rmSync(MUTATION_SKIPPED, { force: true });

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
    const wanted = matchMutateGlobs(gates.mutation.mutateGlobs, webRel).filter((p) =>
      existsSync(resolve(WEB_DIR, p)),
    );
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
      await writeReport(MUTATION_SKIPPED_FILE, {
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
    const inScope = matchMutateGlobs(gates.mutation.mutateGlobs, [...found])
      .filter(isVitestMeasured)
      .sort();
    if (inScope.length === 0) {
      console.error(
        "✗ --full selected 0 files. mutation.mutateGlobs and test-coverage.sh's " +
          "--coverage.include list no longer intersect — refusing to report a vacuous pass.",
      );
      process.exit(1);
    }
    console.log(
      `Mutation: ${inScope.length} file(s) in scope ` +
        `(${found.size} matched mutateGlobs, ${found.size - inScope.length} not measured by vitest)`,
    );
    const selected = shard ? shardOf(inScope, shard) : inScope;
    if (shard) {
      console.log(`Mutation: shard ${shard.index}/${shard.count} → ${selected.length} file(s):`);
      for (const f of selected) console.log(`  web/${f}`);
      if (selected.length === 0) {
        console.error(`✗ shard ${shard.index}/${shard.count} is empty — more shards than files in scope.`);
        process.exit(1);
      }
    }
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
  const runConfig = deriveStrykerRunConfig(baseConfig, gates.mutation.scoreThreshold);

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

  // spawnSync reports a process that could not start (no `npx` on PATH) as an
  // error with a null status; that is an infrastructure failure like any other.
  if (run.error) console.error(`✗ could not run Stryker: ${run.error.message}`);
  const verdict = mutationExitCode(
    { status: run.status, signal: run.signal },
    { reportProduced: existsSync(MUTATION_REPORT), reportOnly },
  );
  if (verdict.code !== 0) console.error(`\n✗ ${verdict.reason}`);
  else if (verdict.reason !== "ok") console.log(`\n(${verdict.reason})`);
  process.exit(verdict.code);
}

if (import.meta.main) await main();
