/**
 * scripts/merge-lcov.ts — compiled workspace output never enters the merge.
 *
 * WHY THIS FILE EXISTS
 *   A workspace package ships its TypeScript sources AND the JavaScript `tsc`
 *   emits from them. `packages/@ezcorp/factory-sdk/package.json` points the
 *   `"bun"` export condition at `./src/index.ts` and the `"import"` condition
 *   at `./dist/index.js`, so the SAME import resolves to a different file
 *   depending on who is running: Bun loads the source, and every Node-resolved
 *   producer — the Vitest leg, `node --test`, the built app — loads `dist`.
 *
 *   The Node producer's instrumenter then reports coverage for the BUILD
 *   ARTEFACT beside the source it was compiled from. Merged, that is one
 *   module measured twice: once under the path `scripts/coverage-thresholds.json`
 *   keys, and once under a path no key names, no test targets, and no
 *   reviewer reads. It also silently moves the aggregate floor
 *   (`scripts/check-global-coverage.ts`), and DOWNWARD, which is the opposite
 *   of what a build artefact's reputation suggests. Measured on this tree the
 *   fifteen compiled modules carry 3964 lines at 12.06%, while the sources
 *   they were compiled from carry theirs at 99.2-100%: an importer that reads
 *   two constants off the built barrel runs its module top level and almost
 *   none of its function bodies, whereas the suite exercises the sources. So
 *   the duplicate is not merely redundant, it is a large block of
 *   near-uncovered lines the floor has to carry. Dropping it RAISED the local
 *   floor from 65.46% to 67.37%.
 *
 *   Dropping it at the MERGE rather than in one leg's own filter is what makes
 *   the rule hold everywhere: the shard pre-merge, the local host merge, and
 *   the CI coverage job's merge of the downloaded artifacts all run through
 *   `merge-lcov.ts`, and a producer added later inherits the rule for free.
 *
 * WHAT MUST NOT HAPPEN: the package's own `src/**` records are the measured
 * ones and every `packages/@ezcorp/*` threshold key depends on them, so the
 * drop is asserted in BOTH directions in every case below.
 *
 * STRATEGY: merge-lcov.ts takes CLI args and resolves SF paths against the
 * real repo root, so it runs from its real path against sandbox lcov inputs —
 * the same spawn-not-import approach as merge-lcov-shard-vote.test.ts.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isCompiledWorkspaceOutput } from "../../scripts/coverage-config.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const MERGE_SCRIPT = join(REPO_ROOT, "scripts/merge-lcov.ts");

/** A real source file, so the merge's noise filter reads the text it expects. */
const SDK_SOURCE = "packages/@ezcorp/factory-sdk/src/index.ts";
/** The artefact `tsc` emits from it, which Node resolves the package import to. */
const SDK_DIST = "packages/@ezcorp/factory-sdk/dist/index.js";

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "merge-dist-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** One lcov record with positive hits, so nothing is dropped as a zero. */
function record(sf: string, lines: readonly number[]): string {
  return ["TN:ezcorp-node-v8", `SF:${sf}`, ...lines.map((n) => `DA:${n},3`), `LF:${lines.length}`, `LH:${lines.length}`, "end_of_record"].join("\n");
}

/** Write one input lcov into the sandbox and return the glob the merge takes. */
function writeInputs(dir: string, inputs: readonly string[]): string {
  const inputDir = join(root, dir);
  mkdirSync(inputDir, { recursive: true });
  inputs.forEach((text, index) => {
    writeFileSync(join(inputDir, `leg-${index}.info`), `${text}\n`);
  });
  return join(inputDir, "*.info");
}

/** Spawn the merge; returns the merged text, or the process result on failure. */
function merge(globPat: string, outName: string): { ok: boolean; text: string; stderr: string } {
  const outPath = join(root, outName);
  const proc = Bun.spawnSync(["bun", MERGE_SCRIPT, globPat, outPath], { cwd: root });
  const ok = proc.exitCode === 0;
  return { ok, text: ok ? require("node:fs").readFileSync(outPath, "utf8") : "", stderr: proc.stderr.toString() };
}

/** The `SF:` paths a merged lcov names, in output order. */
function sources(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("SF:")).map((l) => l.slice(3));
}

describe("isCompiledWorkspaceOutput", () => {
  test("names a scoped package's dist tree and not its sources", () => {
    expect(isCompiledWorkspaceOutput(SDK_DIST)).toBe(true);
    expect(isCompiledWorkspaceOutput("packages/@ezcorp/factory-orchestrator/dist/workflow.js")).toBe(true);
    expect(isCompiledWorkspaceOutput(SDK_SOURCE)).toBe(false);
    expect(isCompiledWorkspaceOutput("packages/@ezcorp/factory-sdk/src/compiler.ts")).toBe(false);
  });

  test("names an unscoped workspace package's dist tree", () => {
    expect(isCompiledWorkspaceOutput("packages/widget/dist/index.js")).toBe(true);
    expect(isCompiledWorkspaceOutput("packages/widget/src/index.ts")).toBe(false);
  });

  test("is anchored at packages/, so a product path that merely contains 'dist' is source", () => {
    expect(isCompiledWorkspaceOutput("src/factory/distribution-lock.ts")).toBe(false);
    expect(isCompiledWorkspaceOutput("web/src/lib/dist-helper.ts")).toBe(false);
    expect(isCompiledWorkspaceOutput("src/dist/thing.ts")).toBe(false);
  });
});

describe("merge-lcov drops compiled workspace output", () => {
  test("keeps the package's source record and drops the dist record beside it", () => {
    const glob = writeInputs("both", [
      record(SDK_DIST, [1, 2, 3]),
      record(SDK_SOURCE, [1, 2]),
    ]);
    const merged = merge(glob, "both.info");
    expect(merged.ok).toBe(true);
    expect(sources(merged.text)).toEqual([SDK_SOURCE]);
    expect(merged.text).not.toContain("/dist/");
  });

  test("drops the dist record whichever leg emitted it, and keeps every other source", () => {
    const glob = writeInputs("mixed", [
      [record(SDK_DIST, [1, 2]), record("src/factory/artifacts.ts", [10])].join("\n"),
      [record("packages/@ezcorp/factory-transport/dist/index.js", [4]), record(SDK_SOURCE, [1])].join("\n"),
    ]);
    const merged = merge(glob, "mixed.info");
    expect(merged.ok).toBe(true);
    expect(sources(merged.text).sort()).toEqual([SDK_SOURCE, "src/factory/artifacts.ts"]);
  });

  test("fails closed rather than writing an empty lcov when dist was all there was", () => {
    // The drop must never turn "the producers measured nothing but artefacts"
    // into a silent pass: merge-lcov's empty-output guard still has to fire.
    const glob = writeInputs("only-dist", [record(SDK_DIST, [1, 2, 3])]);
    const merged = merge(glob, "only-dist.info");
    expect(merged.ok).toBe(false);
    expect(merged.stderr).toContain("refusing to write an empty");
  });
});
