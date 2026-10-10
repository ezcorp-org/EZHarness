/**
 * Every CI job that can reach gate-integrity installs its locked parser from ONE definition (W4G-6).
 *
 * scripts/gate-integrity.ts fails closed when the TypeScript AST parser in .github/gate-integrity-deps is missing,
 * and scripts/gate-integrity-rule11.test.ts spawns that gate, so a job that runs the backend suites without the
 * parser fails it ("TypeScript AST parser is unavailable"): the hosted coverage shards did exactly that, while the
 * Gate integrity job, which installed the parser in a step of its own, passed. The install now lives in one
 * composite action, and this test holds both halves: every job that runs the backend suites or the gate uses that
 * action before the step that needs it, and no workflow repeats the install command itself.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readWorkflows, runsBackendSuites, stepsNeedingAction, type WorkflowStep } from "./lib/ci-registration.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ACTION = "./.github/actions/gate-integrity-deps";
const INSTALL = "bun install --cwd .github/gate-integrity-deps --frozen-lockfile --ignore-scripts";
/** The steps that reach gate-integrity: the backend suite runners (rule 11 spawns the gate) and the gate itself. */
const needsParser = (run: string) => runsBackendSuites(run) || /\bscripts\/gate-integrity\.ts\b/.test(run);
const workflows = () => readWorkflows(join(REPO_ROOT, ".github/workflows"));

describe("the gate-integrity parser install (W4G-6)", () => {
  test("the shared action holds the one install command", () => {
    const action = readFileSync(join(REPO_ROOT, ".github/actions/gate-integrity-deps/action.yml"), "utf8");
    const parsed = Bun.YAML.parse(action) as { runs: { using: string; steps: WorkflowStep[] } };
    expect(parsed.runs.using).toBe("composite");
    // A composite action's run step needs its shell named; actionlint does not check a local action's steps.
    expect(parsed.runs.steps.map((step) => ({ run: step.run, shell: step.shell }))).toEqual([{ run: INSTALL, shell: "bash" }]);
  });

  test("every job that runs the backend suites or the gate uses the action before that step", () => {
    const steps = stepsNeedingAction(workflows(), ACTION, needsParser);
    // The Gate integrity job and the backend suite jobs exist; an empty match would prove nothing.
    expect(steps.length).toBeGreaterThanOrEqual(6);
    expect(steps.filter((step) => !step.preceded).map((step) => step.where)).toEqual([]);
  });

  test("no workflow repeats the install command instead of using the action", () => {
    expect(workflows().filter(({ text }) => text.includes(INSTALL)).map(({ file }) => file)).toEqual([]);
  });
});
