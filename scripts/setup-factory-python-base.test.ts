import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { DEFAULT_PYTHON_IMAGE } from "@ezcorp/extension-runner";
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

type Step = { uses?: string; run?: string; env?: Record<string, string> };

/** A coverage step in host-shard mode runs the backend files, so the two suites can land in it. */
const runsHostShard = (step: Step) => step.run?.includes("scripts/test-coverage.sh") === true && step.env?.SHARD_INDEX !== undefined;

async function ciJobs(): Promise<Record<string, { steps?: Step[] }>> {
  return (Bun.YAML.parse(await text(".github/workflows/ci.yml")) as { jobs: Record<string, { steps?: Step[] }> }).jobs;
}

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
    const action = Bun.YAML.parse(source) as { runs: { using: string; steps: Step[] } };
    expect(action.runs.using).toBe("composite");
    expect(action.runs.steps.map((step) => step.uses ?? step.run?.trim())).toEqual(["bun scripts/setup-factory-python-base.ts"]);
    expect(source).not.toMatch(/sha256:[a-f0-9]{64}|python:\d/);
  });

  test("every job that runs host-shard coverage gets the base after podman, before the tests", async () => {
    const jobs = Object.entries(await ciJobs()).filter(([, job]) => (job.steps ?? []).some(runsHostShard));
    expect(jobs.map(([name]) => name)).toContain("cov-shard");
    for (const [name, job] of jobs) {
      const steps = job.steps ?? [];
      const base = steps.findIndex((step) => step.uses === ACTION);
      const podman = steps.findIndex((step) => step.run?.includes("scripts/setup-extension-runner-ci.sh --install") === true);
      const tests = steps.findIndex(runsHostShard);
      expect({ name, base: base >= 0, afterPodman: podman >= 0 && base > podman, beforeTests: base < tests }).toEqual({ name, base: true, afterPodman: true, beforeTests: true });
    }
  });

  test("no workflow step restates a Python image reference", async () => {
    for (const job of Object.values(await ciJobs())) {
      for (const step of job.steps ?? []) expect(step.run ?? "").not.toMatch(/library\/python@|ezcorp-factory-python-data[@:]/);
    }
  });
});
