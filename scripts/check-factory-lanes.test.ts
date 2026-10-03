import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CI_WORKFLOW,
  FACTORY_LANES,
  type FactoryLane,
  POSTGRES_WORKFLOW,
  factoryLaneIssues,
  factoryLaneMain,
  jobNeeds,
  jobRunnerLabels,
  laneBoundTestFiles,
  laneManifestIssues,
  laneRequiredImages,
  laneTestCommand,
  laneTestFiles,
  readFactoryWorkflows,
  runFactoryLaneCheck,
  unconsumedRunnerLabels,
  workflowJobBlock,
} from "./check-factory-lanes.ts";

const C11_LANE_CHECKS = [
  "Factory schema and kernel",
  "Factory runner contracts",
  "Factory Temporal integration",
  "Factory assurance and release",
  "Factory isolation",
  "Factory product and domain E2E",
  "Factory deployment and operations",
] as const;

async function realWorkflows(): Promise<Record<string, string>> {
  const [ci, postgres] = await Promise.all([readFile(CI_WORKFLOW, "utf8"), readFile(POSTGRES_WORKFLOW, "utf8")]);
  return { [CI_WORKFLOW]: ci, [POSTGRES_WORKFLOW]: postgres };
}

describe("C11 lane inventory", () => {
  test("declares exactly the seven contract lanes, once each", () => {
    expect(FACTORY_LANES.map((lane) => lane.check)).toEqual([...C11_LANE_CHECKS]);
    expect(new Set(FACTORY_LANES.map((lane) => lane.job)).size).toBe(FACTORY_LANES.length);
  });

  test("every declared lane names at least one executable producer", () => {
    for (const lane of FACTORY_LANES) {
      expect(lane.producers.length, `${lane.check} has no producer`).toBeGreaterThan(0);
    }
  });

  test("the real workflows satisfy every lane", async () => {
    expect(factoryLaneIssues(await realWorkflows())).toEqual([]);
  });

  test("both guarded runner labels have a consuming lane job", async () => {
    expect(unconsumedRunnerLabels(await realWorkflows())).toEqual([]);
  });
});

