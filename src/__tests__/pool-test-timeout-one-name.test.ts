/**
 * The backend pool's per-test budget has one definition, EZ_POOL_TEST_TIMEOUT_MS in scripts/lib/watchdog.sh, and every
 * runner, workflow step, test and comment that passes it uses that name. A literal copy of the number can drift from the
 * pool: the W4G-14 pair child once ran under bun's 5 s default while the pool ran at 30 s.
 *
 * Not scanned: docs/, tasks/ and *.md (records and prose), and scripts/fixtures/ (frozen snapshots of earlier files that
 * parser tests read). A different budget, such as a 300 s lane, is not this name and is not matched.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { POOL_TEST_TIMEOUT_MS } from "./helpers/pool-test-timeout";

const REPO_ROOT = join(import.meta.dir, "../..");
const NOT_SCANNED = [":!docs/", ":!tasks/", ":!*.md", ":!scripts/fixtures/"];

function gitGrep(pattern: string): string[] {
  const proc = Bun.spawnSync(["git", "grep", "-n", "-E", "-e", pattern, "--", ".", ...NOT_SCANNED], { cwd: REPO_ROOT });
  // git grep exits 1 when nothing matches; anything else is an error, not an empty result.
  if (proc.exitCode !== 0 && proc.exitCode !== 1) throw new Error(`git grep failed: ${proc.stderr.toString()}`);
  return proc.stdout.toString().split("\n").filter(Boolean);
}

test("the pool budget is defined once, in scripts/lib/watchdog.sh", () => {
  const definitions = gitGrep("^[[:space:]]*(export[[:space:]]+)?EZ_POOL_TEST_TIMEOUT_MS=");
  expect(definitions.map((line) => line.split(":")[0])).toEqual(["scripts/lib/watchdog.sh"]);
  // A second shell name for the same budget (scripts/test-coverage.sh had TEST_TIMEOUT_MS=30000) takes it from this one.
  const otherNumbers = gitGrep(`^[[:space:]]*(export[[:space:]]+)?[A-Z_]*TEST_TIMEOUT_MS=["']?${POOL_TEST_TIMEOUT_MS}([^0-9]|$)`);
  expect(otherNumbers.map((line) => line.split(":")[0])).toEqual(["scripts/lib/watchdog.sh"]);
});

test("no file passes the pool budget as a literal number", () => {
  // Built from the defined value, so this file holds no copy of the number. bun spells the flag `--timeout N` or
  // `--timeout=N`; vitest spells it `--testTimeout=N`.
  const literal = gitGrep(`--(timeout|testTimeout)[ =]["']?${POOL_TEST_TIMEOUT_MS}([^0-9]|$)`);
  expect(literal).toEqual([]);
});
