/**
 * Every CI job that runs the backend suites has ripgrep on PATH, from ONE definition (W4H-33).
 *
 * src/runtime/tools/grep.ts prefers ripgrep and falls back to GNU grep. Its ripgrep cases in
 * src/__tests__/runtime-tools-grep.test.ts were gated on `rg` being on PATH, and no workflow installed it, so on the
 * hosted runners they never ran. The install now lives in one composite action (the runner image's own Ubuntu
 * archive, like every other apt tool the jobs use), and the cases require ripgrep instead of skipping without it.
 * This test holds both halves: every step that runs the backend suites follows the action in its job, and no
 * workflow repeats the install itself.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readWorkflows, runsBackendSuites, stepsNeedingAction, type WorkflowStep } from "./lib/ci-registration.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ACTION = "./.github/actions/ripgrep";
const INSTALL = "sudo apt-get install -y --no-install-recommends ripgrep";
const workflows = () => readWorkflows(join(REPO_ROOT, ".github/workflows"));

describe("ripgrep for the backend suites (W4H-33)", () => {
  test("the shared action installs ripgrep and proves it is on PATH", () => {
    const parsed = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/actions/ripgrep/action.yml"), "utf8")) as { inputs?: unknown; runs: { using: string; steps: WorkflowStep[] } };
    expect(parsed.runs.using).toBe("composite");
    expect(parsed.inputs).toBeUndefined();
    // A composite action's run step needs its shell named; actionlint does not check a local action's steps.
    expect(parsed.runs.steps.map((step) => step.shell)).toEqual(["bash"]);
    const run = parsed.runs.steps[0]!.run!;
    expect(run).toContain("sudo apt-get update");
    expect(run).toContain(INSTALL);
    expect(run).toContain("rg --version");
  });

  test("every job that runs the backend suites uses the action before that step", () => {
    const steps = stepsNeedingAction(workflows(), ACTION, runsBackendSuites);
    // The coverage shards, the coverage legs and the residual set exist; an empty match would prove nothing.
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps.filter((step) => !step.preceded).map((step) => step.where)).toEqual([]);
  });

  test("no workflow repeats the install command instead of using the action", () => {
    expect(workflows().filter(({ text }) => text.includes(INSTALL)).map(({ file }) => file)).toEqual([]);
  });
});
