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
			$app: resolve(__dirname, ".svelte-kit/runtime/app"),
			$server: resolve(__dirname, "../src"),
		},
	},
	test: {
		environment: "jsdom",
		include: ["src/**/*.component.test.{ts,svelte.ts}", "src/**/*.server.test.ts"],
		setupFiles: ["./src/__tests__/vitest-setup.ts"],
		globals: true,
	},
});
