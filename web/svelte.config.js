import adapter from 'svelte-adapter-bun';
import { fileURLToPath } from 'node:url';

const bunAdapter = adapter();

const previewAdapter = {
	...bunAdapter,
	async adapt(builder) {
		await bunAdapter.adapt(builder);
		// Stryker loads this config from a web-only sandbox but never runs adapt().
		const { ensureBunWebSocketHook } = await import('../scripts/ensure-bun-websocket-hook.js');
		await ensureBunWebSocketHook(fileURLToPath(new URL('./build/server/', import.meta.url)));
	}
};

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: previewAdapter,
		alias: {
			$server: '../src'
		}
	}
};

export default config;