describe("C11 lane inventory rejects deliberate violations", () => {
  test("a removed job is not excused by its check name appearing elsewhere", async () => {
    const workflows = await realWorkflows();
    const broken = { ...workflows, [CI_WORKFLOW]: workflows[CI_WORKFLOW]!.replace("  factory-temporal:\n", "  factory-temporal-renamed:\n") };
    expect(factoryLaneIssues(broken)).toContain("Factory Temporal integration: no job 'factory-temporal' in .github/workflows/ci.yml");
  });

  test("a job name alone is insufficient when its producer is gone", async () => {
    const workflows = await realWorkflows();
    const broken = {
      ...workflows,
      [CI_WORKFLOW]: workflows[CI_WORKFLOW]!.replace("bash scripts/factory-orchestrator-coverage.sh", "echo skipped"),
    };
    expect(factoryLaneIssues(broken)).toContain(
      "Factory Temporal integration: job 'factory-temporal' never runs producer 'bash scripts/factory-orchestrator-coverage.sh'",
    );
  });

  test("a producer that appears only in a comment does not satisfy a lane", () => {
    const workflow = [
      "jobs:",
      "  factory-temporal:",
      "    name: Factory Temporal integration",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      # bash scripts/factory-orchestrator-coverage.sh runs elsewhere",
      "      - run: echo nothing",
    ].join("\n");
    const lane = FACTORY_LANES.find((entry) => entry.job === "factory-temporal")!;
    expect(factoryLaneIssues({ [CI_WORKFLOW]: workflow }, [lane])).toContain(
      "Factory Temporal integration: job 'factory-temporal' never runs producer 'bash scripts/factory-orchestrator-coverage.sh'",
    );
  });

  test("a dropped coverage artifact fails even when the producer still runs", async () => {
    const workflows = await realWorkflows();
    const broken = { ...workflows, [CI_WORKFLOW]: workflows[CI_WORKFLOW]!.replace("name: lcov-cov-factory-orchestrator", "name: lcov-scratch") };
    expect(factoryLaneIssues(broken)).toContain("Factory Temporal integration: job 'factory-temporal' publishes no artifact 'lcov-cov-factory-orchestrator'");
  });

  test("an artifact upload that tolerates an empty producer fails", () => {
    const workflow = [
      "jobs:",
      "  factory-temporal:",
      "    name: Factory Temporal integration",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: bash scripts/factory-orchestrator-coverage.sh",
      "      - run: echo temporal-test-server_1.38.0_linux_amd64",
      "      - uses: actions/upload-artifact@v7",
      "        with:",
      "          name: lcov-cov-factory-orchestrator",
      "          if-no-files-found: warn",
    ].join("\n");
    const lane = FACTORY_LANES.find((entry) => entry.job === "factory-temporal")!;
    expect(factoryLaneIssues({ [CI_WORKFLOW]: workflow }, [lane])).toContain(
      "Factory Temporal integration: job 'factory-temporal' uploads coverage without 'if-no-files-found: error', so an empty producer would pass",
    );
  });

  test("a labelled lane that drops its readiness dependency fails, because it would queue instead of failing", async () => {
    const workflows = await realWorkflows();
    expect(jobNeeds(workflowJobBlock(workflows[CI_WORKFLOW]!, "factory-isolation")!)).toContain("factory-runner-readiness");
    const fault = "    runs-on: [self-hosted, factory-gpu]\n    needs: [factory-runner-readiness]\n";
    expect(workflows[CI_WORKFLOW], "the deliberate fault matched nothing").toContain(fault);
    const broken = { ...workflows, [CI_WORKFLOW]: workflows[CI_WORKFLOW]!.replace(fault, "    runs-on: [self-hosted, factory-gpu]\n") };
    expect(factoryLaneIssues(broken)).toContain("Factory isolation: job 'factory-isolation' must declare needs: factory-runner-readiness");
  });

  test("a lane that stops requesting its runner label leaves the precheck guarding nothing", async () => {
    const workflows = await realWorkflows();
    expect(jobRunnerLabels(workflowJobBlock(workflows[CI_WORKFLOW]!, "factory-isolation")!)).toContain("factory-gpu");
    const fault = "    runs-on: [self-hosted, factory-gpu]";
    expect(workflows[CI_WORKFLOW], "the deliberate fault matched nothing").toContain(fault);
    const broken = { ...workflows, [CI_WORKFLOW]: workflows[CI_WORKFLOW]!.replace(fault, "    runs-on: ubuntu-latest") };
    expect(factoryLaneIssues(broken)).toContain("Factory isolation: job 'factory-isolation' must request runner label 'factory-gpu'");
    expect(unconsumedRunnerLabels(broken)).toContain(
      "runner label 'factory-gpu' is guarded by the readiness precheck but no C11 lane job requests it",
    );
  });

  test("a job that exists under the wrong check name cannot satisfy branch protection", () => {
    const workflow = [
      "jobs:",
      "  factory-temporal:",
      "    name: Temporal stuff",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: bash scripts/factory-orchestrator-coverage.sh",
      "      - run: echo temporal-test-server_1.38.0_linux_amd64",
      "      - uses: actions/upload-artifact@v7",
      "        with:",
      "          name: lcov-cov-factory-orchestrator",
      "          if-no-files-found: error",
    ].join("\n");
    const lane = FACTORY_LANES.find((entry) => entry.job === "factory-temporal")!;
    expect(factoryLaneIssues({ [CI_WORKFLOW]: workflow }, [lane])).toEqual([
      "Factory Temporal integration: job 'factory-temporal' does not declare the exact required-check name",
    ]);
  });

  test("continue-on-error disarms a lane and is rejected", () => {
    const workflow = [
      "jobs:",
      "  factory-temporal:",
      "    name: Factory Temporal integration",
      "    runs-on: ubuntu-latest",
      "    continue-on-error: true",
      "    steps:",
      "      - run: bash scripts/factory-orchestrator-coverage.sh",
      "      - run: echo temporal-test-server_1.38.0_linux_amd64",
      "      - uses: actions/upload-artifact@v7",
      "        with:",
      "          name: lcov-cov-factory-orchestrator",
      "          if-no-files-found: error",
    ].join("\n");
    const lane = FACTORY_LANES.find((entry) => entry.job === "factory-temporal")!;
    expect(factoryLaneIssues({ [CI_WORKFLOW]: workflow }, [lane])).toContain(
      "Factory Temporal integration: job 'factory-temporal' sets continue-on-error, so its failure would not block the candidate",
    );
  });

  test("a workflow file that was never supplied fails closed rather than passing vacuously", () => {
    const lane = FACTORY_LANES.find((entry) => entry.job === "factory-assurance-release")!;
    expect(factoryLaneIssues({}, [lane])).toEqual([
      "Factory assurance and release: workflow .github/workflows/db-postgres.yml was not supplied",
    ]);
  });
});

