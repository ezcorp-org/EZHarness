import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { DEFAULT_PYTHON_IMAGE } from "@ezcorp/extension-runner";
import { factoryPythonImages, runInherited, setupFactoryPythonImages, type Run } from "./setup-factory-python-images";

/**
 * Pins the CI step that puts the Python images on a hosted runner to the one
 * pin source the suites read.
 *
 * The red this prevents (hosted run 37138524741): the coverage shards ran
 * python-guest, applied-controls and the reference-data journey with no
 * Python image present, so each failed with "image not known". The step
 * must name exactly the images those suites ask for, so its inputs are read
 * here from the files themselves and never restated.
 */

const ROOT = resolve(import.meta.dir, "..");
const DIGEST = /^docker\.io\/library\/python@sha256:[a-f0-9]{64}$/;
const ACTION = "./.github/actions/factory-python-images";

async function text(relPath: string): Promise<string> {
  return Bun.file(join(ROOT, relPath)).text();
}

async function pinnedJson(): Promise<{ image: string; base: string }> {
  return JSON.parse(await text("src/factory/reference-data/image/pinned.json")) as { image: string; base: string };
}

type Step = { uses?: string; run?: string; name?: string; env?: Record<string, string> };

/** A coverage step in host-shard mode runs the backend files, so the three suites can land in it. */
const runsHostShard = (step: Step) => step.run?.includes("scripts/test-coverage.sh") === true && step.env?.SHARD_INDEX !== undefined;

async function ciJobs(): Promise<Record<string, { steps?: Step[] }>> {
  return (Bun.YAML.parse(await text(".github/workflows/ci.yml")) as { jobs: Record<string, { steps?: Step[] }> }).jobs;
}

function recorder(fail?: { at: number; status: number }): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = (command, args) => {
    calls.push([command, ...args]);
    return fail !== undefined && calls.length === fail.at ? fail.status : 0;
  };
  return { run, calls };
}

describe("the step's inputs are the pin source", () => {
  test("the base is the runner's DEFAULT_PYTHON_IMAGE and the data image is pinned.json's", async () => {
    const images = await factoryPythonImages();
    expect(images.base).toBe(DEFAULT_PYTHON_IMAGE);
    expect(images.base).toMatch(DIGEST);
    expect(images.data).toBe((await pinnedJson()).image);
    expect(images.data).toMatch(/^localhost\/ezcorp-factory-python-data@sha256:[a-f0-9]{64}$/);
  });

  test("the data recipe builds FROM the same base, and pinned.json records that base", async () => {
    const from = (await text("src/factory/reference-data/image/Containerfile")).match(/^FROM (\S+)$/m)?.[1];
    expect(from).toBe(DEFAULT_PYTHON_IMAGE);
    expect((await pinnedJson()).base).toBe(DEFAULT_PYTHON_IMAGE);
  });
});

describe("setupFactoryPythonImages", () => {
  const images = async () => ({ base: "docker.io/library/python@sha256:" + "a".repeat(64), data: "localhost/ezcorp-factory-python-data@sha256:" + "b".repeat(64) });

  test("pulls the base by digest, builds the data image from the recipe, and proves both resolve", async () => {
    const { run, calls } = recorder();
    const lines: string[] = [];
    expect(await setupFactoryPythonImages("/repo", run, line => lines.push(line), images)).toBe(0);
    const { base, data } = await images();
    expect(calls).toEqual([
      ["podman", "pull", base],
      ["podman", "image", "exists", base],
      ["bash", "/repo/scripts/build-factory-data-image.sh"],
      ["podman", "image", "exists", data],
    ]);
    expect(lines).toHaveLength(4);
  });

  test("with no arguments past the root it uses the committed pins", async () => {
    const { run, calls } = recorder();
    expect(await setupFactoryPythonImages(ROOT, run, () => {})).toBe(0);
    expect(calls[0]).toEqual(["podman", "pull", DEFAULT_PYTHON_IMAGE]);
    expect(calls[3]).toEqual(["podman", "image", "exists", (await pinnedJson()).image]);
  });

  test.each([
    [1, "could not pull docker.io/library/python@sha256:"],
    [2, "could not find docker.io/library/python@sha256:"],
    [3, "could not build localhost/ezcorp-factory-python-data@sha256:"],
    [4, "could not find localhost/ezcorp-factory-python-data@sha256:"],
  ] as const)("a failure at step %i stops there, returns its exit code, and names the image", async (at, message) => {
    const { run, calls } = recorder({ at, status: 125 });
    const lines: string[] = [];
    expect(await setupFactoryPythonImages("/repo", run, line => lines.push(line), images)).toBe(125);
    expect(calls).toHaveLength(at);
    expect(lines.at(-1)).toContain(message);
    expect(lines.at(-1)).toContain("(exit 125)");
  });

  test("a stale pin is refused before any command runs", async () => {
    const { run, calls } = recorder();
    const stale = () => Promise.reject(new Error("The reference data image lock names tag 0"));
    await expect(setupFactoryPythonImages("/repo", run, () => {}, stale)).rejects.toThrow("names tag 0");
    expect(calls).toEqual([]);
  });
});

describe("runInherited", () => {
  test("returns the command's exit status, and 1 when the command cannot start", () => {
    expect(runInherited("true", [])).toBe(0);
    expect(runInherited("sh", ["-c", "exit 7"])).toBe(7);
    expect(runInherited("/nonexistent/factory-python-images-probe", [])).toBe(1);
  });
});

describe("the workflow runs the step where the suites run", () => {
  test("the action installs the pinned uv, runs this script, and names no image itself", async () => {
    const action = Bun.YAML.parse(await text(".github/actions/factory-python-images/action.yml")) as { runs: { using: string; steps: Step[] } };
    expect(action.runs.using).toBe("composite");
    expect(action.runs.steps.map(step => step.uses ?? step.run?.trim())).toEqual(["./.github/actions/setup-python-toolchain", "bun scripts/setup-factory-python-images.ts"]);
    expect(await text(".github/actions/factory-python-images/action.yml")).not.toMatch(/sha256:[a-f0-9]{64}|python:\d|ezcorp-factory-python-data:/);
  });

  test("every job that runs host-shard coverage gets the images after podman, before the tests", async () => {
    const jobs = Object.entries(await ciJobs()).filter(([, job]) => (job.steps ?? []).some(runsHostShard));
    expect(jobs.map(([name]) => name)).toContain("cov-shard");
    for (const [name, job] of jobs) {
      const steps = job.steps ?? [];
      const at = (match: (step: Step) => boolean) => steps.findIndex(match);
      const images = at(step => step.uses === ACTION);
      const podman = at(step => step.run?.includes("scripts/setup-extension-runner-ci.sh --install") === true);
      const tests = at(runsHostShard);
      expect({ name, images: images >= 0, afterPodman: images > podman && podman >= 0, beforeTests: images < tests }).toEqual({ name, images: true, afterPodman: true, beforeTests: true });
    }
  });

  test("no workflow step restates a Python image reference", async () => {
    for (const job of Object.values(await ciJobs())) {
      for (const step of job.steps ?? []) expect(step.run ?? "").not.toMatch(/library\/python@|ezcorp-factory-python-data[@:]/);
    }
  });
});
