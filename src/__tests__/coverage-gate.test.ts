/**
 * Coverage-gate semantics unit tests for scripts/check-coverage.ts +
 * scripts/merge-lcov.ts.
 *
 * STRATEGY
 *   Per-test temp sandbox. Because check-coverage.ts resolves
 *   REPO_ROOT via `import.meta.dir`, we copy the script into
 *   <sandbox>/scripts/ so it rebases onto the sandbox, then spawn it
 *   with `bun`. Synthetic lcov + thresholds.json live in the sandbox.
 *   merge-lcov.ts takes CLI args (cwd-independent), so it runs against
 *   the real file with explicit args — no copy needed.
 *
 *   Spawn-not-import is authorised by pm-v3 (2026-04-14 ruling): the
 *   "no subprocess fork" line in the brief was aimed at the full
 *   scripts/test-coverage.sh pipeline, not the gate/merge scripts.
 *
 * RULINGS applied (pm-v3, 2026-04-14):
 *
 *   Test 1 (Empty lcov): FIX not lock. Two guards in
 *     scripts/check-coverage.ts now make a misconfigured/empty gate
 *     audible. (a) Any EXACT-file threshold key (no `*`) with no
 *     matching lcov SF is reported as "listed in thresholds but no
 *     lcov data" and fails the gate. (b) Failing that, if `enforced`
 *     stays 0 the script exits 1 with "no files matched any threshold
 *     rule". Because REAL_THRESHOLDS contains exact-file keys, an
 *     empty / all-unmatched lcov trips guard (a) first. Test asserts
 *     the exact-key fail-loud behaviour directly. Rationale: silent
 *     gate-pass on a misconfigured CI was a real defect.
 *
 *   Test 2 (Missing-file): FIX not lock. A threshold rule with no
 *     matching SF is now surfaced — but only for EXACT-file keys
 *     (no `*`). Wildcard keys remain a silent fallback (the
 *     wildcard-is-fallback pattern), so a deleted/narrowed file under
 *     a wildcard glob is still a no-op. Test asserts: an exact-file
 *     threshold target absent from lcov fails the gate with the
 *     "no lcov data" diagnostic, with no crash / NaN / type error.
 *
 *   Test 7 (merge-lcov DA semantics): LOCK current, re-aim assertion.
 *     merge-lcov.ts SUMS per-(SF,line). SUM vs MAX is gate-verdict-
 *     equivalent at the 0/nonzero boundary (what the coverage %
 *     calculation observes). Test asserts the boundary invariant —
 *     both-zero stays zero, at-least-one-nonzero becomes nonzero — so
 *     a future SUM→MAX swap would not break this case. The v2
 *     handoff §6 "SDK 90.27% vs 100%" known-limitation is a sharding
 *     artifact (different code paths load channel.ts in host vs
 *     bundled shards), NOT a merge artifact; not fixable here.
 *
 * BASELINE-REGRESSION ANCHOR (test 8)
 *   Locks the 28-under-threshold set produced by check-coverage
 *   against the Gate #2 lcov (HEAD 05c2617, /tmp/gate2-cov.log), plus
 *   src/extensions/lifecycle-dispatcher.ts — the one exact-file
 *   threshold key in REAL_THRESHOLDS not in that 28-set, given an
 *   lcov record so it's a coverage violation rather than the
 *   "no lcov data" fail-loud exercised by #1/#2. The synthetic anchor
 *   fixture gives every one of these files the same artificially-low
 *   coverage (10%) so each violates its respective threshold; this
 *   keeps the fixture compact (1 SF-record/file) while preserving the
 *   full path list as the invariant.
 *
 *     packages/@ezcorp/sdk/src/runtime/channel.ts
 *     packages/@ezcorp/sdk/src/runtime/fs.ts
 *     packages/@ezcorp/sdk/src/runtime/lock.ts
 *     src/extensions/json-rpc.ts
 *     src/extensions/loader.ts
 *     src/extensions/registry.ts
 *     src/extensions/storage-handler.ts
 *     src/extensions/subprocess.ts
 *     src/extensions/tool-executor.ts
 *     src/extensions/sdk/test-helpers.ts
 *     src/extensions/sdk/test-runner.ts
 *     src/extensions/sdk/publish.ts
 *     src/extensions/sdk/dev.ts
 *     src/extensions/sdk/templates/agent.ts
 *     src/extensions/sdk/templates/multi.ts
 *     src/extensions/sdk/templates/skill.ts
 *     src/extensions/sdk/templates/tool.ts
 *     docs/extensions/examples/task-stack/index.ts
 *     docs/extensions/examples/auto-note/index.ts
 *     web/src/lib/api.ts
 *     web/src/lib/markdown.ts
 *     web/src/lib/ws.ts
 *     web/src/lib/mention-logic.ts
 *     web/src/lib/server/context.ts
 *     web/src/lib/server/security/api-keys.ts
 *     web/src/lib/server/security/payload.ts
 *     web/src/lib/server/security/rate-limiter.ts
 *     web/src/lib/server/security/url-validation.ts
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CHECK_SCRIPT_SRC = join(REPO_ROOT, "scripts/check-coverage.ts");
const MERGE_SCRIPT = join(REPO_ROOT, "scripts/merge-lcov.ts");

// Real coverage-thresholds.json contents frozen here so the anchor
// test is robust against the sandbox file never being visited.
const REAL_THRESHOLDS: Record<string, number> = {
  "packages/@ezcorp/sdk/src/**": 100,
  "src/extensions/sdk/**": 100,
  "src/extensions/json-rpc.ts": 100,
  "src/extensions/subprocess.ts": 95,
  "src/extensions/registry.ts": 95,
  "src/extensions/loader.ts": 90,
  "src/extensions/storage-handler.ts": 95,
  "src/extensions/lifecycle-dispatcher.ts": 95,
  "src/extensions/tool-executor.ts": 95,
  "docs/extensions/examples/*/index.ts": 100,
  "docs/extensions/examples/*/lib/**": 95,
  "web/src/lib/**": 90,
};

