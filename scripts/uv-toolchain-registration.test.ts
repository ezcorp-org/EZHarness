/**
 * Every CI job that can reach the uv-dependent suites installs the pinned uv from ONE action and ONE pin (W4H-2).
 *
 * src/factory/runner/uv-command.ts fails closed when no uv resolves (W4G-5), and the hosted coverage shards had none:
 * uv-command.test.ts and python-runner.integration.test.ts failed there with "UvUnavailableError: no 'uv' available",
 * while the three jobs that used .github/actions/setup-python-toolchain passed. This test holds three things: the
 * action takes its version only from .uv-version (no input can override it), no CI, script or container file holds a
 * second copy of the version or installs uv another way, and every job that runs those suites uses the action first.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { readWorkflows, runsBackendSuites, stepsNeedingAction, type WorkflowStep } from "./lib/ci-registration.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ACTION = "./.github/actions/setup-python-toolchain";
const ACTION_FILE = join(REPO_ROOT, ".github/actions/setup-python-toolchain/action.yml");
const PIN_FILE = ".uv-version";
const PIN = readFileSync(join(REPO_ROOT, PIN_FILE), "utf8").trim();

/** The test files that spawn the resolved uv: every suite that imports the resolver. */
function uvSuites(): string[] {
  const suites: string[] = [];
  for (const pattern of ["src/**/*.test.ts", "scripts/**/*.test.ts", "tests/**/*.test.ts"]) {
    for (const file of new Glob(pattern).scanSync({ cwd: REPO_ROOT })) {
      if (!file.includes("node_modules/") && /from "[./]*(?:[\w/.-]*\/)?uv-command(?:\.ts)?"/.test(readFileSync(join(REPO_ROOT, file), "utf8"))) suites.push(file);
    }
  }
  return suites.sort();
}

/** A step that needs uv: the backend pools, the Python lanes (typecheck runs mypy through them), or a uv suite by name. */
function needsUv(suites: readonly string[]) {
  return (run: string) => runsBackendSuites(run)
    || /\bscripts\/(?:typecheck|python-quality)\.sh\b|\bbun run typecheck(?=\s|$)/m.test(run)
    || suites.some((suite) => run.includes(suite));
}

/** CI, script and container files: the places a second uv pin or a second uv install could hide. */
function toolchainFiles(): string[] {
  const files = new Set<string>();
  for (const pattern of [".github/**/*", "scripts/**/*", "deploy/**/*", "src/**/Containerfile*", "Dockerfile*", "*compose*.y*ml", "package.json"]) {
    for (const file of new Glob(pattern).scanSync({ cwd: REPO_ROOT, dot: true })) {
      if (!file.includes("node_modules/") && !file.startsWith(".git/") && !file.endsWith(".test.ts")) files.add(file);
    }
  }
  return [...files].sort();
}

describe("the pinned uv for the hosted test jobs (W4H-2)", () => {
  test("the action installs exactly the release named in .uv-version, checksum-verified, and takes no input", () => {
    expect(PIN).toMatch(/^\d+\.\d+\.\d+$/);
    const action = Bun.YAML.parse(readFileSync(ACTION_FILE, "utf8")) as { inputs?: unknown; runs: { using: string; steps: WorkflowStep[] } };
    expect(action.runs.using).toBe("composite");
    // No input: no caller can pass a version that differs from the pin.
    expect(action.inputs).toBeUndefined();
    const install = action.runs.steps[0]!;
    expect(install.shell).toBe("bash");
    expect(install.run).toContain(`version="$(tr -d '[:space:]' < ${PIN_FILE})"`);
    expect(install.run).toContain('base="https://github.com/astral-sh/uv/releases/download/$version"');
    expect(install.run).toContain('sha256sum --check "$archive.sha256"');
    expect(install.run).toContain('echo "/tmp/uv-pinned" >> "$GITHUB_PATH"');
    // A machine path or a Nix fallback would defeat the point of pinning from the repository.
    expect(install.run).not.toContain("/tmp/factory-tools");
    expect(install.run).not.toContain("nix");
    // The download cache is keyed on the pin, so a pin change never reuses another version's cache.
    const cache = action.runs.steps.find((step) => step.uses?.startsWith("actions/cache@")) as { with?: { key?: string } } | undefined;
    expect(cache?.with?.key).toContain(`hashFiles('${PIN_FILE}'`);
  });

  test("no CI, script or container file holds a second uv version or installs uv another way", () => {
    const files = toolchainFiles();
    // The workflows, the action and the scripts are all in the scan; an empty scan would prove nothing.
    expect(files).toContain(".github/actions/setup-python-toolchain/action.yml");
    expect(files).toContain(".github/workflows/ci.yml");
    expect(files).toContain("scripts/python-quality.sh");
    const offenders = files.filter((file) => {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      return text.includes(PIN) || /uses:\s*["']?astral-sh\/setup-uv|pip3? install[^\n]*\buv\b|astral\.sh\/uv\/[\d.]+\/install/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  test("every job that runs the uv-dependent suites uses the action before that step", () => {
    const suites = uvSuites();
    expect(suites).toEqual(["src/factory/runner/python-runner.integration.test.ts", "src/factory/runner/uv-command.test.ts"]);
    const steps = stepsNeedingAction(readWorkflows(join(REPO_ROOT, ".github/workflows")), ACTION, needsUv(suites));
    // The backend pools (six jobs, two steps in the release job), the runner conformance lane, typecheck and lint.
    expect(steps.length).toBeGreaterThanOrEqual(11);
    expect(steps.filter((step) => !step.preceded).map((step) => step.where)).toEqual([]);
  });

  test("the step selection names the Python lanes and the uv suites, and leaves other steps alone", () => {
    const needs = needsUv(["src/factory/runner/uv-command.test.ts"]);
    expect(needs("bash scripts/python-quality.sh lint")).toBe(true);
    expect(needs("bun run typecheck")).toBe(true);
    expect(needs("bun test ./src/factory/runner/uv-command.test.ts")).toBe(true);
    expect(needs("bash scripts/test.sh")).toBe(true);
    expect(needs("bun run typecheck:web")).toBe(false);
    expect(needs("bun test ./src/factory/runner/native.integration.test.ts")).toBe(false);
  });
});
