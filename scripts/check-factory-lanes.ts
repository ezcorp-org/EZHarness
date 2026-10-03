#!/usr/bin/env bun
/**
 * C11 verification-lane completeness gate.
 *
 * The contract names SEVEN required lanes. A job NAME alone is not a lane: the
 * W00 audit found `Factory runner readiness precheck` guarding labels that no
 * job requested, and five PostgreSQL suites registered in no producer at all.
 * So every lane below declares, and this gate enforces:
 *
 *   job       the workflow key that must exist in a factory workflow file
 *   check     the exact `name:` that branch protection requires
 *   producers COMMAND fragments the job must actually run (not comments)
 *   artifacts `lcov-cov-*` / upload names the lane must publish, when it
 *             produces coverage that the `Per-file coverage gate` merges
 *   requires  job keys this lane must depend on, so a lane that needs a
 *             labelled self-hosted runner can never queue for 24 hours
 *             behind an absent runner instead of failing readiness
 *   tests     test files the lane job runs through `bash scripts/run-factory-lane-tests.sh <job>`
 *   boundTests test files whose precondition only this lane's runner has (a
 *             GPU device node, a locally built image). The lane job runs them,
 *             and the hosted shard selection never does: scripts/lib/test-file-sets.sh
 *             subtracts them through `--bound-tests`. This list is the ONE
 *             manifest both selections read (wave 4h rule (b)).
 *
 * A lane whose producers are missing FAILS. There is deliberately no "declared
 * but not yet implemented" state: an unavailable runtime is a failed readiness,
 * never a skipped success.
 *
 * Pure helpers are exported for unit testing with deliberate violations;
 * main() reads the real workflow files.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./coverage-config.ts";

export interface FactoryLane {
  /** Workflow job key, e.g. `factory-temporal`. */
  readonly job: string;
  /** Exact branch-protection check name from the C11 lane table. */
  readonly check: string;
  /** Workflow file that must contain the job. */
  readonly workflow: string;
  /** Command fragments the job must execute. */
  readonly producers: readonly string[];
  /** Upload/artifact names the lane must publish. */
  readonly artifacts: readonly string[];
  /** Job keys this lane must list in `needs:`. */
  readonly requires: readonly string[];
  /** Runner labels the lane must request, when it needs dedicated hardware. */
  readonly runnerLabels: readonly string[];
  /** Test files the lane job runs that the hosted shards run too (repo-relative). */
  readonly tests: readonly string[];
  /** Test files that only this lane's runner can satisfy: the lane job runs them and no hosted shard does. */
  readonly boundTests: readonly string[];
}

export const CI_WORKFLOW = ".github/workflows/ci.yml";
export const POSTGRES_WORKFLOW = ".github/workflows/db-postgres.yml";