describe("C11 lane inventory YAML readers", () => {
  test("reads inline, scalar, and block-sequence runner declarations", () => {
    expect(jobRunnerLabels("    runs-on: ubuntu-latest")).toEqual(["ubuntu-latest"]);
    expect(jobRunnerLabels('    runs-on: [self-hosted, "factory-real"]')).toEqual(["self-hosted", "factory-real"]);
    expect(jobRunnerLabels("    runs-on:\n      - self-hosted\n      - factory-gpu\n")).toEqual(["self-hosted", "factory-gpu"]);
    expect(jobRunnerLabels("    steps:")).toEqual([]);
  });

  test("reads inline-array, scalar, and absent needs declarations", () => {
    expect(jobNeeds("    needs: [a, b]")).toEqual(["a", "b"]);
    expect(jobNeeds("    needs: solo")).toEqual(["solo"]);
    expect(jobNeeds("    steps:")).toEqual([]);
  });

  test("a job block stops at the next job and never absorbs its neighbour", () => {
    const workflow = "jobs:\n  first:\n    name: One\n    steps: []\n  second:\n    name: Two\n";
    expect(workflowJobBlock(workflow, "first")).toContain("name: One");
    expect(workflowJobBlock(workflow, "first")).not.toContain("name: Two");
    expect(workflowJobBlock(workflow, "absent")).toBeUndefined();
  });
});

describe("C11 lane inventory CLI seam", () => {
  test("reports success from the real workflow files", async () => {
    const output: string[] = [];
    const log = { log: (value: unknown) => output.push(String(value)), error: (value: unknown) => output.push(String(value)) };
    expect(await runFactoryLaneCheck({ log })).toBe(0);
    expect(output).toEqual(["C11 lane inventory passed: 7 lanes with declared producers, artifacts, and runner labels."]);
  });

  test("returns failure and prints every issue", async () => {
    const output: string[] = [];
    const log = { log: (value: unknown) => output.push(String(value)), error: (value: unknown) => output.push(String(value)) };
    expect(await runFactoryLaneCheck({ read: async () => ({}), log })).toBe(1);
    expect(output[0]).toMatch(/^C11 lane inventory FAILED \(\d+ issue\(s\)\):$/);
    expect(output.some((line) => line.includes("Factory schema and kernel"))).toBe(true);
  });

  test("the default reader loads both real factory workflow files", async () => {
    const workflows = await readFactoryWorkflows();
    expect(Object.keys(workflows).sort()).toEqual([CI_WORKFLOW, POSTGRES_WORKFLOW].sort());
    expect(workflows[CI_WORKFLOW]).toContain("name: ci");
    expect(workflows[POSTGRES_WORKFLOW]).toContain("name: db-postgres");
  });
});

const USAGE = "usage: bun scripts/check-factory-lanes.ts [--lane-tests <job> | --lane-images <job> | --bound-tests]";
const DEVICE_TEST = "packages/@ezcorp/extension-runner/tests/podman-devices.integration.test.ts";
const JOURNEY_TEST = "src/factory/reference-data/journey.integration.test.ts";
const DATA_IMAGE_PIN = "src/factory/reference-data/image/pinned.json";
const SHARED_GPU_TESTS = [
  "packages/@ezcorp/extension-runner/tests/podman.integration.test.ts",
  "src/factory/runner/supervisor.podman.integration.test.ts",
  "src/factory/runner/validator-guest.podman.integration.test.ts",
  "src/factory/runner/guest-model.podman.integration.test.ts",
];

