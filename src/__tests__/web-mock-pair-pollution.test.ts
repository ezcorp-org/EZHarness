/**
 * Regression guard for a class of bug found three times on item C2 (W18
 * hygiene, validator-3 M2): two `web/` test files each register a raw,
 * partial `mock.module()` for the SAME `$server/*` (or `$lib/*`) alias.
 * `mock.module()` for a given specifier string only reliably takes hold the
 * FIRST time it is called in a process — a second registration for that same
 * string is silently ignored for a consumer that links after it. Run the two
 * files together in one `bun test` process (as the real web bun-leg pool
 * does) and whichever file loads SECOND gets the FIRST file's stale mock
 * instead of its own, in an order that depends only on file discovery order
 * — a source of flaky, hard-to-reproduce CI failures that never show up
 * running either file alone.
 *
 * Each pair below is fixed on this branch (see the cited commits' own
 * comments for the mechanism and the specific alias). This test does not
 * revert the fix and re-prove red — that is a one-time validation act, not
 * a thing every run should do. It exists so a FUTURE regression (a partial
 * mock re-introduced for one of these aliases) fails loudly here, in the
 * historically-broken order, instead of only showing up nondeterministically
 * in the full web pool depending on how files happen to get scheduled.
 */
import { test, expect } from "bun:test";
import { join } from "node:path";

const WEB_DIR = join(import.meta.dir, "../../web");

interface PairRunResult {
  exitCode: number;
  pass: number;
  fail: number;
  output: string;
}

/** Spawn `bun test <files...>` in one process, cwd'd to `web/` (web/ tests
 *  must run with that cwd — see web/CLAUDE.md). One shared helper for every
 *  pair below, not a copy per pair. An optional `testNamePattern` runs only
 *  matching tests (`bun test --test-name-pattern <regex>`) — module-level
 *  code (imports, top-level mock.module() calls, beforeAll) still runs in
 *  full either way, so the pollution mechanism this file exists to catch
 *  still applies; only WHICH already-registered tests execute narrows. */
function runFilesInOneProcess(files: readonly string[], testNamePattern?: string): PairRunResult {
  const args = testNamePattern ? [...files, "--test-name-pattern", testNamePattern] : [...files];
  const proc = Bun.spawnSync([process.execPath, "test", ...args], {
    cwd: WEB_DIR,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`;
  // The LAST matching line, not the first (validator-3 L-a): the output
  // also carries interleaved application JSON logs from the routes under
  // test, and a naive first-match search could in principle latch onto an
  // earlier false positive rather than bun's own final summary block.
  // Anchored to a line that is JUST "<N> pass"/"<N> fail" (bun's own
  // format, confirmed against captured runs: one leading space, digits,
  // the word, nothing else on the line) — a JSON log line can never match
  // this shape, so this is not merely "prefer the last one" but "only ever
  // consider bun's own summary lines at all."
  const passMatches = [...output.matchAll(/^\s*(\d+)\s+pass\s*$/gm)];
  const failMatches = [...output.matchAll(/^\s*(\d+)\s+fail\s*$/gm)];
  return {
    exitCode: proc.exitCode ?? -1,
    pass: passMatches.length > 0 ? Number(passMatches[passMatches.length - 1]![1]) : -1,
    fail: failMatches.length > 0 ? Number(failMatches[failMatches.length - 1]![1]) : -1,
    output,
  };
}

const PAIRS: ReadonlyArray<{
  label: string;
  /** [polluter, victim] — the file that registers the collision first, then
   *  the file whose route used to silently keep the stale/real value. */
  files: readonly [string, string];
  minPass: number;
}> = [
  {
    label: "OPEN-1 reverse order: extension-settings-api (polluter) then extensions-api (victim), $server/extensions/secret-settings",
    files: ["./src/__tests__/extension-settings-api.test.ts", "./src/__tests__/extensions-api.test.ts"],
    minPass: 90,
  },
  {
    label: "OPEN-2 forward: import commit (polluter) then import preview (victim), $server/db/queries/projects",
    files: ["./src/routes/api/import/__tests__/commit.test.ts", "./src/routes/api/import/__tests__/preview.test.ts"],
    minPass: 20,
  },
  {
    label: "OPEN-2 reverse order: import preview (polluter) then import commit (victim), $server/db/queries/projects",
    files: ["./src/routes/api/import/__tests__/preview.test.ts", "./src/routes/api/import/__tests__/commit.test.ts"],
    minPass: 20,
  },
  {
    label: "extension-browser-preview pair: import commit (polluter) then extension-browser-preview (victim), $server/auth/middleware",
    files: ["./src/routes/api/import/__tests__/commit.test.ts", "./src/__tests__/extension-browser-preview.test.ts"],
    minPass: 15,
  },
];

for (const pair of PAIRS) {
  test(pair.label, () => {
    const result = runFilesInOneProcess(pair.files);
    expect(result.fail).toBe(0);
    expect(result.pass).toBeGreaterThanOrEqual(pair.minPass);
    expect(result.exitCode).toBe(0);
  });
}

// OPEN-1, the RULED direction (validator-3 F-M2): extensions-api.test.ts
// THEN extension-settings-api.test.ts — the reverse of the case above,
// and the one the original finding actually names. Fixed in 7705cb1cf;
// red at 8275cccd4 (95 pass, 2 fail — exactly the two tests targeted
// below: a read-only API key's PUT/DELETE wrongly returned 200 instead of
// 403). A bare fail-count assertion (as used above) would also pass if
// these two tests were SKIPPED rather than genuinely exercised and
// passing, so this asserts BY NAME instead: --test-name-pattern isolates
// exactly these two tests (confirmed: "read-only key" matches nothing
// else in either file's actual test names — the only other occurrences of
// that phrase in either file are source comments, which bun's pattern
// matching does not see), and the pass count for that FILTERED run must
// be exactly 2, never merely "at least some number."
test("OPEN-1: extensions-api (polluter) then extension-settings-api (victim), $lib/server/security/api-keys — the two F1 scope tests by name", () => {
  const result = runFilesInOneProcess(
    ["./src/__tests__/extensions-api.test.ts", "./src/__tests__/extension-settings-api.test.ts"],
    "read-only key",
  );
  expect(result.fail).toBe(0);
  expect(result.pass).toBe(2);
  expect(result.exitCode).toBe(0);
});