/** The seven exact C11 lanes. Order matches the contract's lane table. */
export const FACTORY_LANES: readonly FactoryLane[] = [
  {
    job: "factory-schema-kernel",
    check: "Factory schema and kernel",
    workflow: CI_WORKFLOW,
    producers: [
      "bun run --cwd packages/@ezcorp/factory-sdk build",
      "bun scripts/check-factory-boundaries.ts",
      "bun scripts/check-schema-generate-drift.ts",
      "bash scripts/test.sh",
    ],
    artifacts: [],
    requires: [],
    runnerLabels: [],
    tests: [],
    boundTests: [],
  },
  {
    job: "factory-runner-contracts",
    check: "Factory runner contracts",
    workflow: CI_WORKFLOW,
    producers: [
      "bun run --cwd packages/@ezcorp/factory-orchestrator build",
      "bash scripts/python-quality.sh all",
      "./src/factory/runner/python-runner.integration.test.ts",
      "./src/factory/runner/native.integration.test.ts",
    ],
    artifacts: ["lcov-cov-factory-python"],
    requires: [],
    runnerLabels: [],
    tests: [],
    boundTests: [],
  },
  {
    job: "factory-temporal",
    check: "Factory Temporal integration",
    workflow: CI_WORKFLOW,
    producers: [
      "bash scripts/factory-orchestrator-coverage.sh",
      "temporal-test-server_1.38.0_linux_amd64",
    ],
    artifacts: ["lcov-cov-factory-orchestrator"],
    requires: [],
    runnerLabels: [],
    tests: [],
    boundTests: [],
  },
  {
    job: "factory-assurance-release",
    check: "Factory assurance and release",
    workflow: POSTGRES_WORKFLOW,
    producers: [
      "./tests/postgres/factory-assurance.test.ts",
      "./tests/postgres/factory-releases.test.ts",
      "./tests/postgres/factory-release-authority.test.ts",
      "./tests/postgres/factory-validator-materials.test.ts",
      "scripts/setup-factory-storage.sh up",
    ],
    artifacts: ["lcov-cov-factory-assurance-release"],
    requires: [],
    runnerLabels: [],
    tests: [],
    boundTests: [],
  },
  {
    job: "factory-isolation",
    check: "Factory isolation",
    workflow: CI_WORKFLOW,
    producers: [
      "bash scripts/setup-extension-runner-ci.sh --install",
      "bash scripts/verify-factory-local-gpu.sh",
    ],
    artifacts: [],
    requires: ["factory-runner-readiness"],
    runnerLabels: ["factory-gpu"],
    tests: [
      "packages/@ezcorp/extension-runner/tests/podman.integration.test.ts",
      "src/factory/runner/supervisor.podman.integration.test.ts",
      "src/factory/runner/validator-guest.podman.integration.test.ts",
      "src/factory/runner/guest-model.podman.integration.test.ts",
    ],
    // Its precondition is the host's AMD device profile (/dev/kfd and two render nodes).
    boundTests: ["packages/@ezcorp/extension-runner/tests/podman-devices.integration.test.ts"],
  },
  {
    job: "factory-product-e2e",
    check: "Factory product and domain E2E",
    workflow: CI_WORKFLOW,
    producers: [
      "bash scripts/collect-browser-route-coverage-lane.sh factory-services",
      "bun scripts/browser-route-coverage-manifest.ts --print",
    ],
    artifacts: ["browser-v8-factory-services"],
    requires: ["factory-runner-readiness", "browser-coverage-build"],
    runnerLabels: ["factory-real"],
    tests: [],
    boundTests: [],
  },
  {
    job: "factory-deployment-operations",
    check: "Factory deployment and operations",
    workflow: CI_WORKFLOW,
    producers: [
      "bun scripts/verify-factory-storage.ts",
      "bash scripts/verify-docker-upgrade.sh",
      "bun scripts/verify-backup-rollback.ts",
      "./tests/postgres/factory-provisioning.test.ts",
    ],
    artifacts: [],
    requires: ["factory-runner-readiness"],
    runnerLabels: ["factory-real"],
    tests: [],
    boundTests: [],
  },
];

/** The one command a lane job runs its manifest tests with. */
export function laneTestCommand(job: string): string {
  return `bash scripts/run-factory-lane-tests.sh ${job}`;
}

/** The lane selection: every test file one lane job runs, in manifest order. */
export function laneTestFiles(job: string, lanes: readonly FactoryLane[] = FACTORY_LANES): string[] {
  const lane = lanes.find((entry) => entry.job === job);
  if (lane === undefined) throw new Error(`no C11 lane '${job}' in the lane manifest`);
  return [...lane.tests, ...lane.boundTests];
}

/** The files the hosted shard selection must never select: every lane's bound tests, sorted. */
export function laneBoundTestFiles(lanes: readonly FactoryLane[] = FACTORY_LANES): string[] {
  return [...new Set(lanes.flatMap((lane) => lane.boundTests))].sort();
}

/**
 * Every way the test part of the manifest can be wrong: a file that does not
 * exist (a rename would silently drop it from its lane AND from the hosted
 * subtraction), a bound file claimed by two lanes, a bound file that a lane
 * also lists as a shared test (it would then be both lane-only and hosted), or
 * a lane that binds tests while running on a hosted runner.
 */