// Baseline regression anchor — the still-gated subset of the original Gate #2
// set. 12 of the original 28 (the 4 sdk/templates, auto-note, api, markdown,
// mention-logic, context, and the api-keys/payload/rate-limiter security
// helpers) were moved to check-coverage.ts EXCLUDES once it became clear the
// dual bun+v8 instrumentation / template-literal interiors can't be measured
// cleanly — so they no longer count as gated violations.
const BASELINE_28_FILES: readonly string[] = [
  "packages/@ezcorp/sdk/src/runtime/channel.ts",
  "packages/@ezcorp/sdk/src/runtime/fs.ts",
  "packages/@ezcorp/sdk/src/runtime/lock.ts",
  "src/extensions/json-rpc.ts",
  "src/extensions/loader.ts",
  "src/extensions/registry.ts",
  "src/extensions/storage-handler.ts",
  "src/extensions/subprocess.ts",
  "src/extensions/tool-executor.ts",
  "src/extensions/sdk/test-helpers.ts",
  "src/extensions/sdk/test-runner.ts",
  "src/extensions/sdk/publish.ts",
  "src/extensions/sdk/dev.ts",
  "docs/extensions/examples/task-stack/index.ts",
  "web/src/lib/ws.ts",
  "web/src/lib/server/security/url-validation.ts",
];

