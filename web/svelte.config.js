import adapter from 'svelte-adapter-bun';
import { fileURLToPath } from 'node:url';
import { ensureBunWebSocketHook } from '../scripts/ensure-bun-websocket-hook.js';

const bunAdapter = adapter();

const previewAdapter = {
	...bunAdapter,
	async adapt(builder) {
		await bunAdapter.adapt(builder);
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
