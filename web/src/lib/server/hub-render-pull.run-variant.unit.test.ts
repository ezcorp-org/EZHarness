// Focused coverage for the `?run=<id>` render-detail variant threading through
// `renderExtensionPage` (R5 integration: "hub-render-pull variant handling").
// The production collaborators (findPage / callPage / cache) are injectable, so
// this drives the run-scope + cache-keying branches without a real subprocess.
import { describe, test, expect } from "vitest";
import {
	renderExtensionPage,
	type PageRenderScope,
	type RenderPullDeps,
} from "./hub-render-pull";
import { ExtensionPageCache } from "$server/extensions/page-cache";
import type { Extension } from "$server/db/schema";

const EXT = {
	id: "ext-1",
	name: "ez-code-factory",
	grantedPermissions: { eventSubscriptions: [] },
} as unknown as Extension;

/** A render-pull deps bundle that records the scope every callPage sees and
 *  counts subprocess calls, over a REAL page cache (so variant keying is
 *  exercised end-to-end). `perProject` defaults true (the ECF page). */
function makeDeps(over: { perProject?: boolean } = {}) {
	const scopes: Array<PageRenderScope | undefined> = [];
	const cache = new ExtensionPageCache();
	const deps: Partial<RenderPullDeps> = {
		findPage: async () => ({
			extension: EXT,
			page: { id: "dashboard", title: "ez-code-factory", perProject: over.perProject ?? true },
		}),
		callPage: async (_ext, _pageId, _userId, scope) => {
			scopes.push(scope);
			return { jsonrpc: "2.0" as const, id: 1, result: { title: "T", nodes: [] } };
		},
		cache,
		timeoutMs: 1000,
	};
	return { deps, scopes };
}

describe("renderExtensionPage — ?run= variant", () => {
	test("a run request threads `run` into the render scope alongside listProjects", async () => {
		const { deps, scopes } = makeDeps();
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_abc");
		expect(scopes[0]).toEqual({ listProjects: true, run: "run_abc" });
	});

	test("run rides ALONGSIDE project context when both are present", async () => {
		const { deps, scopes } = makeDeps();
		const project = { id: "p1", name: "P", path: "/p" };
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, project, "run_abc");
		expect(scopes[0]).toEqual({ project, run: "run_abc" });
	});

	test("run details cache by run id ALONE — same run served from cache, different run misses", async () => {
		const { deps, scopes } = makeDeps();
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_a");
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_a"); // cache hit
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_b"); // miss
		// run_a pulled once (second served from cache), run_b once.
		expect(scopes.filter(Boolean)).toHaveLength(2);
		expect(scopes[0]).toEqual({ listProjects: true, run: "run_a" });
		expect(scopes[1]).toEqual({ listProjects: true, run: "run_b" });
	});

	test("the run detail is a DISTINCT cache variant from the dashboard", async () => {
		const { deps, scopes } = makeDeps();
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps); // dashboard (listProjects)
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_a"); // detail
		// Two separate pulls — the run detail did not collide with the dashboard's cache slot.
		expect(scopes).toHaveLength(2);
		expect(scopes[0]).toEqual({ listProjects: true });
		expect(scopes[1]).toEqual({ listProjects: true, run: "run_a" });
	});

	test("a run request routes a detail render even on a NON-perProject page", async () => {
		const { deps, scopes } = makeDeps({ perProject: false });
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_x");
		expect(scopes[0]).toEqual({ run: "run_x" });
	});
});
