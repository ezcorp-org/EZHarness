/**
 * Vitest config for MUTATION RUNS ONLY (scripts/mutation.ts → Stryker).
 * Never used by `bun run test:component` or the CI coverage leg — those keep
 * using vitest.config.ts, which this file derives from so the two cannot drift
 * on aliases, stubs or environment.
 *
 * It changes exactly one thing: it drops `*.server.test.ts` from `include`.
 *
 * WHY. Stryker runs the suite inside a sandbox under web/.stryker-tmp/, seeded
 * from git. vitest.config.ts aliases `$server` to `resolve(__dirname, "../src")` —
 * the REPO-ROOT src/ tree, which lives outside web/ and is therefore never
 * copied into the sandbox. All 234 `*.server.test.ts` files import through that
 * alias, so inside the sandbox every one of them dies with
 * `Failed to resolve import "$server/..."`, and Stryker aborts the entire run
 * on a failed initial test run. Measured: that is exactly how the first
 * full-suite attempt died.
 *
 * This pairs with two other settings, and all three are needed together:
 *   - `mutation.mutateGlobs` excludes `src/lib/server/**` (scripts/quality-gates.json),
 *     so nothing we mutate depends on the tests dropped here.
 *   - `vitest.related: false` (web/stryker.config.json). Stryker's vitest
 *     runner defaults to vitest's `--related` module-graph filter, which cannot
 *     follow `$lib`-ALIASED imports. With it on, only 157 of 521 test files ran
 *     and 1804 mutants reported NoCoverage for code whose tests exist and pass
 *     — a measured 66.04% score that was an artifact, not a quality signal.
 *     Turning it off means the dry run executes the whole (non-server) suite:
 *     slower to start, but the only way the score means anything.
 */
import base from "./vitest.config";

const baseTest = base.test ?? {};
const baseInclude = baseTest.include ?? [];

// Drop the server-test glob(s) and the explicitly-listed server suites. Matching
// on the basename convention rather than a hand-copied list keeps this correct
// when vitest.config.ts's include list grows.
const include = baseInclude.filter((pattern) => !pattern.includes(".server.test"));

if (include.length === baseInclude.length) {
  // Fail loudly rather than silently mutate against a suite that will abort:
  // if the naming convention changes, this filter stops doing anything and the
  // sandbox failure comes back as an inscrutable resolve error.
  throw new Error(
    "vitest.stryker.config.ts removed nothing from `include` — the " +
      "`*.server.test.ts` convention changed. Update this filter before running Stryker.",
  );
}

export default { ...base, test: { ...baseTest, include } };
