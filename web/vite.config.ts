import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const emptyNodeShim = fileURLToPath(
	new URL('./src/lib/empty-node-shim.ts', import.meta.url),
);

// The SvelteKit server hook is the first SSR module and reaches the backend
// graph that has timed out during cold starts. Start its transform with server
// startup and pre-transform its static import graph to reduce that race. Vite does
// not await the warmup before listening, so it can overlap with early requests.
// This is a mitigation only: Vite 8 does not expose a server-config transport
// timeout or retry for a rejected module-runner request, so a later transform
// timeout can still require an app restart.
const ssrWarmupFiles = ['./src/hooks.server.ts'];

export default defineConfig({
	// Browser coverage is an explicit build mode. Normal production builds keep
	// their current source-map policy; the collector refuses scripts without a
	// map instead of guessing original Svelte locations from generated code.
	build: {
		sourcemap: process.env.EZCORP_BROWSER_COVERAGE === '1',
	},
	plugins: [
		tailwindcss(),
		sveltekit(),
		visualizer({ emitFile: true, filename: 'stats.html' })
	],
	environments: {
		ssr: {
			dev: {
				// SSR defaults this to false. Without it, warmup transforms only the
				// hook entry and leaves its large backend graph for the first request.
				preTransformRequests: true,
			},
		},
	},
	server: {
		host: '0.0.0.0',
		allowedHosts: ['nixos-amd.taile1c5b0.ts.net'],
		warmup: {
			ssrFiles: ssrWarmupFiles,
		},
		watch: {
			// `.ezcorp/` is the runtime extension-data store (gitignored,
			// see AGENTS.md), not source. In the container it's a volume
			// mounted INSIDE the Vite root (`/app/web/.ezcorp`), so when an
			// extension persists files there — e.g. extension-author
			// host-materializing a draft's `tsconfig.json` — Vite's tsconfig
			// watcher (`reloadOnTsconfigChange`) force-reloads the dev
			// server mid-request, tearing down the backend DB singleton
			// (`getDb()` → "Database not initialized") and wedging the
			// active chat. Merged with Vite's built-in ignores (node_modules
			// /.git/…), so this only adds the data dir. Generalizes to every
			// extension that writes under `.ezcorp/extension-data`.
			ignored: ['**/.ezcorp/**'],
		},
	},
	ssr: {
		external: ['@electric-sql/pglite', '@electric-sql/pglite-pgvector', '@huggingface/transformers', 'onnxruntime-node']
	},
	resolve: {
		alias: [
			// `kokoro-js` statically imports Node's `path` and
			// `fs/promises` for its Node-only voices code path. Its
			// package.json declares `"browser": { "path": false,
			// "fs/promises": false }`, but Vite's optimizeDeps
			// pre-bundler doesn't honour the `browser` field for
			// transitive deps. Without these aliases, the dynamic
			// `import("kokoro-js")` (now inside the kokoro-tts worker
			// at `src/lib/workers/kokoro-tts-worker.ts`) fails to load
			// with "Failed to fetch dynamically imported module".
			//
			// Mapping both to an empty default export is safe — Kokoro
			// runtime-checks `if (i && Object.hasOwn(i, "readFile"))`
			// before touching either, falling back to fetching voices
			// from HuggingFace in the browser branch.
			//
			// These aliases apply to BOTH the main bundle and worker
			// bundles — Vite shares the resolver with worker contexts.
			{ find: /^path$/, replacement: emptyNodeShim },
			{ find: /^fs\/promises$/, replacement: emptyNodeShim },
		],
	},
	optimizeDeps: {
		// Pre-bundle kokoro-js so the worker's first dynamic
		// `import("kokoro-js")` doesn't trigger an on-demand
		// optimization round-trip — that round-trip is what produced
		// the cache-stale "?v=…" 404 in the previous (main-thread)
		// implementation. Vite's main optimizeDeps cache is reused by
		// worker bundles (the worker's `import` resolves to the same
		// pre-bundled artifact under `node_modules/.vite/deps/`).
		include: ['kokoro-js'],
		// transformers.js + onnxruntime-web ship binary WASM that Vite
		// can't statically analyze. Excluding it from pre-bundle lets
		// the package's own bundler-aware loader kick in.
		exclude: ['@huggingface/transformers'],
	},
	worker: {
		// Module workers (Vite emits the kokoro-tts worker via
		// `new Worker(new URL(...), { type: "module" })`). Vite 7's
		// `worker` block accepts only `format`, `plugins`, and
		// `rollupOptions` — dependency optimization is shared with the
		// main-bundle config above.
		format: 'es',
	},
});
