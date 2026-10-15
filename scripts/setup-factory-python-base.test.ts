import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { DEFAULT_PYTHON_IMAGE } from "@ezcorp/extension-runner";
import { ghExpr, readWorkflows, stepsNeedingAction, type WorkflowStep } from "./lib/ci-registration.ts";
import { type Run, runInherited, setupFactoryPythonBase } from "./setup-factory-python-base";

/**
 * Pins the CI step that puts the Python base image on a hosted runner to the
 * one pin source the suites read.
 *
 * The red this prevents (hosted run 37138524741): the coverage shards ran
 * python-guest and applied-controls with no Python image present, so each
 * failed with "docker.io/library/python@sha256:3121f8b0…: image not known".
 * The step must name exactly the image those suites ask for, so its input is
 * read here from the files themselves and never restated.
 */

const ROOT = resolve(import.meta.dir, "..");
const DIGEST = /^docker\.io\/library\/python@sha256:[a-f0-9]{64}$/;
const ACTION = "./.github/actions/factory-python-base";

async function text(relPath: string): Promise<string> {
  return Bun.file(join(ROOT, relPath)).text();
}

/** A coverage step in host-shard mode runs the backend files, so the two suites can land in it. */
const runsHostShard = (run: string, step: WorkflowStep) => run.includes("scripts/test-coverage.sh") && step.env?.SHARD_INDEX !== undefined;

const workflows = () => readWorkflows(join(ROOT, ".github/workflows"));

function recorder(failAt?: number): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = (command, args) => {
    calls.push([command, ...args]);
    return calls.length === failAt ? 125 : 0;
  };
  return { run, calls };
}

describe("the step's input is the pin source", () => {
  test("the default image is the runner's DEFAULT_PYTHON_IMAGE, an immutable digest", () => {
    const { run, calls } = recorder();
    expect(setupFactoryPythonBase(run, () => {})).toBe(0);
    expect(calls[0]).toEqual(["podman", "pull", DEFAULT_PYTHON_IMAGE]);
    expect(DEFAULT_PYTHON_IMAGE).toMatch(DIGEST);
  });

  test("the data image recipe builds FROM the same base, and pinned.json records that base", async () => {
    const from = (await text("src/factory/reference-data/image/Containerfile")).match(/^FROM (\S+)$/m)?.[1];
    expect(from).toBe(DEFAULT_PYTHON_IMAGE);
    const pinned = JSON.parse(await text("src/factory/reference-data/image/pinned.json")) as { base: string };
    expect(pinned.base).toBe(DEFAULT_PYTHON_IMAGE);
  });
});

describe("setupFactoryPythonBase", () => {
  const image = `docker.io/library/python@sha256:${"a".repeat(64)}`;

  test("pulls the image by digest, then proves that digest resolves", () => {
    const { run, calls } = recorder();
    const lines: string[] = [];
    expect(setupFactoryPythonBase(run, (line) => lines.push(line), image)).toBe(0);
    expect(calls).toEqual([
      ["podman", "pull", image],
      ["podman", "image", "exists", image],
    ]);
    expect(lines).toEqual([`factory python base: pull ${image}`, `factory python base: find ${image}`]);
  });

  test.each([
    [1, "pull"],
    [2, "find"],
  ] as const)("a failure at step %i stops there, returns its exit code, and names the image", (at, what) => {
    const { run, calls } = recorder(at);
    const lines: string[] = [];
    expect(setupFactoryPythonBase(run, (line) => lines.push(line), image)).toBe(125);
    expect(calls).toHaveLength(at);
    expect(lines.at(-1)).toBe(`factory python base: could not ${what} ${image} (exit 125)`);
  });
});

describe("runInherited", () => {
  test("returns the command's exit status, and 1 when the command cannot start", () => {
    expect(runInherited("true", [])).toBe(0);
    expect(runInherited("sh", ["-c", "exit 7"])).toBe(7);
    expect(runInherited("/nonexistent/factory-python-base-probe", [])).toBe(1);
  });
});

describe("the workflow runs the step where the suites run", () => {
  test("the action runs this script and names no image itself", async () => {
    const source = await text(".github/actions/factory-python-base/action.yml");
    const action = Bun.YAML.parse(source) as { runs: { using: string; steps: WorkflowStep[] } };
    expect(action.runs.using).toBe("composite");
    expect(action.runs.steps.map((step) => step.uses ?? step.run?.trim())).toEqual(["bun scripts/setup-factory-python-base.ts"]);
    expect(source).not.toMatch(/sha256:[a-f0-9]{64}|python:\d/);
  });

  test("every host-shard coverage step runs after the base action", () => {
    const steps = stepsNeedingAction(workflows(), ACTION, runsHostShard);
    expect(steps.map((step) => step.where)).toContain(`ci.yml cov-shard (Coverage shard ${ghExpr("matrix.shard")}): Run shard (tests + coverage)`);
    expect(steps.filter((step) => !step.preceded).map((step) => step.where)).toEqual([]);
  });

  test("the base action runs after the podman setup in its job", () => {
    const jobs = workflows().flatMap(({ file, jobs }) => Object.entries(jobs).map(([id, job]) => ({ where: `${file} ${id}`, steps: job.steps ?? [] })));
    const withAction = jobs.filter(({ steps }) => steps.some((step) => step.uses === ACTION));
    expect(withAction.length).toBeGreaterThan(0);
    for (const { where, steps } of withAction) {
      const podman = steps.findIndex((step) => step.run?.includes("scripts/setup-extension-runner-ci.sh --install") === true);
      expect({ where, afterPodman: podman >= 0 && steps.findIndex((step) => step.uses === ACTION) > podman }).toEqual({ where, afterPodman: true });
    }
  });

  test("no workflow step restates a Python image reference", () => {
    for (const { jobs } of workflows()) {
      for (const job of Object.values(jobs)) {
        for (const step of job.steps ?? []) expect(step.run ?? "").not.toMatch(/library\/python@|ezcorp-factory-python-data[@:]/);
      }
    }
  });
});
