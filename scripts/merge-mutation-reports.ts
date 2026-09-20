#!/usr/bin/env bun
/**
 * Merge the per-shard Stryker JSON reports the nightly matrix produces into
 * the single coverage/quality/mutation.json that quality-report.ts reads, and
 * decide the nightly's threshold verdict on the MERGED score.
 *
 * WHY SHARDS. The whole mutateGlobs scope does not fit one hosted runner:
 * measured 2026-09-20, 186 files instrumented to 18797 mutants reached 99.4%
 * at 5h52m and the job cap is 6h. mutation-nightly.yml therefore runs
 * `mutation.ts --full --shard I/N` as a matrix, each shard uploads its
 * mutation.json, and this merges them. A per-shard score is a slice of the
 * tree and means nothing on its own, so shards always run --report-only and
 * the break threshold is applied here, once.
 *
 * USAGE
 *   bun scripts/merge-mutation-reports.ts --shards N [--enforce] <glob> [<glob>...]
 *
 * FAIL-CLOSED: exactly N reports must be found. A shard that died leaves no
 * report; merging the survivors would publish a score over a partial tree
 * with nothing to say so. Overlapping shards (a file in two reports) are an
 * error for the same reason in the other direction.
 *
 * --enforce   exit 1 when the merged score is under mutation.scoreThreshold,
 *             or when any file came back 100% NoCoverage (a scope error, see
 *             mutation.ts). Without it both are printed and the exit is 0.
 */
import { Glob } from "bun";
import { REPO_ROOT } from "./coverage-config.ts";
import { filesWithoutCoverage } from "./mutation.ts";
import { loadGates, writeReport } from "./quality-gates.ts";
import { type MutationReport, mutationTotals } from "./quality-report.ts";

/**
 * Union the `files` maps. The first report's envelope (schemaVersion,
 * thresholds, projectRoot, …) is kept so the result is still a valid Stryker
 * report for any tool that reads one.
 */
export function mergeMutationReports(reports: readonly MutationReport[]): MutationReport {
  if (reports.length === 0) throw new Error("nothing to merge");
  const files: MutationReport["files"] = {};
  for (const r of reports) {
    for (const [file, rec] of Object.entries(r.files ?? {})) {
      if (files[file]) {
        throw new Error(`"${file}" appears in more than one shard report — the shards overlap`);
      }
      files[file] = rec;
    }
  }
  return { ...(reports[0] as MutationReport), files };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const shardsIdx = argv.indexOf("--shards");
  const count = shardsIdx >= 0 ? Number(argv[shardsIdx + 1]) : Number.NaN;
  const enforce = argv.includes("--enforce");
  const globs = argv.filter((a, i) => !a.startsWith("--") && i !== shardsIdx + 1);
  if (!Number.isInteger(count) || count < 1 || globs.length === 0) {
    console.error("usage: bun scripts/merge-mutation-reports.ts --shards N [--enforce] <glob> [<glob>...]");
    process.exit(2);
  }

  const paths = new Set<string>();
  for (const g of globs) {
    for await (const p of new Glob(g).scan({ cwd: REPO_ROOT, absolute: true, onlyFiles: true })) {
      paths.add(p);
    }
  }
  const found = [...paths].sort();
  console.log(`Mutation merge: ${found.length} shard report(s) found, ${count} expected`);
  for (const p of found) console.log(`  ${p}`);
  if (found.length !== count) {
    console.error(
      `\n✗ expected exactly ${count} shard report(s) (--shards) and found ${found.length}. ` +
        "A shard that produced no report measured nothing; a merged score over the rest " +
        "would be a number over a partial tree. Check the failed shard's log.",
    );
    process.exit(1);
  }

  const reports = await Promise.all(
    found.map(async (p) => JSON.parse(await Bun.file(p).text()) as MutationReport),
  );
  const merged = mergeMutationReports(reports);
  const out = await writeReport("mutation.json", merged);
  const totals = mutationTotals(merged);
  const gates = await loadGates();
  const threshold = gates.mutation.scoreThreshold;
  console.log(
    `\nMutation merge: ${Object.keys(merged.files).length} file(s) → ${out}\n` +
      `Final mutation score ${totals.score.toFixed(2)}% (threshold ${threshold}%): ` +
      `${totals.killed} killed, ${totals.timeout} timed out, ${totals.survived} survived, ` +
      `${totals.noCoverage} no coverage`,
  );

  let failed = false;
  const unmeasured = filesWithoutCoverage(merged);
  if (unmeasured.length > 0) {
    console.error(
      `\n✗ ${unmeasured.length} mutated file(s) had NO test coverage at all — a scope error, ` +
        "not a score (see scripts/mutation.ts):",
    );
    for (const f of unmeasured) console.error(`    web/${f}`);
    failed = true;
  }
  if (totals.score + 1e-9 < threshold) {
    console.error(`\n✗ Final mutation score ${totals.score.toFixed(2)}% under breaking threshold ${threshold}%`);
    failed = true;
  }
  if (failed && !enforce) {
    console.log("\n(report-only: not failing the build; pass --enforce to gate on the merged verdict)");
  }
  process.exit(failed && enforce ? 1 : 0);
}

if (import.meta.main) await main();