function capture() {
  const output: string[] = [];
  const errors: string[] = [];
  return { output, errors, log: { log: (value: unknown) => output.push(String(value)), error: (value: unknown) => errors.push(String(value)) } };
}

function lane(overrides: Partial<FactoryLane>): FactoryLane {
  return { job: "lane-x", check: "Lane X", workflow: CI_WORKFLOW, producers: ["echo x"], artifacts: [], requires: [], runnerLabels: ["factory-gpu"], tests: [], boundTests: [], boundImagePins: [], ...overrides };
}

/** One bash run of the hosted selection library, exactly as the CI runners source it. */
function hostedSet(script: string): { exitCode: number; files: string[]; stderr: string } {
  const result = Bun.spawnSync(["bash", "-c", `source scripts/lib/test-file-sets.sh; ${script}`], { cwd: import.meta.dir + "/.." });
  return { exitCode: result.exitCode, files: result.stdout.toString().split("\n").filter(Boolean), stderr: result.stderr.toString() };
}

describe("lane manifest: one list names the lane-bound tests", () => {
  test("the device test is bound to the factory-gpu lane and the data journey to a factory-real lane", () => {
    expect(laneBoundTestFiles()).toEqual([DEVICE_TEST, JOURNEY_TEST]);
    const owner = (file: string) => FACTORY_LANES.find((entry) => entry.boundTests.includes(file))!;
    expect(owner(DEVICE_TEST).job).toBe("factory-isolation");
    expect(owner(DEVICE_TEST).runnerLabels).toEqual(["factory-gpu"]);
    expect(owner(JOURNEY_TEST).job).toBe("factory-deployment-operations");
    expect(owner(JOURNEY_TEST).runnerLabels).toEqual(["factory-real"]);
  });

  test("the journey's lane requires the data image exactly as its one pin file names it", async () => {
    const pinned = (await Bun.file(DATA_IMAGE_PIN).json()) as { image: string };
    expect(laneRequiredImages("factory-deployment-operations")).toEqual([pinned.image]);
    expect(pinned.image).toMatch(/^localhost\/ezcorp-factory-python-data@sha256:[0-9a-f]{64}$/);
    expect(laneRequiredImages("factory-isolation")).toEqual([]);
    expect(() => laneRequiredImages("no-such-lane")).toThrow("no C11 lane 'no-such-lane' in the lane manifest");
  });

  test("a pin that names no image by digest is rejected by name", () => {
    const lanes = [lane({ boundImagePins: ["pin.json"] })];
    for (const text of ['{"image":"localhost/data:latest"}', "{}", '{"image":7}']) {
      expect(() => laneRequiredImages("lane-x", lanes, () => text)).toThrow("image pin 'pin.json' names no image by digest");
    }
    expect(laneRequiredImages("lane-x", lanes, () => `{"image":"r/i@sha256:${"a".repeat(64)}"}`)).toEqual([`r/i@sha256:${"a".repeat(64)}`]);
  });

  test("a missing image pin file is named", () => {
    expect(laneManifestIssues([lane({ boundImagePins: ["pin.json"] })], (path) => path !== "pin.json")).toEqual([
      "Lane X: image pin 'pin.json' does not exist",
    ]);
  });

  test("the real manifest names only files that exist, each bound once, none also shared", () => {
    expect(laneManifestIssues()).toEqual([]);
  });

  test("a renamed or deleted test file is named, for a shared and for a bound entry", () => {
    const lanes = [lane({ tests: ["a.test.ts"], boundTests: ["b.test.ts"] })];
    expect(laneManifestIssues(lanes, (path) => path === "a.test.ts")).toEqual(["Lane X: test file 'b.test.ts' does not exist"]);
    expect(laneManifestIssues(lanes, (path) => path === "b.test.ts")).toEqual(["Lane X: test file 'a.test.ts' does not exist"]);
  });

  test("a file bound to two lanes, or bound and shared at once, is rejected", () => {
    const lanes = [lane({ boundTests: ["b.test.ts"] }), lane({ job: "lane-y", check: "Lane Y", tests: ["b.test.ts"], boundTests: ["b.test.ts"] })];
    expect(laneManifestIssues(lanes, () => true)).toEqual([
      "Lane X: bound test 'b.test.ts' is also listed as a shared lane test",
      "Lane Y: bound test 'b.test.ts' is already bound to lane 'lane-x'",
      "Lane Y: bound test 'b.test.ts' is also listed as a shared lane test",
    ]);
  });

  test("a lane on a hosted runner cannot own a bound test", () => {
    expect(laneManifestIssues([lane({ runnerLabels: [], boundTests: ["b.test.ts"] })], () => true)).toEqual([
      "Lane X: job 'lane-x' binds tests but requests no dedicated runner label, so a hosted runner would run them",
    ]);
  });

  test("the lane gate fails on a manifest issue in the real workflow tree", async () => {
    const { errors, log } = capture();
    expect(await runFactoryLaneCheck({ log, exists: (path) => path !== DEVICE_TEST })).toBe(1);
    expect(errors).toEqual(["C11 lane inventory FAILED (1 issue(s)):", `  Factory isolation: test file '${DEVICE_TEST}' does not exist`]);
  });
});

