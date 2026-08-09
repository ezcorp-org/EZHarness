/**
 * Orphan-drift meta-test (wave 3, CI audit item 3.1).
 *
 * Asserts every `src/**​/*.test.ts` and `packages/**​/*.test.ts` belongs to
 * at least one CI-EXECUTED test set:
 *
 *   - P  (passfail_files)        — shards (P∩C) + `residual-tests` (P\C)
 *   - C  (coverage_host_files)   — the cov-shard host pool
 *   - CRIT (critical_backend_files) — the `backend-critical` job
 *   - the cov-extras legs        — suggest / sdk / harness-client / ai-kit
 *
 * All definitions live in scripts/lib/test-file-sets.sh — this test shells
 * out to the SAME functions the CI runners source, so it can never check a
 * stale copy of the sets. Before this gate, 36 src files (extension
 * handler/provenance/db-isolation suites among them) and the 22 ai-kit files
 * ran in NO CI job; two src files and one ai-kit drift guard had silently
 * rotted failing assertions.
 *
 * This file lives in src/__tests__/ so the P/C sweeps pick it up
 * automatically — the drift gate itself cannot be orphaned.
 *
 * (web/src/** is deliberately out of scope: vitest's suffix globs + the
 * `web-bun-tests` sweep (web_bunleg_files) already partition that tree, and
 * web_bunleg_files is itself a sweep-minus — new web files cannot orphan.)
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// Repo root: this file lives in src/__tests__/.
const REPO_ROOT = join(import.meta.dir, "..", "..");

const SETS_LIB = "scripts/lib/test-file-sets.sh";
const SET_FUNCTIONS = [
  "passfail_files",
  "coverage_host_files",
  "critical_backend_files",
  "suggest_leg_files",
  "sdk_leg_files",
  "harness_client_leg_files",
  "aikit_leg_files",
] as const;

/**
 * Files intentionally in NO CI-executed set. Every entry needs a reason —
 * this is a VISIBLE backlog, never a hidden one. An entry that stops
 * existing, or starts being covered, fails below so the list only shrinks
 * to reality. Currently empty: everything is wired.
 */
const DOCUMENTED_EXCEPTIONS: ReadonlyArray<{ file: string; reason: string }> = [];

function bashLines(cmd: string): string[] {
  const proc = Bun.spawnSync(["bash", "-c", cmd], { cwd: REPO_ROOT });
  if (proc.exitCode !== 0) {
    throw new Error(`bash failed (exit ${proc.exitCode}): ${cmd}\n${proc.stderr.toString()}`);
  }
  return proc.stdout
    .toString()
    .split("\n")
    .filter((l) => l.length > 0);
}

function setMembers(fn: (typeof SET_FUNCTIONS)[number]): string[] {
  return bashLines(`source ${SETS_LIB}; ${fn}`);
}

describe("CI test-set drift", () => {
  const allTestFiles = bashLines(
    "find src packages -name '*.test.ts' ! -path '*/node_modules/*' | sort -u",
  );

  const union = new Set<string>();
  const setSizes: Record<string, number> = {};
  for (const fn of SET_FUNCTIONS) {
    const members = setMembers(fn);
    setSizes[fn] = members.length;
    for (const m of members) union.add(m);
  }

  test("every set function yields a non-empty set (a broken find must not silently empty a CI set)", () => {
    for (const fn of SET_FUNCTIONS) {
      expect(
        setSizes[fn],
        `${fn} returned 0 files — find/pattern rot in ${SETS_LIB}?`,
      ).toBeGreaterThan(0);
    }
  });

  test("sweep sanity floor — the union covers the known population size", () => {
    // 960 src + packages files were in the union when this gate landed
    // (deliberate ratchet floor, same style as CRITICAL_ONLY's 25-file
    // floor). A drop below it means a sweep or leg definition rotted.
    expect(union.size).toBeGreaterThanOrEqual(900);
    expect(allTestFiles.length).toBeGreaterThanOrEqual(900);
  });

  test("every src/ + packages/ test file belongs to >=1 CI-executed set", () => {
    const excepted = new Set(DOCUMENTED_EXCEPTIONS.map((e) => e.file));
    const orphans = allTestFiles.filter((f) => !union.has(f) && !excepted.has(f));
    expect(
      orphans,
      `${orphans.length} test file(s) run in NO CI job:\n  ${orphans.join("\n  ")}\n` +
        `A src/**/*.test.ts should be caught by the P/C sweeps in ${SETS_LIB} — ` +
        `if it appears here, check the sweeps' named exclusions. A packages/** file ` +
        `belongs in a cov-extras leg (add/extend a *_leg_files function AND the ` +
        `matching leg in scripts/test-coverage.sh run_legs). Only a file that ` +
        `genuinely cannot run in CI may join DOCUMENTED_EXCEPTIONS, with a reason.`,
    ).toEqual([]);
  });

  test("documented exceptions stay honest (exist on disk, still uncovered)", () => {
    const onDisk = new Set(allTestFiles);
    for (const e of DOCUMENTED_EXCEPTIONS) {
      expect(onDisk.has(e.file), `exception '${e.file}' no longer exists — remove it`).toBe(true);
      expect(
        union.has(e.file),
        `exception '${e.file}' is now covered by a CI set — remove it`,
      ).toBe(false);
    }
  });
});

