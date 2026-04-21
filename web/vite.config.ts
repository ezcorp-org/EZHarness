import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		visualizer({ emitFile: true, filename: 'stats.html' })
	],
	server: {
		host: '0.0.0.0',
		allowedHosts: ['nixos-amd.taile1c5b0.ts.net'],
	},
	ssr: {
		external: ['@electric-sql/pglite', '@huggingface/transformers', 'onnxruntime-node']
	}
});
