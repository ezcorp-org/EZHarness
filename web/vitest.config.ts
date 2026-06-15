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
	plugins: [svelte({ hot: false })],
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
	},
});