export function laneManifestIssues(
  lanes: readonly FactoryLane[] = FACTORY_LANES,
  exists: (path: string) => boolean = (path) => existsSync(resolve(REPO_ROOT, path)),
): string[] {
  const issues: string[] = [];
  const shared = new Set(lanes.flatMap((lane) => lane.tests));
  const owner = new Map<string, string>();
  for (const lane of lanes) {
    for (const file of [...lane.tests, ...lane.boundTests]) {
      if (!exists(file)) issues.push(`${lane.check}: test file '${file}' does not exist`);
    }
    for (const file of lane.boundTests) {
      const previous = owner.get(file);
      if (previous !== undefined) issues.push(`${lane.check}: bound test '${file}' is already bound to lane '${previous}'`);
      owner.set(file, lane.job);
      if (shared.has(file)) issues.push(`${lane.check}: bound test '${file}' is also listed as a shared lane test`);
    }
    if (lane.boundTests.length > 0 && lane.runnerLabels.length === 0) {
      issues.push(`${lane.check}: job '${lane.job}' binds tests but requests no dedicated runner label, so a hosted runner would run them`);
    }
  }
  return issues;
}

/**
 * Extract one job's YAML block: from `  <job>:` at two-space indent up to the
 * next line at that same indent. Comments are stripped so a lane can never be
 * satisfied by a command that only appears inside a `#` explanation.
 */