/**
 * The examples tree specifically (wave 4). `docs/extensions/examples/**` is
 * outside the src+packages sweep above, and it spent its whole life in C but
 * not in P: coverage-MEASURED, pass/fail-gated NOWHERE. A red assertion there
 * printed, was tolerated by the host-shard classifier, and the build exited 0
 * — the exact "looks like a check, isn't" failure mode this file exists to
 * stop. Membership is now asserted so the sweep in scripts/lib/test-file-sets.sh
 * cannot be narrowed (or rot on a rename) back into a silent false green.
 *
 * P AND C are both required, deliberately: CI never runs the full
 * `scripts/test.sh`, so a P-only membership would move all 178 files into the
 * single-runner `residual-tests` job (P\C) instead of the 12 parallel cov
 * shards. P∩C is the intended home — it hard-gates inside the shards via
 * test-coverage.sh's P-membership check + isolated plain retry sweep.
 */
describe("examples tree pass/fail gating", () => {
  const EXAMPLES_SWEEP =
    "find docs/extensions/examples -name '*.test.ts' ! -path '*/node_modules/*' | sort -u";
  const examplesOnDisk = bashLines(EXAMPLES_SWEEP);
  const inP = new Set(setMembers("passfail_files"));
  const inC = new Set(setMembers("coverage_host_files"));

  test("sweep floor — the examples tree still has its known population", () => {
    // 178 files when this gate landed; a ratchet floor in the same style as
    // CRITICAL_ONLY's 25-file floor. A drop below it means the tree was
    // gutted or the find rotted.
    //
    // 2026-08-03, phase 9: `ez-code-factory` was retired (superseded by the
    // bundled `extensions/ez-factory`), taking 40 test files with it.
    // Measured, not assumed: the sweep saw 179 at the branch point, not the
    // 178 the line above records — that count was already off by one — so
    // 179 → 139. The floor moves with the deliberate deletion, and it moves
    // TIGHTER, not looser: 135 leaves a 4-file margin where the old 150 left
    // 29. Nothing else may lower it; a fall below 135 still means the sweep
    // rotted or a tree was gutted by accident.
    expect(
      examplesOnDisk.length,
      `only ${examplesOnDisk.length} example test file(s) found — did the sweep rot?`,
    ).toBeGreaterThanOrEqual(135);
  });

  test("every examples test file is in the pass/fail set P", () => {
    const ungated = examplesOnDisk.filter((f) => !inP.has(f));
    expect(
      ungated,
      `${ungated.length} example test file(s) are NOT pass/fail-gated — a red ` +
        `assertion in them would exit 0:\n  ${ungated.join("\n  ")}\n` +
        `Check the docs/extensions/examples sweep in ${SETS_LIB}.`,
    ).toEqual([]);
  });

  test("...and in the coverage set C, so the cov shards are their gating home (P∩C)", () => {
    const unmeasured = examplesOnDisk.filter((f) => !inC.has(f));
    expect(
      unmeasured,
      `${unmeasured.length} example test file(s) left the coverage set C — they ` +
        `would fall into the single-runner residual job instead of the 12 ` +
        `parallel cov shards:\n  ${unmeasured.join("\n  ")}`,
    ).toEqual([]);
  });
});