describe("lane selection: the lane job runs the manifest", () => {
  test("the factory-gpu lane runs its shared container observations and then the device test", () => {
    expect(laneTestFiles("factory-isolation")).toEqual([...SHARED_GPU_TESTS, DEVICE_TEST]);
    expect(laneTestFiles("factory-deployment-operations")).toEqual([JOURNEY_TEST]);
    expect(laneTestFiles("factory-temporal")).toEqual([]);
    expect(() => laneTestFiles("no-such-lane")).toThrow("no C11 lane 'no-such-lane' in the lane manifest");
  });

  test("both lane jobs run the manifest through the one runner command", async () => {
    const workflows = await realWorkflows();
    for (const job of ["factory-isolation", "factory-deployment-operations"]) {
      expect(workflowJobBlock(workflows[CI_WORKFLOW]!, job)).toContain(`run: ${laneTestCommand(job)}\n`);
    }
    expect(laneTestCommand("factory-isolation")).toBe("bash scripts/run-factory-lane-tests.sh factory-isolation");
  });

  test("a lane job that runs its tests by hand, not from the manifest, fails the gate", async () => {
    const workflows = await realWorkflows();
    const broken = { ...workflows, [CI_WORKFLOW]: workflows[CI_WORKFLOW]!.replace(laneTestCommand("factory-isolation"), `bun test ./${SHARED_GPU_TESTS[0]}`) };
    expect(factoryLaneIssues(broken)).toEqual([
      "Factory isolation: job 'factory-isolation' never runs producer 'bash scripts/run-factory-lane-tests.sh factory-isolation'",
    ]);
  });

  test("the command line prints the lane selection and the hosted subtraction", async () => {
    const lanes = capture();
    expect(await factoryLaneMain(["--lane-tests", "factory-isolation"], { log: lanes.log })).toBe(0);
    expect(lanes.output).toEqual([[...SHARED_GPU_TESTS, DEVICE_TEST].join("\n")]);
    const bound = capture();
    expect(await factoryLaneMain(["--bound-tests"], { log: bound.log })).toBe(0);
    expect(bound.output).toEqual([`${DEVICE_TEST}\n${JOURNEY_TEST}`]);
    const images = capture();
    expect(await factoryLaneMain(["--lane-images", "factory-deployment-operations"], { log: images.log })).toBe(0);
    expect(images.output).toEqual(laneRequiredImages("factory-deployment-operations"));
    const none = capture();
    expect(await factoryLaneMain(["--lane-images", "factory-isolation"], { log: none.log })).toBe(0);
    expect(none.output).toEqual([]);
  });

  test("the command line fails closed on an unknown lane, an empty lane and a malformed call", async () => {
    for (const [argv, message] of [
      [["--lane-tests", "no-such-lane"], "lane 'no-such-lane' names no test file in the lane manifest"],
      [["--lane-tests", "factory-temporal"], "lane 'factory-temporal' names no test file in the lane manifest"],
      [["--lane-images", "no-such-lane"], "no C11 lane 'no-such-lane' in the lane manifest"],
      [["--lane-tests"], USAGE],
      [["--bound-tests", "extra"], USAGE],
      [["--other"], USAGE],
    ] as const) {
      const { output, errors, log } = capture();
      expect(await factoryLaneMain(argv, { log })).toBe(2);
      expect(errors).toEqual([message]);
      expect(output).toEqual([]);
    }
  });

  test("with no argument the command line runs the lane gate", async () => {
    const { errors, log } = capture();
    expect(await factoryLaneMain([], { read: async () => ({}), log })).toBe(1);
    expect(errors[0]).toMatch(/^C11 lane inventory FAILED/);
  });

  test("the lane runner fails by name before any test when its runner lacks a pinned image", () => {
    const fake = mkdtempSync(join(tmpdir(), "w4h4-podman-"));
    try {
      writeFileSync(join(fake, "podman"), '#!/usr/bin/env bash\necho "$@" >> "$(dirname "$0")/calls"\nexit 1\n', { mode: 0o755 });
      const result = Bun.spawnSync(["bash", "scripts/run-factory-lane-tests.sh", "factory-deployment-operations"], {
        cwd: import.meta.dir + "/..",
        env: { ...process.env, PATH: `${fake}:${process.env.PATH}` },
      });
      const image = laneRequiredImages("factory-deployment-operations")[0]!;
      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain(`Precondition failed: lane factory-deployment-operations needs the pinned image ${image} on this runner, and it is absent.`);
      expect(result.stdout.toString()).not.toContain("test file(s)");
      expect(readFileSync(join(fake, "calls"), "utf8")).toBe(`image exists ${image}\n`);
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  test("the lane runner refuses an unknown lane before it starts any test", () => {
    const result = Bun.spawnSync(["bash", "scripts/run-factory-lane-tests.sh", "no-such-lane"], { cwd: import.meta.dir + "/.." });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("lane 'no-such-lane' names no test file in the lane manifest");
    expect(result.stdout.toString()).not.toContain("test file(s)");
  });
});

describe("hosted selection: no shard selects a lane-bound test", () => {
  test("the bash library reads the same manifest", () => {
    const bound = hostedSet("lane_bound_test_files");
    expect(bound.exitCode).toBe(0);
    expect(bound.files).toEqual(laneBoundTestFiles());
  });

  test("P, C and the residual set hold no bound test, and keep the shared lane tests", () => {
    for (const set of ["passfail_files", "coverage_host_files", "residual_passfail_files"]) {
      const { exitCode, files } = hostedSet(set);
      expect(exitCode).toBe(0);
      expect(files.length, `${set} is empty`).toBeGreaterThan(10);
      for (const file of laneBoundTestFiles()) expect(files, `${set} selects ${file}`).not.toContain(file);
    }
    const coverage = hostedSet("coverage_host_files").files;
    for (const file of SHARED_GPU_TESTS) expect(coverage).toContain(file);
  });

  test("the twelve hosted coverage shards together select every C file and no bound test", () => {
    const shards = hostedSet('for i in $(seq 0 11); do coverage_host_files | shard_slice "$i" 12; done');
    expect(shards.exitCode).toBe(0);
    expect(shards.files.length).toBe(new Set(shards.files).size);
    expect([...shards.files].sort()).toEqual([...hostedSet("coverage_host_files").files].sort());
    for (const file of laneBoundTestFiles()) expect(shards.files).not.toContain(file);
  });

  test("an unreadable manifest fails the hosted sets by name instead of keeping a bound test", () => {
    for (const set of ["lane_bound_test_files", "passfail_files", "coverage_host_files"]) {
      const result = hostedSet(`bun() { return 3; }; ${set}`);
      expect(result.exitCode, set).toBe(1);
      expect(result.files, set).toEqual([]);
      expect(result.stderr).toContain("lane_bound_test_files: the lane manifest (scripts/check-factory-lanes.ts --bound-tests) gave no list");
    }
  });
});
