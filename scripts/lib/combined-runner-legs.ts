/**
 * The local combined runner's extra legs (scripts/combined-runner-legs.json)
 * and the drift check that keeps the manifest and CI's leg set honest.
 *
 * WHY. The combined runner and the wave4f driver run their own leg lists, not
 * ci.yml. A suite that CI loads but those lists do not made a gated source look
 * uncovered locally (W18c, 2026-09-27: eight suites, then the CI producers).
 * The manifest names those extras; ci.yml stays the authority for CI. The drift
 * guard (src/__tests__/combined-runner-legs.test.ts) fails, by file name, for
 * any test file that imports a gated source and that no CI leg and no manifest
 * suite loads.
 */
import { Glob } from "bun";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { escapeGlob, isExcluded, isSourceFile, REPO_ROOT } from "../coverage-config.ts";
import { workflowCommands } from "./ci-registration.ts";

export const MANIFEST_PATH = "scripts/combined-runner-legs.json";

/** A CI producer the runner runs as-is, to measure what the named ci.yml job measures. */
export type RunnerProducer = { id: string; workflow: string; ciJob: string; command: string; comment: string };
/** One test file the runner loads under coverage, with the gated sources it exists to measure. */
export type RunnerSuite = { file: string; cwd: "." | "web"; measures: string[]; comment: string };
/**
 * A repository producer that NO CI workflow runs yet. Listed so the runner runs
 * it and so the gap stays visible: the guard fails once a workflow adopts it,
 * and the entry must then move to `producers`.
 */
export type LocalOnlyProducer = {
  id: string;
  command: string;
  runs: string[];
  owner: string;
  reason: string;
  decision: string;
  comment: string;
};
export type RunnerLegs = {
  comment: string;
  producers: RunnerProducer[];
  localOnlyProducers: LocalOnlyProducer[];
  suites: RunnerSuite[];
};

export function readRunnerLegs(root = REPO_ROOT): RunnerLegs {
  return JSON.parse(readFileSync(resolve(root, MANIFEST_PATH), "utf8")) as RunnerLegs;
}

/** The test-file sets in scripts/lib/test-file-sets.sh that ci.yml's jobs execute. */
export const CI_TEST_SET_FUNCTIONS = [
  "passfail_files",
  "coverage_host_files",
  "web_utility_coverage_files",
  "critical_backend_files",
  "suggest_leg_files",
  "sdk_leg_files",
  "harness_client_leg_files",
  "aikit_leg_files",
  "factory_orchestrator_test_files",
  "security_test_files",
  "web_bunleg_files",
  "residual_passfail_files",
  "lane_bound_test_files",
] as const;

/** Trees that hold test files for gated sources. */
export const TEST_TREES = ["src", "packages", "scripts", "web/src", "docs/extensions", "extensions", "worker", "tests"] as const;

/** A source the per-file gate (a threshold key) or the new-file gate would measure. */
export function gatedSourcePredicate(thresholdKeys: readonly string[]): (file: string) => boolean {
  const globs = thresholdKeys.map((key) => new Glob(escapeGlob(key)));
  return (file) => !isExcluded(file) && (isSourceFile(file) || globs.some((glob) => glob.match(file)));
}

const IMPORT_SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bmock\.module\(\s*|\bvi\.mock\(\s*|\brequire\(\s*)["']([^"']+)["']/g;
const RESOLVE_SUFFIXES = ["", ".ts", ".js", ".svelte.ts", "/index.ts"];

/** Repo-relative files a test statically imports or mocks through a relative or `$lib` specifier. */
export function importedRepoFiles(testFile: string, text: string, root = REPO_ROOT): string[] {
  const files = new Set<string>();
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1]!;
    const base = specifier.startsWith(".")
      ? resolve(root, dirname(testFile), specifier)
      : specifier === "$lib" || specifier.startsWith("$lib/")
        ? resolve(root, "web/src/lib", `.${specifier.slice(4)}`)
        : null;
    if (!base) continue;
    const hit = RESOLVE_SUFFIXES.map((suffix) => base + suffix).find((path) => existsSync(path) && statSync(path).isFile());
    if (hit) files.add(relative(root, hit));
  }
  return [...files].sort();
}

/** String literals of the `include` array inside vitest.config.ts's `test` block (paths relative to web/). */
export function vitestTestIncludes(config: string): string[] {
  const block = /\btest:\s*\{[\s\S]*?\binclude:\s*\[([\s\S]*?)\]/.exec(config)?.[1] ?? "";
  const withoutComments = block.replace(/\/\/[^\n]*/g, "");
  return [...withoutComments.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!);
}

/** Test paths a workflow's commands, or a shell script they run, name explicitly (e.g. tests/postgres suites). */
export function explicitlyRunTests(workflows: readonly string[], readScript: (path: string) => string | null): Set<string> {
  const texts = workflows.map(workflowCommands);
  for (const script of new Set(texts.flatMap((text) => [...text.matchAll(/\bscripts\/[\w./-]+\.sh\b/g)].map((m) => m[0])))) {
    const body = readScript(script);
    if (body) texts.push(workflowCommands(body));
  }
  const tests = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/(?:\.\/)?((?:tests|src|web|packages|scripts|extensions|worker|docs)\/[\w@./[\]()+-]+\.test\.ts)\b/g)) {
      tests.add(match[1]!);
    }
  }
  return tests;
}

/** Test files that import a gated source and that no CI leg and no manifest suite loads. */
export function unloadedGatedTests(
  testFiles: readonly string[],
  loaded: ReadonlySet<string>,
  importsOf: (file: string) => readonly string[],
  gated: (file: string) => boolean,
): string[] {
  return testFiles.filter((file) => !loaded.has(file) && importsOf(file).some(gated)).sort();
}
