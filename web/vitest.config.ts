/**
 * Svelte 5 component DOM tests. Kept SEPARATE from `bun test` so vitest
 * only loads `*.component.test.ts` files — existing `*.test.ts` logic
 * suites continue to run under `bun test` with no change.
 *
 * Why a second runner: Svelte 5's `.svelte` + `.svelte.ts` (rune) files
 * need the Svelte compiler + TypeScript rune transform at import time,
 * which bun doesn't ship out of the box. `@sveltejs/vite-plugin-svelte`
 * handles both, so vitest (Vite-based) is the supported stack.
 */

import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "node:path";

export default defineConfig({
	// No `hot` option here: vite-plugin-svelte 7 removed it, and passing it
	// logs `invalid plugin option \`hot\` in inline config` on every run.
	// HMR is a dev-server concern and vitest never starts one, so `hot:
	// false` was already inert — dropping it keeps the run warning-free.
	plugins: [svelte()],
	resolve: {
		conditions: ["browser"],
		alias: {
			$lib: resolve(__dirname, "src/lib"),
			// `.svelte-kit/runtime/app` only exists after a SvelteKit build —
			// vitest can't depend on it. Map the `$app/*` subpaths to local
			// no-op stubs; any test asserting specific behaviour `vi.mock`s
			// the same path on top.
			"$app/navigation": resolve(__dirname, "src/__tests__/stubs/app-navigation.ts"),
			"$app/state": resolve(__dirname, "src/__tests__/stubs/app-state.ts"),
			"$app/stores": resolve(__dirname, "src/__tests__/stubs/app-stores.ts"),
			"$app/environment": resolve(__dirname, "src/__tests__/stubs/app-environment.ts"),
			$app: resolve(__dirname, ".svelte-kit/runtime/app"),
			$server: resolve(__dirname, "../src"),
			// The server-context import chain transitively imports `bun:ffi`
			// (sandbox/landlock-ffi.ts). Under vitest's jsdom env that Bun
			// builtin can be neither bundled nor resolved on Node, breaking
			// every `*.server.test.ts` at LOAD time. Alias it to a stub that
			// satisfies module-eval (FFIType members) and throws if its FFI
			// functions are ever actually called — they never are in these
			// tests; real Landlock runs only in the Bun runtime shim. Keeps the
			// sandbox security code untouched.
			"bun:ffi": resolve(__dirname, "src/__tests__/stubs/bun-ffi.ts"),
			// `$service-worker` is a SvelteKit virtual module only resolvable
			// after a build. The `service-worker.shell.unit.test.ts` imports the
			// real SW shell to line-cover it, so map the module to a static stub
			// that satisfies its `{ version, build, files }` import. Same spirit
			// as the `$app/*` stubs above.
			"$service-worker": resolve(__dirname, "src/__tests__/stubs/service-worker.ts"),
		},
	},
	test: {
		environment: "jsdom",
		include: [
			"src/**/*.component.test.{ts,svelte.ts}",
			"src/**/*.server.test.ts",
			// Pure-utility unit tests for code that lives under `src/lib/`
			// (no DOM, no server handlers). Phase 4 added the first one
			// (`relative-time.unit.test.ts`); the suffix keeps the runner
			// boundary explicit so a stray `*.test.ts` in a subdir doesn't
			// silently get picked up.
			"src/**/*.unit.test.ts",
			// Phase 56 (per-capability TTL UI) Wave 0 RED scaffold for
			// `formatTtl` — uses bun-test-compatible API subset (no
			// `vi.mock`/`vi.importActual`), so it doesn't need the
			// `.server.` suffix to escape the bun-test pool. Listed
			// explicitly because the plan's `<files_modified>` contract
			// pins this basename and Wave 1+ `<automated>` blocks reference
			// it. The companion `extensions-reapprove-route.server.test.ts`
			// and `sticky-last-ttl-pick.server.test.ts` use `vi.*` and live
			// under the `*.server.test.ts` glob above instead.
			"src/__tests__/relative-time.test.ts",
			// The send-message suite moved from the bun leg to vitest so its
			// coverage finally counts: per scripts/test-coverage.sh the Node-run
			// vitest leg is the ONLY coverage producer for `web/src/lib/**`, so
			// on the bun leg these ~60 tests measured `send-message.ts` (1069
			// lines of the chat send path) at 0%. Listed explicitly rather than
			// renamed to a `.unit.` suffix: the basename is load-bearing (a
			// rename trips the `Gate integrity` test-rename check, which exists
			// precisely because renames can silently de-gate pattern-matched
			// test sets). Registering it here AND subtracting it from
			// `web_bunleg_files()` keeps it in exactly one runner, explicitly —
			// same mechanism relative-time.test.ts uses above.
			"src/lib/chat/page-handlers/__tests__/send-message.test.ts",
			// Same reason as send-message above: the vitest leg is the ONLY
			// coverage producer for `web/src/lib/**`, and this suite is what
			// covers `context-usage-logic.ts` (the context-indicator maths —
			// served-model denominator, cache-inclusive numerator, budget vs
			// window). On the bun leg its ~100 tests produced NO lcov at all,
			// so the patch-coverage gate saw the file as unmeasured. Listed
			// explicitly rather than renamed to `.unit.` for the same reason:
			// the `Gate integrity` test-rename check treats a rename as a
			// potential silent de-gating. Registered here AND subtracted from
			// `web_bunleg_files()`, so it runs in exactly one runner.
			"src/__tests__/context-usage-logic.test.ts",
			// Same arrangement, same reason (issue #142): the vitest leg is the
			// only coverage producer for `web/src/lib/**`, and these three
			// suites are what cover `format-map.ts` and the
			// `inline-tool-store.svelte.ts` rune module. Under bun the two
			// store suites could not load a `.svelte.ts` at all, so each drove
			// a hand-maintained re-implementation instead of the shipped code;
			// they now import the real store. Basenames kept (no rename) for
			// the `Gate integrity` test-rename check, and each is subtracted
			// from `web_bunleg_files()` so it runs in exactly one runner.
			"src/__tests__/format-map.test.ts",
			"src/__tests__/inline-tool-store.test.ts",
			"src/__tests__/inline-tool-store-upsert.test.ts",
		],
		setupFiles: ["./src/__tests__/vitest-setup.ts"],
		globals: true,
		// Force inline-transform Zod so the CJS `exports.z = z` assignment
		// runs before the test reads `z`. Without this, vitest's CJS-ESM
		// interop snapshots the exports object too early and `z` resolves
		// to undefined — breaking every server test that imports from
		// `$lib/server/security/validation`.
		server: {
			deps: {
				inline: ["zod"],
			},
		},
		coverage: {
			// A single failing test must NOT erase the whole coverage report.
			// Vitest defaults `coverage.reportOnFailure` to false and writes no
			// reporter output at all once any test fails, so ONE timed-out test
			// left `lcov.info` unwritten entirely. scripts/test-coverage.sh
			// globs `$TMPDIR/cov_*/lcov.info` into the merge, so a missing file
			// is silently skipped rather than raised: the merge then lost all
			// 173 files this leg measures (146 of which no other leg produces),
			// and the gate reported 126 enforced files as "listed in thresholds
			// but no lcov data" — measured by replaying check-coverage.ts on a
			// merge with this leg's records removed. That buried the one real
			// failure under 126 phantom ones. Reporting on failure cannot turn
			// red into green: the leg's exit code (VITEST_EXIT) still gates
			// independently in test-coverage.sh, and coverage measured during a
			// failed run is never higher than a clean one. Inert outside the
			// coverage leg — nothing else runs vitest with --coverage.
			reportOnFailure: true,
		},
	},
});
