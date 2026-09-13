import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  CI_WORKFLOW,
  FACTORY_LANES,
  POSTGRES_WORKFLOW,
  factoryLaneIssues,
  jobNeeds,
  jobRunnerLabels,
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
