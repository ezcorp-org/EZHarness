import type { Plugin } from 'vite';

/**
 * Bun releases whose node:http server dies on a pipelined request behind vite preview's compression
 * (oven-sh/bun#40350, a 1.4.0 regression). Bun queues a pipelined response behind the one in flight and,
 * when that one finishes, replays the queued response's buffered writes through the public `res.write` /
 * `res.end`. vite preview's compression middleware (@polka/compression) patches those two to feed a gzip
 * stream that has already ended, so the replay throws an uncaught ERR_STREAM_WRITE_AFTER_END and the
 * process exits. The fix (oven-sh/bun#43557) merged after 1.4.2 and is in no release yet.
 * preview-pipeline-guard.test.ts fails when the pinned Bun's behaviour and this list disagree.
 */
export const PIPELINE_REPLAY_DEFECT_BUNS: ReadonlySet<string> = new Set(['1.4.0', '1.4.1', '1.4.2']);

/**
 * On an affected Bun, drop Accept-Encoding before vite's compression middleware sees the request, so it
 * leaves `res.write` / `res.end` unpatched and a replayed pipelined response cannot reach an ended gzip
 * stream. It serves only `vite preview` (the Playwright web server); the product server never runs vite.
 * Vite runs a plugin's configurePreviewServer body before it installs compression, so this middleware
 * is first. Elsewhere (Node, where the version is '', or another Bun release) the plugin does nothing.
 */
export function previewPipelineGuard(bunVersion: string = process.versions.bun ?? ''): Plugin {
	return {
		name: 'ezcorp-preview-pipeline-guard',
		configurePreviewServer(server) {
			if (!PIPELINE_REPLAY_DEFECT_BUNS.has(bunVersion)) return;
			server.middlewares.use((req, _res, next) => {
				delete req.headers['accept-encoding'];
				next();
			});
		},
	};
}
