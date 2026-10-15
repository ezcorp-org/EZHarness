/**
 * scripts/combined-runner-legs.json and its drift guard.
 *
 * The local combined runner and the wave4f driver read the manifest for the
 * legs their own lists lack; ci.yml stays the authority for CI. This file
 * proves three things:
 *   1. every manifest producer is the command of a real ci.yml job;
 *   2. every manifest suite exists, is also loaded by a CI coverage set, and
 *      imports each gated source its `measures` field names;
 *   3. every local-only producer is still run by no workflow (the CI gap it
 *      records stays true) and runs the tests it names;
 *   4. every test file that imports a gated source (a coverage-thresholds.json
 *      key or the new-file gate's source set) is loaded by a CI leg, a manifest
 *      suite or a local-only producer. A new orphan fails here BY FILE NAME.
 */
import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../../scripts/coverage-config.ts";
import { workflowCommands } from "../../scripts/lib/ci-registration.ts";
import {
  CI_TEST_SET_FUNCTIONS,
  explicitlyRunTests,
  gatedSourcePredicate,
  importedRepoFiles,
  readRunnerLegs,
  TEST_TREES,
  unloadedGatedTests,
  vitestTestIncludes,
} from "../../scripts/lib/combined-runner-legs.ts";

const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");
const readOrNull = (path: string) => {
  try {
    return read(path);
  } catch {
    return null;
  }
};

