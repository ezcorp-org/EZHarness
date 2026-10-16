/**
 * Every report the quality summary expects is written whenever the merged lcov exists (W4H-28 follow-up).
 *
 * WHY THIS FILE EXISTS
 *   In ci 38887660827 the "Per-file coverage gate" job's "Global coverage floor" failed, and the next step,
 *   "CRAP gate (touched functions)", had no `if:`: GitHub skipped it, crap.json was never written, and the
 *   "Quality summary" (`--expect coverage,crap`, `if: always()`) reported "MISSING REPORT: crap". The summary
 *   failed closed, as it should; the defect was upstream: a gate the summary expects must not depend on an
 *   unrelated sibling gate passing. Each expected report reads only the merged lcov, so each producer step runs
 *   `always()` once the merge itself succeeded — a failing floor, patch or per-file gate still fails the job.
 *
 * The producers are found, not listed: a step runs the script that writes the gate's report file
 * (scripts/quality-gates.ts GATE_REPORT_FILE; the script calls writeReport("<file>")).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { GATE_REPORT_FILE, type GateName } from "../../scripts/quality-gates.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
type Step = { name?: string; id?: string; if?: string; run?: string };
type Job = { name?: string; steps?: Step[] };
const workflow = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> };

/**
 * The jobs that merge coverage and run quality-report.ts --expect, with the gates they expect. (A job whose
 * reports do not come from a merged lcov, such as the mutation job, has its own producers and is not judged here.)
 */
const summaryJobs = Object.values(workflow.jobs).flatMap(job => {
  const summary = (job.steps ?? []).find(step => /scripts\/quality-report\.ts\b.*--expect\s+\S+/.test(step.run ?? ""));
  if (!summary || !(job.steps ?? []).some(step => (step.run ?? "").includes("scripts/merge-lcov.ts"))) return [];
  const expected = /--expect\s+(\S+)/.exec(summary.run!)![1]!.split(",") as GateName[];
  return [{ job, expected }];
});

/** The script under scripts/ that writes a report file. */
function producerScript(reportFile: string): string {
  const writers = readdirSync(join(REPO_ROOT, "scripts")).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter(name => readFileSync(join(REPO_ROOT, "scripts", name), "utf8").includes(`writeReport("${reportFile}"`));
  expect(writers).toHaveLength(1);
  return `scripts/${writers[0]}`;
}

describe("the quality summary's expected reports are produced whenever the merged lcov exists", () => {
  test("ci.yml has a coverage-merging job with a quality summary that expects gates", () => {
    expect(summaryJobs.length).toBeGreaterThan(0);
    for (const { expected } of summaryJobs) expect(expected.length).toBeGreaterThan(0);
  });

  for (const { job, expected } of summaryJobs) {
    const steps = job.steps ?? [];
    test(`${job.name}: the merged lcov comes from a merge-only step with an id`, () => {
      const merges = steps.filter(step => (step.run ?? "").includes("scripts/merge-lcov.ts"));
      expect(merges).toHaveLength(1);
      const merge = merges[0]!;
      expect(merge.id).toBeString();
      // Nothing after the merge in the same step, so the step's outcome is the merge's own.
      const commands = (merge.run ?? "").split("\n").map(line => line.trim()).filter(Boolean);
      expect(commands.filter(line => !/^mkdir -p coverage$/.test(line) && !line.includes("scripts/merge-lcov.ts"))).toEqual([]);
    });

    for (const gate of expected) {
      test(`${job.name}: every step that writes the "${gate}" report runs once the merge succeeded, whatever a sibling gate did`, () => {
        const script = producerScript(GATE_REPORT_FILE[gate]);
        const producers = steps.filter(step => (step.run ?? "").includes(script));
        expect(producers.length).toBeGreaterThan(0);
        const mergeId = steps.find(step => (step.run ?? "").includes("scripts/merge-lcov.ts"))?.id;
        for (const step of producers) {
          expect({ step: step.name, if: step.if ?? "" }).toEqual({ step: step.name, if: expect.stringContaining("always()") });
          expect({ step: step.name, if: step.if ?? "" }).toEqual({ step: step.name, if: expect.stringContaining(`steps.${mergeId}.outcome == 'success'`) });
        }
      });
    }
  }
});
