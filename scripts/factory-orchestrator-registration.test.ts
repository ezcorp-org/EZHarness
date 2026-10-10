import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { DESIRED_REQUIRED_CHECKS } from "./check-required-checks";
import { SOURCE_GLOBS, V8_CANONICAL_SOURCES } from "./coverage-config";

describe("factory Temporal gate registration", () => {
  test("owns every Node orchestrator source with one canonical producer", async () => {
    const thresholds = JSON.parse(await readFile("scripts/coverage-thresholds.json", "utf8"));
    const sources = ["contracts", "definition-pages", "dispatcher", "gateway-activities", "inbox", "index", "partition-plan", "process", "queue-client", "transition-pages", "validation", "worker", "workflow"].map((name) => `packages/@ezcorp/factory-orchestrator/src/${name}.ts`);
    expect(SOURCE_GLOBS).toContain("packages/@ezcorp/factory-orchestrator/src/**/*.ts");
    for (const source of sources) {
      expect(thresholds[source]).toBe(100);
      expect(V8_CANONICAL_SOURCES).toContain(source);
    }
    for (const source of ["src/factory/orchestration-process.ts", "src/factory/orchestration-readiness-writer.ts"]) {
      expect(thresholds[source]).toBe(100);
      expect(V8_CANONICAL_SOURCES).toContain(source);
    }
  });

  test("runs the pinned real Temporal lane before accepting its coverage", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    const producer = await readFile("scripts/factory-orchestrator-coverage.sh", "utf8");
    expect(producer).toContain("factory_orchestrator_test_files");
    expect(producer).toContain("FACTORY_ORCHESTRATOR_TESTS[@]");
    expect(producer).toContain('timeout --signal=TERM --kill-after=30s "$INNER_TIMEOUT_S"');
    expect(producer).toContain("--test-concurrency=1");
    expect(producer).toContain("--test-reporter=spec");
    expect(producer).toContain("test-progress.log");
    expect(producer).toContain("XDG_RUNTIME_DIR");
    expect(producer).toContain("src/factory/orchestration-process.ts");
    expect(producer).toContain("src/factory/orchestration-readiness-writer.ts");
    expect(workflow).toContain("name: Factory Temporal integration");
    expect(workflow).toContain("temporal-test-server_1.38.0_linux_amd64.tar.gz");
    expect(workflow).toContain("41df834fe8e1ac59619e13908f41b63e4d1054f37634a2f89033d8cf6af71b96");
    expect(workflow).toContain("FACTORY_TEMPORAL_TEST_SERVER: /tmp/factory-tools/temporal-test-server/temporal-test-server_1.38.0_linux_amd64/temporal-test-server");
    expect(workflow).toContain("bash scripts/factory-orchestrator-coverage.sh");
    expect(workflow).toContain("needs.factory-temporal.result");
    expect(DESIRED_REQUIRED_CHECKS).toContain("Factory Temporal integration");
  });
});

// Hosted run 38001537073 (W4H-21): the job hit its timeout-minutes with an empty log. The producer must instead name the
// hanging test, print its totals and exit before the job timeout. Seconds the job needs AFTER the inner kill grace ends:
// the steps before the script (28 s on green run 37986983940, 33 s on 38001537073), the two package builds in the script
// (5 s locally), the steps after it (2 s on the green run), and about 80 s of slack for a slower hosted runner.
const JOB_MARGIN_SECONDS = 120;

type WorkflowStep = { name?: string; if?: string; uses?: string; with?: Record<string, unknown> };

async function temporalLane() {
  const workflow = Bun.YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as {
    jobs: Record<string, { "timeout-minutes": number; steps: WorkflowStep[] }>;
  };
  const producer = await readFile("scripts/factory-orchestrator-coverage.sh", "utf8");
  const setting = (name: string) => Number(new RegExp(`^${name}=(\\d+)$`, "m").exec(producer)?.[1] ?? Number.NaN);
  const killAfter = /timeout --signal=TERM --kill-after=(\d+)s "\$INNER_TIMEOUT_S"/.exec(producer);
  return {
    job: workflow.jobs["factory-temporal"],
    producer,
    innerSeconds: killAfter ? setting("INNER_TIMEOUT_S") : Number.NaN,
    killAfterSeconds: killAfter ? Number(killAfter[1]) : Number.NaN,
    perTestMs: setting("PER_TEST_TIMEOUT_MS"),
    reporters: [...producer.matchAll(/--test-reporter=(\S+) --test-reporter-destination=(\S+)/g)].map(([, reporter, destination]) => [reporter, destination]),
  };
}

describe("factory Temporal producer fails loudly before the job timeout", () => {
  test("(a) the inner timeout and its kill grace end at least the margin before the job timeout, so the totals print", async () => {
    const lane = await temporalLane();
    expect(lane.innerSeconds).toBeGreaterThan(0);
    expect(lane.innerSeconds + lane.killAfterSeconds + JOB_MARGIN_SECONDS).toBeLessThanOrEqual(lane.job["timeout-minutes"] * 60);
  });

  test("(b) a per-test timeout ends one hanging test by name before the inner timeout, and its open handles cannot hold the file", async () => {
    const lane = await temporalLane();
    expect(lane.producer).toContain('node --test --test-concurrency=1 --test-timeout="$PER_TEST_TIMEOUT_MS" --test-force-exit');
    expect(lane.perTestMs).toBeGreaterThan(0);
    expect(lane.perTestMs).toBeLessThan(lane.innerSeconds * 1000);
  });

  test("(c) the spec reporter writes to stdout as well as to the progress log", async () => {
    const lane = await temporalLane();
    expect(lane.reporters).toContainEqual(["spec", "stdout"]);
    expect(lane.producer).toMatch(/"\$\{FACTORY_ORCHESTRATOR_TESTS\[@\]\}" \| tee "\$COV_OUT\/test-progress\.log"\nnode_status=\$\{PIPESTATUS\[0\]\}\n/);
  });

  test("(d) a failed or timed-out run prints the progress-log tail and the totals, then exits with the run's status", async () => {
    const { producer } = await temporalLane();
    const failure = /\nif \[ "\$node_status" -ne 0 \]; then\n([\s\S]*?)\nfi\n/.exec(producer);
    expect(failure?.[1]).toContain('tail -n "$PROGRESS_TAIL_LINES" "$COV_OUT/test-progress.log"');
    const after = producer.slice((failure?.index ?? producer.length) + (failure?.[0].length ?? 0));
    expect(after).toStartWith('set -e\nprint_node_totals "$COV_OUT/test-progress.log"\n[ "$node_status" -eq 0 ] || exit "$node_status"\n');
  });

  test("(e) the job uploads the progress log on every outcome, and only that upload runs on failure", async () => {
    const { job } = await temporalLane();
    const always = job.steps.filter((step) => step.if === "always()");
    expect(always).toHaveLength(1);
    expect(always[0].uses).toStartWith("actions/upload-artifact@");
    expect(always[0].with?.path).toBe("coverage-shard/test-progress.log");
    expect(always[0].with?.["if-no-files-found"]).toBe("warn");
    expect(always[0].with?.name).not.toStartWith("lcov-cov-");
  });
});
