/**
 * Vitest config for MUTATION RUNS ONLY (scripts/mutation.ts → Stryker).
 * Never used by `bun run test:component` or the CI coverage leg — those keep
 * using vitest.config.ts, which this file derives from so the two cannot drift
 * on aliases, stubs or environment.
 *
 * It changes exactly two things: it drops `*.server.test.ts` from `include`,
 * and it points `$server` at the repository's src/ from inside the sandbox.
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
 *   - Stryker's vitest `related` filter stays ON (web/stryker.config.json sets
 *     nothing, and the runner's default is true). It cannot follow `$lib`-ALIASED
 *     imports, so files it misses report every mutant as NoCoverage — measured
 *     at 157 of 521 test files seen and a 66.04% score that was an artifact,
 *     not a quality signal. Turning it off is not affordable (one 99-mutant
 *     file took 18m51s with 93 timeouts), so scripts/mutation.ts instead FAILS
 *     LOUDLY on any file that comes back 100% NoCoverage. Read the
 *     `related` trap in web/stryker.config.json before changing either side.
 *
 * `$server` IN THE SANDBOX. The non-server tests import repository src/ too,
 * through `$lib` modules (model-selector-logic.ts reads
 * `$server/runtime/routing/default-selection`). Inside the sandbox "../src" is
 * web/.stryker-tmp/src, which does not exist, so such a test failed to load and
 * every mutant of its subject "survived" with no test run (W4H-33b:
 * send-message.ts, 21 mutants). The alias therefore names the real src/ next to
 * the real web/: it is never mutated, so reading it in place is safe.
 */
import { resolve } from "node:path";
import strykerOptions from "./stryker.config.json";
import base from "./vitest.config";

/** web/ itself: the folder above Stryker's temp folder when loaded from a sandbox. */
const sandboxMarker = `/${strykerOptions.tempDirName}/`;
const configDirectory = import.meta.dirname;
const webDirectory = configDirectory.includes(sandboxMarker)
	? configDirectory.slice(0, configDirectory.indexOf(sandboxMarker))
	: configDirectory;

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

export default {
	...base,
	resolve: { ...base.resolve, alias: { ...base.resolve?.alias, $server: resolve(webDirectory, "../src") } },
	test: { ...baseTest, include },
};
