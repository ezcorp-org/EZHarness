import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Workflow, type WorkflowStep, missingProducers, missingThresholds, readWorkflows, runsBackendSuites, stepsNeedingAction, stepsNeedingPreparation, workflowCommands } from "./ci-registration.ts";

describe("workflowCommands", () => {
  test("removes whole-line and trailing comments", () => {
    expect(workflowCommands("# bun test ./a.test.ts\n- run: bun test ./b.test.ts # and ./c.test.ts")).toBe(
      "\n- run: bun test ./b.test.ts",
    );
  });

  test("keeps a hash that belongs to a quoted value", () => {
    expect(workflowCommands('- run: echo "sha256:#abc"')).toBe('- run: echo "sha256:#abc"');
  });

  test("keeps a hash with no preceding whitespace, which cannot open a YAML comment", () => {
    expect(workflowCommands("- run: curl https://host/x#fragment")).toBe("- run: curl https://host/x#fragment");
  });
});

describe("missingProducers", () => {
  test("reports nothing when every producer is actually run", () => {
    expect(missingProducers("- run: bun test ./a.test.ts", [["a suite", "./a.test.ts"]])).toEqual([]);
  });

  test("reports a producer that only appears in a comment", () => {
    expect(missingProducers("# ./a.test.ts runs elsewhere", [["a suite", "./a.test.ts"]])).toEqual(["a suite"]);
  });

  test("reports every missing producer, not just the first", () => {
    expect(missingProducers("- run: true", [["one", "./a.test.ts"], ["two", "./b.test.ts"]])).toEqual(["one", "two"]);
  });
});

describe("missingThresholds", () => {
  test("accepts an exact 100 floor", () => {
    expect(missingThresholds('{"src/x.ts": 100}', ["src/x.ts"])).toEqual([]);
  });

  test("rejects a lowered floor and a missing key", () => {
    expect(missingThresholds('{"src/x.ts": 99}', ["src/x.ts"])).toEqual(["src/x.ts threshold"]);
    expect(missingThresholds("{}", ["src/y.ts"])).toEqual(["src/y.ts threshold"]);
  });
});

describe("readWorkflows", () => {
  test("reads every .yml and .yaml file in name order, with its text and jobs, and ignores other files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-registration-"));
    try {
      writeFileSync(join(dir, "b.yml"), "jobs:\n  one:\n    steps:\n      - run: echo b\n");
      writeFileSync(join(dir, "a.yaml"), "on: push\n");
      writeFileSync(join(dir, "notes.md"), "jobs: {}\n");
      const read = readWorkflows(dir);
      expect(read.map(({ file }) => file)).toEqual(["a.yaml", "b.yml"]);
      // A workflow without jobs reads as none rather than failing the caller.
      expect(read[0]!.jobs).toEqual({});
      expect(read[1]!.jobs).toEqual({ one: { steps: [{ run: "echo b" }] } });
      expect(read[1]!.text).toContain("echo b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runsBackendSuites", () => {
  test("selects the two pool scripts and their package.json aliases", () => {
    for (const run of ["bash scripts/test.sh", "bash scripts/test-coverage.sh", "bun run test", "bun run test:coverage", "set -e\nbun run test\necho done"]) {
      expect(runsBackendSuites(run)).toBe(true);
    }
  });

  test("leaves other test scripts and single files alone", () => {
    for (const run of ["bun run test:sdk", "bun run test:file x", "bun test ./a.test.ts", "bash scripts/test-web.sh", "bun run typecheck"]) {
      expect(runsBackendSuites(run)).toBe(false);
    }
  });
});

describe("stepsNeedingAction", () => {
  const ACTION = "./.github/actions/tool";
  const needs = (run: string) => run.includes("needs-tool");
  const workflows: Workflow[] = [{
    file: "ci.yml",
    text: "",
    jobs: {
      ready: { name: "Ready", steps: [{ uses: ACTION }, { name: "Use it", run: "needs-tool --go" }] },
      late: { steps: [{ run: "needs-tool first\nsecond line" }, { uses: ACTION }] },
      other: { steps: [{ uses: "actions/checkout@x" }, { run: "echo plain" }] },
      empty: {},
    },
  }];

  test("reports each needing step with whether the action ran before it in the same job", () => {
    expect(stepsNeedingAction(workflows, ACTION, needs)).toEqual([
      { where: "ci.yml ready (Ready): Use it", preceded: true },
      { where: "ci.yml late (late): needs-tool first", preceded: false },
    ]);
  });

  test("an action in one job does not prepare a step in another job", () => {
    const split: Workflow[] = [{ file: "w.yml", text: "", jobs: { a: { steps: [{ uses: ACTION }] }, b: { steps: [{ run: "needs-tool" }] } } }];
    expect(stepsNeedingAction(split, ACTION, needs)).toEqual([{ where: "w.yml b (b): needs-tool", preceded: false }]);
  });

  test("the selection also sees the step, so it can tell two steps with the same command apart by their env", () => {
    const sharded: Workflow[] = [{
      file: "w.yml",
      text: "",
      jobs: { shard: { steps: [{ uses: ACTION }, { name: "Shard", run: "needs-tool", env: { SHARD_INDEX: "0" } }] }, legs: { steps: [{ name: "Legs", run: "needs-tool", env: { LEGS_ONLY: "1" } }] } },
    }];
    expect(stepsNeedingAction(sharded, ACTION, (run, step) => needs(run) && step.env?.SHARD_INDEX !== undefined)).toEqual([{ where: "w.yml shard (shard): Shard", preceded: true }]);
  });
});

describe("stepsNeedingPreparation", () => {
  // W4H-12: a preparation can be a run step (scripts/setup-extension-runner-ci.sh), not only a shared action.
  const prepares = (step: WorkflowStep) => step.run?.includes("setup-tool") === true;
  const needs = (run: string) => run.includes("needs-tool");

  test("a run step prepares the steps after it in its job, and not the steps before it", () => {
    const workflows: Workflow[] = [{
      file: "w.yml",
      text: "",
      jobs: {
        ready: { steps: [{ run: "bash setup-tool --install" }, { name: "After", run: "needs-tool" }] },
        late: { steps: [{ name: "Before", run: "needs-tool" }, { run: "bash setup-tool --install" }] },
      },
    }];
    expect(stepsNeedingPreparation(workflows, prepares, needs)).toEqual([
      { where: "w.yml ready (ready): After", preceded: true },
      { where: "w.yml late (late): Before", preceded: false },
    ]);
  });

  test("a step that both prepares and needs counts as prepared, as an action step does", () => {
    const workflows: Workflow[] = [{ file: "w.yml", text: "", jobs: { one: { steps: [{ name: "Both", run: "setup-tool && needs-tool" }] } } }];
    expect(stepsNeedingPreparation(workflows, prepares, needs)).toEqual([{ where: "w.yml one (one): Both", preceded: true }]);
  });
});
