import { describe, expect, test } from "bun:test";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { PYTHON_COVERAGE_PRODUCER, SOURCE_GLOBS, canonicalCoverageProducer, isSourceFile } from "./coverage-config.ts";
import { missingProducers, missingThresholds } from "./lib/ci-registration.ts";

/**
 * Python has exactly one instrumenter and no Bun substitute, so its producer
 * must be registered in every consumer or its source silently leaves the gates.
 * Before this, `.python-version` had no consumer at all and no Python line in
 * the repository was linted, typed, tested, or measured.
 */
const PROJECT = "src/factory/runner/python";
const LANE_JOB_PRODUCER = "bash scripts/python-quality.sh all";

describe("Python quality lane registration", () => {
  test("the locked project carries its pin, its lock, and at least one discoverable test", async () => {
    expect((await readFile(".python-version", "utf8")).trim()).toBe("3.13.12");
    expect(await Bun.file(`${PROJECT}/uv.lock`).exists()).toBe(true);
    expect(await Bun.file(`${PROJECT}/pyproject.toml`).exists()).toBe(true);
    const tests = [...new Glob("test_*.py").scanSync({ cwd: `${PROJECT}/tests` })];
    expect(tests.length, "an empty Python suite must fail the lane, not pass it").toBeGreaterThan(0);
  });

  test("pyproject selects strict ruff rules and the relative-path coverage producer", async () => {
    const pyproject = await readFile(`${PROJECT}/pyproject.toml`, "utf8");
    expect(pyproject).toContain("[tool.mypy]\nstrict = true");
    expect(pyproject).toContain("[tool.ruff.lint]");
    for (const rule of ["F", "B", "ANN", "RUF"]) expect(pyproject).toContain(`"${rule}"`);
    // relative_files is what makes the emitted LCOV carry repository-relative
    // SF: paths, so no path-rewriting step stands between the producer and the
    // merge. Losing it would make every Python record unmatchable.
    expect(pyproject).toContain("relative_files = true");
    expect(pyproject).toContain("branch = true");
  });

  test("the lane script and the coverage configuration agree on one producer tag", async () => {
    const script = await readFile("scripts/python-quality.sh", "utf8");
    expect(script).toContain(`PRODUCER_TAG="${PYTHON_COVERAGE_PRODUCER}"`);
    expect(canonicalCoverageProducer(`${PROJECT}/c02_runner.py`)).toBe(PYTHON_COVERAGE_PRODUCER);
    // A Bun leg must never be accepted as an equivalent for Python source.
    expect(canonicalCoverageProducer(`${PROJECT}/anything-else.py`)).toBe(PYTHON_COVERAGE_PRODUCER);
  });

  test("Python source is gated, and Python test files are not treated as source", () => {
    expect(SOURCE_GLOBS).toContain(`${PROJECT}/**/*.py`);
    expect(isSourceFile(`${PROJECT}/c02_runner.py`)).toBe(true);
    expect(isSourceFile(`${PROJECT}/tests/test_c02_runner.py`)).toBe(false);
    expect(isSourceFile(`${PROJECT}/tests/__init__.py`)).toBe(false);
    // Scoped to the locked project on purpose: the two Python files outside it
    // belong to no lock and have no runnable producer, so pulling them in would
    // create a gate nothing can satisfy.
    expect(isSourceFile("packages/@ezcorp/extension-runner/src/peer-gateway.py")).toBe(false);
    expect(isSourceFile("scripts/fixtures/factory-local-gpu.py")).toBe(false);
  });

  test("the runner source is floored at 100 with a wildcard and a per-file key", async () => {
    const thresholds = await readFile("scripts/coverage-thresholds.json", "utf8");
    expect(missingThresholds(thresholds, [`${PROJECT}/c02_runner.py`])).toEqual([]);
    expect(thresholds).toContain(`"${PROJECT}/**": 100`);
    // A catch-all key would let a new Python file count as gated without its
    // own floor, which is exactly what the new-file gate rejects.
    const keys = Object.keys(JSON.parse(thresholds) as Record<string, number>);
    expect(keys).not.toContain("src/**/*.py");
  });

  test("every consumer runs the lane: CI job, typecheck wrapper, lint job, and the local coverage pipeline", async () => {
    const [ci, typecheck, coverage] = await Promise.all([
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile("scripts/typecheck.sh", "utf8"),
      readFile("scripts/test-coverage.sh", "utf8"),
    ]);
    expect(missingProducers(ci, [
      ["runner-contracts lane", LANE_JOB_PRODUCER],
      ["lint lane ruff leg", "bash scripts/python-quality.sh lint"],
      ["python toolchain action", "uses: ./.github/actions/setup-python-toolchain"],
      ["python LCOV artifact", "name: lcov-cov-factory-python"],
      ["missing-report failure", "if-no-files-found: error"],
    ])).toEqual([]);
    expect(typecheck).toContain('bash "$ROOT/scripts/python-quality.sh" typecheck');
    // Registered in full local mode only: CI publishes the same producer from
    // the one job that installs the pinned uv.
    expect(coverage).toContain("register_leg python cov_python");
    expect(coverage).toContain('bash "$SCRIPT_DIR/python-quality.sh" all');
    expect(coverage).toContain('PYTHON_LEG_EXIT=$(cat "$legs/python.code" 2>/dev/null || echo 1)');
  });

  test("a dropped consumer is reported rather than passing quietly", async () => {
    const ci = await readFile(".github/workflows/ci.yml", "utf8");
    expect(missingProducers(ci.replace(LANE_JOB_PRODUCER, "echo skipped"), [["runner-contracts lane", LANE_JOB_PRODUCER]]))
      .toEqual(["runner-contracts lane"]);
    expect(missingProducers(ci.replace("name: lcov-cov-factory-python", "name: lcov-scratch"), [["python LCOV artifact", "name: lcov-cov-factory-python"]]))
      .toEqual(["python LCOV artifact"]);
    const thresholds = await readFile("scripts/coverage-thresholds.json", "utf8");
    expect(missingThresholds(thresholds.replace(`"${PROJECT}/c02_runner.py": 100`, `"${PROJECT}/c02_runner.py": 99`), [`${PROJECT}/c02_runner.py`]))
      .toEqual([`${PROJECT}/c02_runner.py threshold`]);
  });

  // W4G-2: `uv run --frozen --project <p>` takes the interpreter request from <p>'s own .python-version and ignores
  // the repository root's, so without a project pin `requires-python = "==3.13.*"` let uv pick the NEWEST 3.13 it
  // could find or download (3.13.13 on the hosted runner) while .python-version said 3.13.12. Each project's pin is a
  // link to the root file: one source of truth, read by uv's own project pin.
  const lockedProjects = async (): Promise<string[]> => {
    const script = await readFile("scripts/python-quality.sh", "utf8");
    const block = /^PROJECTS=\(\n([\s\S]*?)\n\)$/m.exec(script)?.[1] ?? "";
    return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  };

  test("every locked project reads the repository pin through its own .python-version, a link to the root file", async () => {
    const projects = await lockedProjects();
    expect(projects).toEqual(["src/factory/runner/python", "src/factory/reference-image/python"]);
    const root = realpathSync(".python-version");
    for (const project of projects) {
      const pin = `${project}/.python-version`;
      expect(lstatSync(pin).isSymbolicLink(), `${pin} must be a link to the root pin, not a copy`).toBe(true);
      expect(readlinkSync(pin).startsWith("/"), `${pin} must be a relative link`).toBe(false);
      expect(realpathSync(pin), `${pin} must resolve to the root .python-version`).toBe(root);
    }
  });

  test("the lane refuses, by name and before any interpreter runs, a project that does not read the repository pin", async () => {
    const projects = await lockedProjects();
    const run = (setup: (tree: string, project: string) => void) => {
      const tree = mkdtempSync(join(tmpdir(), "python-pin-"));
      try {
        mkdirSync(join(tree, "scripts"));
        copyFileSync("scripts/python-quality.sh", join(tree, "scripts/python-quality.sh"));
        writeFileSync(join(tree, ".python-version"), "3.13.12\n");
        for (const project of projects) {
          mkdirSync(join(tree, project, "tests"), { recursive: true });
          for (const file of ["pyproject.toml", "uv.lock"]) writeFileSync(join(tree, project, file), "");
          setup(tree, project);
        }
        // PATH holds only the tools the script uses before its uv lookup, with no uv and no Nix: a tree that passes
        // the pin check stops at the uv readiness check instead.
        const bin = join(tree, ".bin");
        mkdirSync(bin);
        for (const tool of ["tr", "readlink", "dirname"]) symlinkSync(Bun.which(tool)!, join(bin, tool));
        const result = Bun.spawnSync([Bun.which("bash")!, "scripts/python-quality.sh", "lint"], { cwd: tree, env: { PATH: bin }, stdout: "pipe", stderr: "pipe" });
        return { exitCode: result.exitCode, stderr: result.stderr.toString() };
      } finally { rmSync(tree, { recursive: true, force: true }); }
    };
    const missing = run(() => {});
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("python quality: src/factory/runner/python/.python-version must be a link to the repository pin");
    const copied = run((tree, project) => writeFileSync(join(tree, project, ".python-version"), "3.13.12\n"));
    expect(copied.exitCode).toBe(1);
    expect(copied.stderr).toContain("must be a link to the repository pin");
    const linked = run((tree, project) => symlinkSync("../".repeat(project.split("/").length) + ".python-version", join(tree, project, ".python-version")));
    expect(linked.stderr).not.toContain("must be a link to the repository pin");
    expect(linked.stderr).toContain("no 'uv' available");
  });
});
