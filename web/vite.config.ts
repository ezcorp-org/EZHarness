import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const emptyNodeShim = fileURLToPath(
	new URL('./src/lib/empty-node-shim.ts', import.meta.url),
);

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		visualizer({ emitFile: true, filename: 'stats.html' })
	],
	server: {
		host: '0.0.0.0',
		allowedHosts: ['nixos-amd.taile1c5b0.ts.net'],
		watch: {
			// `.ezcorp/` is the runtime extension-data store (gitignored,
			// see CLAUDE.md), not source. In the container it's a volume
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
		external: ['@electric-sql/pglite', '@huggingface/transformers', 'onnxruntime-node']
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