export function workflowJobBlock(workflow: string, job: string): string | undefined {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${job}:`);
  if (start < 0) return undefined;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^ {2}\S/.test(line)) break;
    body.push(line.replace(/(^|\s)#.*$/, "$1"));
  }
  return body.join("\n");
}

/** `needs: [a, b]` or `needs: a` for one job block. */
export function jobNeeds(block: string): string[] {
  const inline = block.match(/^\s*needs:\s*\[([^\]]*)\]/m);
  if (inline) return inline[1]!.split(",").map((entry) => entry.trim()).filter(Boolean);
  const single = block.match(/^\s*needs:\s*([A-Za-z0-9_-]+)\s*$/m);
  return single ? [single[1]!] : [];
}

/** Runner labels requested by `runs-on:`, inline-array or block-sequence form. */
export function jobRunnerLabels(block: string): string[] {
  const inline = block.match(/^\s*runs-on:\s*\[([^\]]*)\]/m);
  if (inline) return inline[1]!.split(",").map((entry) => entry.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const scalar = block.match(/^\s*runs-on:\s*([A-Za-z0-9_.-]+)\s*$/m);
  if (scalar) return [scalar[1]!];
  const sequence = block.match(/^\s*runs-on:\s*\n((?:\s*-\s*.+\n?)+)/m);
  if (!sequence) return [];
  return [...sequence[1]!.matchAll(/-\s*(.+)/g)].map((match) => match[1]!.trim().replace(/^["']|["']$/g, ""));
}

/**
 * Every way a declared lane can be incomplete, as reviewable messages. Reading
 * workflow text is deliberate: the gate must judge what the job RUNS, not what
 * a maintainer wrote in a comment or a job name.
 */
export function factoryLaneIssues(
  workflows: Readonly<Record<string, string>>,
  lanes: readonly FactoryLane[] = FACTORY_LANES,
): string[] {
  const issues: string[] = [];
  for (const lane of lanes) {
    const workflow = workflows[lane.workflow];
    if (workflow === undefined) {
      issues.push(`${lane.check}: workflow ${lane.workflow} was not supplied`);
      continue;
    }
    const block = workflowJobBlock(workflow, lane.job);
    if (block === undefined) {
      issues.push(`${lane.check}: no job '${lane.job}' in ${lane.workflow}`);
      continue;
    }
    if (!block.includes(`name: ${lane.check}`)) {
      issues.push(`${lane.check}: job '${lane.job}' does not declare the exact required-check name`);
    }
    const producers = lane.tests.length + lane.boundTests.length > 0 ? [...lane.producers, laneTestCommand(lane.job)] : lane.producers;
    for (const producer of producers) {
      if (!block.includes(producer)) issues.push(`${lane.check}: job '${lane.job}' never runs producer '${producer}'`);
    }
    for (const artifact of lane.artifacts) {
      if (!block.includes(`name: ${artifact}`)) issues.push(`${lane.check}: job '${lane.job}' publishes no artifact '${artifact}'`);
    }
    if (lane.artifacts.length > 0 && !block.includes("if-no-files-found: error")) {
      issues.push(`${lane.check}: job '${lane.job}' uploads coverage without 'if-no-files-found: error', so an empty producer would pass`);
    }
    const needs = jobNeeds(block);
    for (const required of lane.requires) {
      if (!needs.includes(required)) issues.push(`${lane.check}: job '${lane.job}' must declare needs: ${required}`);
    }
    const labels = jobRunnerLabels(block);
    for (const label of lane.runnerLabels) {
      if (!labels.includes(label)) issues.push(`${lane.check}: job '${lane.job}' must request runner label '${label}'`);
    }
    if (lane.runnerLabels.length > 0 && !labels.includes("self-hosted")) {
      issues.push(`${lane.check}: job '${lane.job}' requests dedicated labels without 'self-hosted'`);
    }
    if (block.includes("continue-on-error: true")) {
      issues.push(`${lane.check}: job '${lane.job}' sets continue-on-error, so its failure would not block the candidate`);
    }
  }
  return issues;
}

/**
 * The labels guarded by the readiness precheck must be requested by at least
 * one real job. W00 discrepancy 17: the precheck guarded `factory-real` and
 * `factory-gpu` while `grep -rn` over the workflows found no consumer.
 */
export function unconsumedRunnerLabels(
  workflows: Readonly<Record<string, string>>,
  lanes: readonly FactoryLane[] = FACTORY_LANES,
  guarded: readonly string[] = ["factory-real", "factory-gpu"],
): string[] {
  const requested = new Set(lanes.flatMap((lane) => {
    const block = workflowJobBlock(workflows[lane.workflow] ?? "", lane.job);
    return block ? jobRunnerLabels(block) : [];
  }));
  return guarded
    .filter((label) => !requested.has(label))
    .map((label) => `runner label '${label}' is guarded by the readiness precheck but no C11 lane job requests it`);
}

export async function readFactoryWorkflows(): Promise<Record<string, string>> {
  const paths = [...new Set(FACTORY_LANES.map((lane) => lane.workflow))];
  const entries = await Promise.all(paths.map(async (path) => [path, await Bun.file(resolve(REPO_ROOT, path)).text()] as const));
  return Object.fromEntries(entries);
}

export async function runFactoryLaneCheck(options: {
  read?: () => Promise<Record<string, string>>;
  log?: Pick<Console, "log" | "error">;
  exists?: (path: string) => boolean;
} = {}): Promise<number> {
  const log = options.log ?? console;
  const workflows = await (options.read ?? readFactoryWorkflows)();
  const issues = [...factoryLaneIssues(workflows), ...unconsumedRunnerLabels(workflows), ...laneManifestIssues(FACTORY_LANES, options.exists)];
  if (issues.length > 0) {
    log.error(`C11 lane inventory FAILED (${issues.length} issue(s)):`);
    for (const issue of issues) log.error(`  ${issue}`);
    return 1;
  }
  log.log(`C11 lane inventory passed: ${FACTORY_LANES.length} lanes with declared producers, artifacts, and runner labels.`);
  return 0;
}

const USAGE = "usage: bun scripts/check-factory-lanes.ts [--lane-tests <job> | --bound-tests]";

/**
 * The command line. No argument runs the lane gate. `--lane-tests <job>` prints
 * the lane selection and `--bound-tests` the hosted subtraction, one
 * repo-relative path per line, so the bash runners read this manifest rather
 * than a copy of it.
 */
export async function factoryLaneMain(
  argv: readonly string[],
  options: Parameters<typeof runFactoryLaneCheck>[0] = {},
): Promise<number> {
  const log = options.log ?? console;
  if (argv.length === 0) return runFactoryLaneCheck(options);
  if (argv[0] === "--bound-tests" && argv.length === 1) {
    log.log(laneBoundTestFiles().join("\n"));
    return 0;
  }
  if (argv[0] === "--lane-tests" && argv.length === 2) {
    const files = FACTORY_LANES.some((lane) => lane.job === argv[1]) ? laneTestFiles(argv[1]!) : [];
    if (files.length === 0) {
      log.error(`lane '${argv[1]}' names no test file in the lane manifest`);
      return 2;
    }
    log.log(files.join("\n"));
    return 0;
  }
  log.error(USAGE);
  return 2;
}

export const FACTORY_LANE_MAIN_RESULT = import.meta.main ? await factoryLaneMain(process.argv.slice(2)) : undefined;
if (FACTORY_LANE_MAIN_RESULT !== undefined) process.exitCode = FACTORY_LANE_MAIN_RESULT;
