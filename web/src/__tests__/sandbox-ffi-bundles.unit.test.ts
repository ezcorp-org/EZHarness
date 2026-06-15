/**
 * Regression pin for the `bun:ffi` bundling break.
 *
 * The Landlock sandbox work introduced `src/extensions/sandbox/landlock-ffi.ts`,
 * which statically imports the `bun:ffi` builtin. That module is on the
 * transitive import graph of every `*.server.test.ts` (route handler →
 * `src/extensions/subprocess` → `sandbox/capability-probe` → `landlock-ffi`).
 * Under vitest's jsdom environment Vite first tried to BUNDLE the Bun builtin
 * (hard error) and then, once externalized, Node couldn't resolve it — taking
 * out 12 server-test files at LOAD time with a cryptic error.
 *
 * The fix aliases `bun:ffi` to a stub in `vitest.config.ts`. This test imports
 * the chain directly so a future re-break (e.g. a new `bun:` builtin reachable
 * from the sandbox, or the alias being dropped) fails ONE fast, obvious test
 * instead of 12 mysterious load errors.
 */

import { expect, test } from "vitest";

test("the sandbox landlock-ffi chain loads under vitest (bun:ffi is stubbed)", async () => {
	// Direct import of the module that pulls in `bun:ffi`. If the alias/stub
	// regresses, the dynamic import rejects here with the bundling/resolve
	// error rather than silently breaking unrelated suites.
	const mod = await import("$server/extensions/sandbox/landlock-ffi");
	// Sanity: the pure exports are present (proves the module body evaluated,
	// not just that the import didn't throw).
	expect(typeof mod.landlockAbiVersion).toBe("function");
	expect(typeof mod.applyReadWriteJail).toBe("function");
});

test("the capability-probe (transitive bun:ffi importer) loads", async () => {
	const mod = await import("$server/extensions/sandbox/capability-probe");
	expect(mod).toBeTruthy();
});