type Sandbox = { root: string; cleanup: () => void };

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "covgate-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "coverage"), { recursive: true });
  copyFileSync(CHECK_SCRIPT_SRC, join(root, "scripts/check-coverage.ts"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function writeFixtures(
  root: string,
  lcov: string,
  thresholds: Record<string, number>,
): Promise<void> {
  await Bun.write(join(root, "coverage/lcov.info"), lcov);
  await Bun.write(
    join(root, "scripts/coverage-thresholds.json"),
    JSON.stringify(thresholds, null, 2),
  );
}

type RunResult = { exitCode: number; stdout: string; stderr: string };

async function runCheck(root: string): Promise<RunResult> {
  const proc = Bun.spawn(
    ["bun", join(root, "scripts/check-coverage.ts")],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function runMerge(
  cwd: string,
  globPat: string,
  outPath: string,
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", MERGE_SCRIPT, globPat, outPath], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Build one lcov record (SF + DA + LF/LH + end_of_record) for a
 * synthetic source file inside the sandbox. Only DA is emitted —
 * check-coverage derives its totals from DA directly.
 */
function lcovRecord(
  sandboxRoot: string,
  relPath: string,
  totalLines: number,
  coveredLines: readonly number[],
): string {
  const covered = new Set(coveredLines);
  const abs = join(sandboxRoot, relPath);
  const parts: string[] = ["TN:", `SF:${abs}`];
  let lh = 0;
  for (let i = 1; i <= totalLines; i++) {
    const hit = covered.has(i) ? 1 : 0;
    parts.push(`DA:${i},${hit}`);
    if (hit > 0) lh++;
  }
  parts.push(`LF:${totalLines}`);
  parts.push(`LH:${lh}`);
  parts.push("end_of_record");
  return parts.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 1. Empty lcov — zero SF records.
//
// Two guards make a misconfigured/empty gate audible
// (scripts/check-coverage.ts):
//   (a) any EXACT-file threshold key with no matching lcov SF fails
//       loud with "listed in thresholds but no lcov data";
//   (b) failing that, `enforced === 0` exits 1 with "no files matched
//       any threshold rule".
// REAL_THRESHOLDS carries exact-file keys (json-rpc.ts, loader.ts, …),
// so an empty / all-unmatched lcov trips guard (a) first. This
// prevents silent gate-pass on a misconfigured CI or accidentally
// empty lcov.
// ---------------------------------------------------------------------------
describe("coverage-gate semantics: #1 empty lcov", () => {
  test("empty lcov fails loud on exact-file threshold keys with no lcov data", async () => {
    const sb = makeSandbox();
    try {
      await writeFixtures(sb.root, "", REAL_THRESHOLDS);
      const r = await runCheck(sb.root);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("listed in thresholds but no lcov data");
      // An exact-file key from REAL_THRESHOLDS must be named.
      expect(r.stderr).toContain("src/extensions/json-rpc.ts");
      expect(r.stdout).not.toContain("PASSED");
    } finally {
      sb.cleanup();
    }
  });

  test("lcov with only unmatched SF records still trips the exact-key guard", async () => {
    // SF records exist but none match a threshold glob; the exact-file
    // threshold keys remain unmatched → guard (a) fires.
    const sb = makeSandbox();
    try {
      // src/unrelated/path/foo.ts is not covered by any threshold key.
      const lcov = lcovRecord(sb.root, "src/unrelated/path/foo.ts", 10, [1, 2, 3]);
      await writeFixtures(sb.root, lcov, REAL_THRESHOLDS);
      const r = await runCheck(sb.root);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("listed in thresholds but no lcov data");
    } finally {
      sb.cleanup();
    }
  });

  test("all-wildcard thresholds with empty lcov hit the 'no files matched' guard", async () => {
    // No exact-file keys → guard (a) is vacuous; enforced stays 0 →
    // guard (b) fires with the "no files matched" diagnostic.
    const sb = makeSandbox();
    try {
      const wildcardOnly: Record<string, number> = {
        "packages/@ezcorp/sdk/src/**": 100,
        "web/src/lib/**": 90,
      };
      await writeFixtures(sb.root, "", wildcardOnly);
      const r = await runCheck(sb.root);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("no files matched any threshold rule");
      expect(r.stdout).not.toContain("PASSED");
    } finally {
      sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Missing-file — threshold references a file absent from lcov.
//
// Current check-coverage.ts splits by key shape:
//   - EXACT-file key (no `*`) with no matching lcov SF → fail loud
//     ("listed in thresholds but no lcov data"). This catches typos,
//     moved files, or paths the runner never exercises.
//   - WILDCARD key with no matching SF → silent fallback (the
//     wildcard-is-fallback pattern; a deleted/narrowed file under a
//     wildcard glob is a legitimate no-op).
// Both cases must avoid crash / NaN / type error.
// ---------------------------------------------------------------------------
describe("coverage-gate semantics: #2 missing-file in lcov", () => {
  test("wildcard threshold with no matching SF is a silent no-op (no crash, no NaN)", async () => {
    // Only wildcard thresholds, and the one present file passes them.
    // A wildcard glob matching nothing is a legitimate fallback, not a
    // failure.
    const sb = makeSandbox();
    try {
      const passingFile = "packages/@ezcorp/sdk/src/runtime/present.ts";
      const lcov = lcovRecord(sb.root, passingFile, 10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const thresholds: Record<string, number> = {
        "packages/@ezcorp/sdk/src/runtime/**": 100,
        // Wildcard key that matches no present SF — must stay silent.
        "web/src/lib/**": 90,
      };
      await writeFixtures(sb.root, lcov, thresholds);
      const r = await runCheck(sb.root);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain("NaN");
      expect(r.stderr).not.toContain("NaN");
      expect(r.stderr).not.toContain("TypeError");
      expect(r.stderr).not.toContain("ReferenceError");
      expect(r.stdout).toContain("PASSED");
    } finally {
      sb.cleanup();
    }
  });

  test("exact-file threshold absent from lcov fails loud (no crash, no NaN)", async () => {
    const sb = makeSandbox();
    try {
      const passingFile = "packages/@ezcorp/sdk/src/runtime/present.ts";
      const lcov = lcovRecord(sb.root, passingFile, 10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const thresholds: Record<string, number> = {
        "packages/@ezcorp/sdk/src/runtime/**": 100,
        // Exact-file key whose target is absent → fail loud.
        "packages/@ezcorp/sdk/src/deleted.ts": 100,
      };
      await writeFixtures(sb.root, lcov, thresholds);
      const r = await runCheck(sb.root);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("packages/@ezcorp/sdk/src/deleted.ts");
      expect(r.stderr).toContain("listed in thresholds but no lcov data");
      expect(r.stdout).not.toContain("NaN");
      expect(r.stderr).not.toContain("NaN");
      expect(r.stderr).not.toContain("TypeError");
      expect(r.stderr).not.toContain("ReferenceError");
    } finally {
      sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Wildcard precedence — most-specific (longest literal-prefix) wins.
// ---------------------------------------------------------------------------
describe("coverage-gate semantics: #3 wildcard precedence", () => {
  test("more-specific glob wins for overlapping thresholds", async () => {
    const sb = makeSandbox();
    try {
      // 97%-covered file. Outer glob = 100 (would fail); inner = 95 (passes).
      const target = "packages/@ezcorp/sdk/src/runtime/http.ts";
      const covered: number[] = [];
      for (let i = 1; i <= 97; i++) covered.push(i);
      const lcov = lcovRecord(sb.root, target, 100, covered);
      const thresholds: Record<string, number> = {
        "packages/@ezcorp/sdk/src/**": 100,
        "packages/@ezcorp/sdk/src/runtime/**": 95,
      };
      await writeFixtures(sb.root, lcov, thresholds);
      const r = await runCheck(sb.root);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("1 enforced file(s)");
      expect(r.stderr).not.toContain("http.ts");
    } finally {
      sb.cleanup();
    }
  });

  test("outer glob is honoured when no more-specific match exists", async () => {
    const sb = makeSandbox();
    try {
      // Same 97%-covered file, but now only the 100%-outer glob exists.
      const target = "packages/@ezcorp/sdk/src/runtime/http.ts";
      const covered: number[] = [];
      for (let i = 1; i <= 97; i++) covered.push(i);
      const lcov = lcovRecord(sb.root, target, 100, covered);
      const thresholds: Record<string, number> = {
        "packages/@ezcorp/sdk/src/**": 100,
      };
      await writeFixtures(sb.root, lcov, thresholds);
      const r = await runCheck(sb.root);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(target);
      expect(r.stderr).toContain("97.00%");
      expect(r.stderr).toContain("< 100%");
    } finally {
      sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Exclusion enforcement — files matching any EXCLUDES pattern in
//    check-coverage.ts are never counted toward failure, even if a
//    threshold would otherwise enforce them.
//
// EXCLUDES (frozen verbatim in scripts/check-coverage.ts):
//   "src/extensions/sdk/init.ts"
//   "src/db/migrations/**"
//   "src/providers/**"
//   "web/src/routes/**/+*.svelte"
//   "web/e2e/**"
// ---------------------------------------------------------------------------
describe("coverage-gate semantics: #4 exclusion enforcement", () => {
  test("excluded files are never counted as violations", async () => {
    const sb = makeSandbox();
    try {
      // Give every excluded pattern a representative file at 20%
      // coverage. Also add a 100%-covered canary to prove the gate is
      // running enforcement (not accidentally vacuous).
      const excludedFiles = [
        "src/extensions/sdk/init.ts",
        "src/db/migrations/001_initial.ts",
        "src/providers/anthropic.ts",
        "web/src/routes/foo/+page.svelte",
        "web/e2e/login.spec.ts",
      ];
      const canary = "packages/@ezcorp/sdk/src/runtime/canary.ts";
      const canaryCovered: number[] = [];
      for (let i = 1; i <= 10; i++) canaryCovered.push(i);

      const parts = excludedFiles.map((f) => lcovRecord(sb.root, f, 10, [1, 2]));
      parts.push(lcovRecord(sb.root, canary, 10, canaryCovered));
      const lcov = parts.join("");

      // Thresholds that would fail every excluded file if not excluded.
      const thresholds: Record<string, number> = {
        "src/extensions/sdk/**": 100,
        "src/db/migrations/**": 100,
        "src/providers/**": 100,
        "web/src/routes/**": 100,
        "web/e2e/**": 100,
        "packages/@ezcorp/sdk/src/**": 100,
      };
      await writeFixtures(sb.root, lcov, thresholds);
      const r = await runCheck(sb.root);

      expect(r.exitCode).toBe(0);
      for (const f of excludedFiles) {
        expect(r.stderr).not.toContain(f);
      }
      expect(r.stdout).toContain("1 enforced file(s)");
    } finally {
      sb.cleanup();
    }
  });

  test("non-excluded file at same SDK prefix IS enforced (negative control)", async () => {
    // Flips the init.ts case: a sibling file (not in EXCLUDES) under
    // the same threshold glob at 20% coverage must fail. Proves
    // exclusion is pattern-scoped, not prefix-eating.
    const sb = makeSandbox();
    try {
      const sibling = "src/extensions/sdk/not-excluded-sibling.ts";
      const lcov = lcovRecord(sb.root, sibling, 10, [1, 2]);
      const thresholds: Record<string, number> = {
        "src/extensions/sdk/**": 100,
      };
      await writeFixtures(sb.root, lcov, thresholds);
      const r = await runCheck(sb.root);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(sibling);
      expect(r.stderr).toContain("20.00%");
    } finally {
      sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Above-threshold pass — 100% coverage vs 95% threshold.
// ---------------------------------------------------------------------------
describe("coverage-gate semantics: #5 above-threshold pass", () => {
  test("fully-covered file passes at 95% threshold", async () => {
    const sb = makeSandbox();
    try {
      const target = "packages/@ezcorp/sdk/src/runtime/example.ts";
      const covered: number[] = [];
      for (let i = 1; i <= 10; i++) covered.push(i);
      const lcov = lcovRecord(sb.root, target, 10, covered);
      const thresholds: Record<string, number> = {
        "packages/@ezcorp/sdk/src/runtime/**": 95,
      };
      await writeFixtures(sb.root, lcov, thresholds);
      const r = await runCheck(sb.root);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("PASSED");
      expect(r.stdout).toContain("1 enforced file(s)");
      expect(r.stderr).toBe("");
    } finally {
      sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Below-threshold fail — 50% coverage vs 90% threshold with exact
//    missed-line list.
// ---------------------------------------------------------------------------
describe("coverage-gate semantics: #6 below-threshold fail", () => {
  test("half-covered file fails at 90% threshold and reports missed lines", async () => {
    const sb = makeSandbox();
    try {
      const target = "packages/@ezcorp/sdk/src/runtime/example.ts";
      const covered: readonly number[] = [1, 2, 3, 4, 5];
      const missed: readonly number[] = [6, 7, 8, 9, 10];
      const lcov = lcovRecord(sb.root, target, 10, covered);
      const thresholds: Record<string, number> = {
        "packages/@ezcorp/sdk/src/runtime/**": 90,
      };
      await writeFixtures(sb.root, lcov, thresholds);
      const r = await runCheck(sb.root);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(target);
      expect(r.stderr).toContain("50.00%");
      expect(r.stderr).toContain("< 90%");
      expect(r.stderr).toContain(`missed lines: ${missed.join(",")}`);
    } finally {
      sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. merge-lcov shard union — gate-relevant boundary invariant.
//
// Case 7: merge-lcov currently SUMs DA hits per line. MAX would also
// be acceptable — both agree at the 0/nonzero boundary (the only
// thing the coverage % calculation observes). Test asserts boundary
// preservation, not SUM specifically, so a future MAX switch won't
// break this case (ruling pm-v3 2026-04-14).
// ---------------------------------------------------------------------------
describe("coverage-gate semantics: #7 merge-lcov shard union", () => {
  test("merged DA preserves the 0-vs-nonzero boundary per line", async () => {
    const sb = makeSandbox();
    try {
      const target = "packages/@ezcorp/sdk/src/runtime/merged.ts";
      const abs = join(sb.root, target);
      const shardDir = (i: number) => join(sb.root, `shards/cov_${i}`);
      mkdirSync(shardDir(0), { recursive: true });
      mkdirSync(shardDir(1), { recursive: true });
      // Three boundary cases per line:
      //   line 5: (0, nonzero) → merged must be nonzero
      //   line 6: (nonzero, 0) → merged must be nonzero
      //   line 7: (0, 0)       → merged must stay 0
      const shardA = [
        "TN:",
        `SF:${abs}`,
        "DA:5,0",
        "DA:6,3",
        "DA:7,0",
        "LF:3",
        "LH:1",
        "end_of_record",
        "",
      ].join("\n");
      const shardB = [
        "TN:",
        `SF:${abs}`,
        "DA:5,7",
        "DA:6,0",
        "DA:7,0",
        "LF:3",
        "LH:1",
        "end_of_record",
        "",
      ].join("\n");
      await Bun.write(join(shardDir(0), "lcov.info"), shardA);
      await Bun.write(join(shardDir(1), "lcov.info"), shardB);

      const outPath = join(sb.root, "merged.info");
      const r = await runMerge(sb.root, "shards/cov_*/lcov.info", outPath);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("merged 1 source files");

      const merged = await Bun.file(outPath).text();
      expect(merged).toContain(`SF:${abs}`);

      // Parse merged DA records — assert boundary, not numeric value.
      const daHits = new Map<number, number>();
      for (const rawLine of merged.split("\n")) {
        if (!rawLine.startsWith("DA:")) continue;
        const body = rawLine.slice(3);
        const commaIdx = body.indexOf(",");
        if (commaIdx < 0) continue;
        const lineNo = Number(body.slice(0, commaIdx));
        const hits = Number(body.slice(commaIdx + 1));
        if (Number.isNaN(lineNo) || Number.isNaN(hits)) continue;
        daHits.set(lineNo, hits);
      }

      const line5 = daHits.get(5);
      const line6 = daHits.get(6);
      const line7 = daHits.get(7);
      expect(line5).toBeDefined();
      expect(line6).toBeDefined();
      expect(line7).toBeDefined();
      if (line5 !== undefined) expect(line5).toBeGreaterThan(0);
      if (line6 !== undefined) expect(line6).toBeGreaterThan(0);
      if (line7 !== undefined) expect(line7).toBe(0);

      // LH/LF bookkeeping reflects 2 nonzero out of 3 lines.
      expect(merged).toContain("LF:3");
      expect(merged).toContain("LH:2");
    } finally {
      sb.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Baseline-regression anchor — freeze the 28-under-threshold set
//    from Gate #2 (HEAD 05c2617, /tmp/gate2-cov.log).
//
// If a future change to scripts/check-coverage.ts or
// coverage-thresholds.json silently changes which files the gate
// would flag, this test catches it. The 28 file paths are listed at
// the top of this file so human reviewers see the anchor intent
// without chasing a fixture file.
// ---------------------------------------------------------------------------
// The lone exact-file threshold key from REAL_THRESHOLDS that is NOT
// in BASELINE_28_FILES. Giving it a 10%-coverage fixture record turns
// its would-be "no lcov data" fail-loud (see #1/#2) into a uniform
// coverage violation, so the anchor measures one coherent set: every
// enforced exact/wildcard target at 10% coverage.
const LIFECYCLE_DISPATCHER = "src/extensions/lifecycle-dispatcher.ts";
const ANCHOR_FILES: readonly string[] = [...BASELINE_28_FILES, LIFECYCLE_DISPATCHER];

describe("coverage-gate semantics: #8 baseline-regression anchor", () => {
  test("Gate #2 under-threshold files each produce a coverage violation", async () => {
    const sb = makeSandbox();
    try {
      // Every anchor file gets 10 lines, 1 covered → 10% coverage.
      // 10% is below every real threshold (min threshold is 90%), so
      // each matching enforced file will violate.
      const parts = ANCHOR_FILES.map((f) => lcovRecord(sb.root, f, 10, [1]));
      const lcov = parts.join("");
      await writeFixtures(sb.root, lcov, REAL_THRESHOLDS);
      const r = await runCheck(sb.root);

      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(
        `Coverage gate FAILED (${ANCHOR_FILES.length} file(s) below threshold)`,
      );
      // No file should fail for the "missing lcov data" reason — every
      // enforced threshold target is present and under-covered.
      expect(r.stderr).not.toContain("listed in thresholds but no lcov data");
      for (const f of ANCHOR_FILES) {
        expect(r.stderr).toContain(f);
      }
    } finally {
      sb.cleanup();
    }
  });
});
