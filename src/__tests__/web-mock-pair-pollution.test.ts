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
 *  pair below, not a copy per pair. */
function runFilesInOneProcess(files: readonly string[]): PairRunResult {
  const proc = Bun.spawnSync([process.execPath, "test", ...files], {
    cwd: WEB_DIR,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`;
  const passMatch = output.match(/(\d+)\s+pass/);
  const failMatch = output.match(/(\d+)\s+fail/);
  return {
    exitCode: proc.exitCode ?? -1,
    pass: passMatch ? Number(passMatch[1]) : -1,
    fail: failMatch ? Number(failMatch[1]) : -1,
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
    label: "OPEN-1: extension-settings-api (polluter) then extensions-api (victim), $server/extensions/secret-settings",
    files: ["./src/__tests__/extension-settings-api.test.ts", "./src/__tests__/extensions-api.test.ts"],
    minPass: 90,
  },
  {
    label: "OPEN-2: import commit (polluter) then import preview (victim), $server/db/queries/projects",
    files: ["./src/routes/api/import/__tests__/commit.test.ts", "./src/routes/api/import/__tests__/preview.test.ts"],
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
