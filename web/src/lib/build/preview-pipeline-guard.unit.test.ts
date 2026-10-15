/**
 * The preview pipeline guard's logic under Node (W4F F1): the Node vitest leg is the only coverage producer for
 * web/src/lib, and the live proof (preview-pipeline-guard.test.ts, bun:test) runs the real vite preview under Bun,
 * where it cannot count. These cases drive the plugin's configurePreviewServer hook with a stand-in server.
 */
import { describe, expect, test } from "vitest";
import type { Plugin, PreviewServer } from "vite";
import { PIPELINE_REPLAY_DEFECT_BUNS, previewPipelineGuard } from "./preview-pipeline-guard";

type Middleware = (req: { headers: Record<string, string> }, res: unknown, next: () => void) => void;

/** Runs the plugin's preview hook against a stand-in server and returns the middleware it installed. */
function installed(plugin: Plugin): Middleware[] {
	const middlewares: Middleware[] = [];
	const server = { middlewares: { use: (fn: Middleware) => middlewares.push(fn) } } as unknown as PreviewServer;
	(plugin.configurePreviewServer as (server: PreviewServer) => void)(server);
	return middlewares;
}

describe("previewPipelineGuard", () => {
	test("covers exactly Bun 1.4.0, 1.4.1 and 1.4.2", () => {
		expect([...PIPELINE_REPLAY_DEFECT_BUNS]).toEqual(["1.4.0", "1.4.1", "1.4.2"]);
	});

	test("on an affected Bun it installs one middleware that drops Accept-Encoding and continues", () => {
		for (const version of PIPELINE_REPLAY_DEFECT_BUNS) {
			const [middleware, ...rest] = installed(previewPipelineGuard(version));
			expect(rest).toHaveLength(0);
			const req = { headers: { "accept-encoding": "gzip, br", host: "localhost" } as Record<string, string> };
			let calls = 0;
			middleware!(req, {}, () => { calls += 1; });
			expect(req.headers).toEqual({ host: "localhost" });
			expect(calls).toBe(1);
		}
	});

	test("on any other Bun, or under Node, it installs nothing", () => {
		for (const version of ["1.3.14", "1.4.3", ""]) expect(installed(previewPipelineGuard(version))).toHaveLength(0);
		// Under Node (this test's runtime) the default version is "" because process.versions.bun is absent.
		expect(process.versions.bun).toBeUndefined();
		expect(installed(previewPipelineGuard())).toHaveLength(0);
	});
});