function setMembers(functions: readonly string[]): Set<string> {
  const proc = Bun.spawnSync(["bash", "-c", `source scripts/lib/test-file-sets.sh; ${functions.join("; ")}`], { cwd: REPO_ROOT });
  if (proc.exitCode !== 0) throw new Error(`test-file-sets.sh failed: ${proc.stderr.toString()}`);
  return new Set(proc.stdout.toString().split("\n").filter(Boolean).map((line) => line.replace(/^\.\//, "")));
}

function scan(pattern: string, cwd = REPO_ROOT): string[] {
  return [...new Glob(pattern).scanSync({ cwd, dot: true })].filter((file) => !file.includes("node_modules/"));
}

describe("combined-runner-legs helpers", () => {
  test("resolves relative and $lib imports and mocks to repo files, ignoring packages", () => {
    const root = mkdtempSync(join(tmpdir(), "runner-legs-"));
    try {
      mkdirSync(join(root, "src/a/__tests__"), { recursive: true });
      mkdirSync(join(root, "web/src/lib/server"), { recursive: true });
      writeFileSync(join(root, "src/a/mod.ts"), "export const x = 1;\n");
      writeFileSync(join(root, "src/a/index.ts"), "export {};\n");
      writeFileSync(join(root, "web/src/lib/server/mock.ts"), "export {};\n");
      writeFileSync(join(root, "src/a/mocked.ts"), "export {};\n");
      // Built at run time: mock-cleanup-coverage.test.ts reads source text, and this is a fixture, not a mock.
      const mockCall = ["mock", "module"].join(".");
      const text = [
        'import { x } from "../mod";',
        `${mockCall}("../mocked.ts", () => ({}));`,
        'const lazy = await import("..");',
        'import { y } from "$lib/server/mock";',
        'import { z } from "bun:test";',
        'import { w } from "../missing";',
      ].join("\n");
      expect(importedRepoFiles("src/a/__tests__/t.test.ts", text, root)).toEqual([
        "src/a/index.ts",
        "src/a/mocked.ts",
        "src/a/mod.ts",
        "web/src/lib/server/mock.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads the test include list of a Vitest config, without commented entries or coverage includes", () => {
    const config = `export default {
      test: {
        include: [
          "src/**/*.unit.test.ts",
          // "src/commented.test.ts",
          "src/__tests__/relative-time.test.ts",
        ],
        coverage: { include: ["src/lib/**"] },
      },
    };`;
    expect(vitestTestIncludes(config)).toEqual(["src/**/*.unit.test.ts", "src/__tests__/relative-time.test.ts"]);
  });

  test("counts a test a workflow or its script runs, and not one only a comment names", () => {
    const workflow = [
      "run: bun test ./tests/postgres/one.test.ts",
      "# run: bun test ./tests/postgres/commented.test.ts",
      "run: bash scripts/leg.sh",
    ].join("\n");
    const scripts: Record<string, string> = { "scripts/leg.sh": "bun test --coverage ./tests/postgres/two.test.ts\n" };
    expect([...explicitlyRunTests([workflow], (path) => scripts[path] ?? null)].sort()).toEqual([
      "tests/postgres/one.test.ts",
      "tests/postgres/two.test.ts",
    ]);
  });

  test("names an unloaded test that imports a gated source, and only that one", () => {
    const imports: Record<string, string[]> = {
      "src/loaded.test.ts": ["src/gated.ts"],
      "src/orphan.test.ts": ["src/gated.ts"],
      "src/fixture-only.test.ts": ["src/__fixtures__/data.json"],
    };
    const orphans = unloadedGatedTests(
      Object.keys(imports),
      new Set(["src/loaded.test.ts"]),
      (file) => imports[file] ?? [],
      (file) => file === "src/gated.ts",
    );
    expect(orphans).toEqual(["src/orphan.test.ts"]);
  });
});

describe("scripts/combined-runner-legs.json", () => {
  const legs = readRunnerLegs();
  const thresholdKeys = Object.keys(JSON.parse(read("scripts/coverage-thresholds.json")) as Record<string, number>);
  const gated = gatedSourcePredicate(thresholdKeys);

  test("every producer is the command of the named CI job", () => {
    expect(legs.producers.length).toBeGreaterThan(0);
    for (const producer of legs.producers) {
      const workflow = read(producer.workflow);
      const job = new RegExp(`\\n  ${producer.ciJob}:\\n([\\s\\S]*?)(?=\\n  [\\w-]+:\\n|$)`).exec(workflow)?.[1];
      expect(job, `${producer.id}: no job ${producer.ciJob} in ${producer.workflow}`).toBeDefined();
      const script = /\bscripts\/[\w./-]+\.sh\b/.exec(producer.command)?.[0];
      expect(script, `${producer.id}: command runs no script`).toBeDefined();
      expect(job!).toContain(`run: bash ${script}`);
      for (const [, name] of producer.command.matchAll(/\b([A-Z][A-Z0-9_]*)=/g)) {
        expect(job!, `${producer.id}: ${name} is not set by ${producer.ciJob}`).toContain(`${name}:`);
      }
      expect(producer.comment.trim()).not.toBe("");
    }
  });

  test("every local-only producer is a script no workflow runs, and names the tests it runs", () => {
    const workflows = scan(".github/workflows/*.yml").map(read);
    const ciRun = explicitlyRunTests(workflows, readOrNull);
    for (const producer of legs.localOnlyProducers) {
      const script = /\bscripts\/[\w./-]+\.sh\b/.exec(producer.command)?.[0];
      expect(script, `${producer.id}: command runs no script`).toBeDefined();
      const body = read(script!);
      expect(workflows.some((workflow) => workflowCommands(workflow).includes(script!)), `${producer.id}: a workflow runs ${script}; move it to producers`).toBe(false);
      expect(producer.runs.length).toBeGreaterThan(0);
      for (const file of producer.runs) {
        expect(explicitlyRunTests([body], () => null).has(file), `${producer.id}: ${script} does not run ${file}`).toBe(true);
        expect(ciRun.has(file), `${file}: CI runs it; drop it from ${producer.id}.runs`).toBe(false);
      }
      expect(producer.comment).toStartWith("CI GAP:");
      for (const field of [producer.owner, producer.reason, producer.decision]) expect(field.trim()).not.toBe("");
    }
  });

  test("every suite exists, is loaded by a CI coverage set, and imports each gated source it names", () => {
    const coverageSets = setMembers([
      "coverage_host_files",
      "web_utility_coverage_files",
      "suggest_leg_files",
      "sdk_leg_files",
      "harness_client_leg_files",
      "aikit_leg_files",
      "factory_orchestrator_test_files",
      "security_test_files",
    ]);
    expect(legs.suites.length).toBeGreaterThan(0);
    for (const suite of legs.suites) {
      expect(suite.cwd).toBe(suite.file.startsWith("web/") ? "web" : ".");
      expect(coverageSets.has(suite.file), `${suite.file}: in no CI coverage set`).toBe(true);
      const imports = importedRepoFiles(suite.file, read(suite.file));
      expect(suite.measures.length).toBeGreaterThan(0);
      for (const source of suite.measures) {
        expect(gated(source), `${suite.file}: ${source} is not a gated source`).toBe(true);
        expect(imports, `${suite.file}: does not import ${source}`).toContain(source);
      }
      expect(suite.comment.trim()).not.toBe("");
    }
  });

  test("every test file that imports a gated source is loaded by a CI leg or a manifest suite", () => {
    const tests = [...new Set(TEST_TREES.flatMap((tree) => scan(`${tree}/**/*.test.ts`)))].sort();
    const workflows = scan(".github/workflows/*.yml").map(read);
    const loaded = new Set([
      ...setMembers(CI_TEST_SET_FUNCTIONS),
      ...vitestTestIncludes(read("web/vitest.config.ts")).flatMap((pattern) => scan(pattern, resolve(REPO_ROOT, "web")).map((file) => `web/${file}`)),
      ...explicitlyRunTests(workflows, readOrNull),
      ...legs.suites.map((suite) => suite.file),
      ...legs.localOnlyProducers.flatMap((producer) => producer.runs),
    ]);
    // Floors: a broken find or glob must not pass the guard by shrinking a set.
    expect(tests.length).toBeGreaterThan(2500);
    expect(loaded.size).toBeGreaterThan(2500);
    const orphans = unloadedGatedTests(tests, loaded, (file) => importedRepoFiles(file, read(file)), gated);
    expect(orphans).toEqual([]);
  });
});
