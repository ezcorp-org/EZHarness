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

describe("renderExtensionPage — ?step= sub-variant", () => {
	test("step threads into the scope alongside run (perProject → listProjects)", async () => {
		const { deps, scopes } = makeDeps();
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_a", "review");
		expect(scopes[0]).toEqual({ listProjects: true, run: "run_a", step: "review" });
	});

	test("step rides alongside project + run when all present", async () => {
		const { deps, scopes } = makeDeps();
		const project = { id: "p1", name: "P", path: "/p" };
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, project, "run_a", "test");
		expect(scopes[0]).toEqual({ project, run: "run_a", step: "test" });
	});

	test("a stray step WITHOUT run is DROPPED (step is meaningless without run)", async () => {
		const perProj = makeDeps();
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", perProj.deps, undefined, undefined, "review");
		expect(perProj.scopes[0]).toEqual({ listProjects: true }); // no step

		const nonPerProj = makeDeps({ perProject: false });
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", nonPerProj.deps, undefined, undefined, "review");
		expect(nonPerProj.scopes[0]).toBeUndefined(); // no run, no step → no scope
	});

	test("the step detail is a DISTINCT cache variant; the bare run key stays byte-identical", async () => {
		const { deps, scopes } = makeDeps();
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_a"); // run detail
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_a"); // cache HIT (run key unchanged)
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_a", "review"); // step detail — MISS
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_a", "review"); // step cache HIT
		// run_a pulled once (2nd from cache), run_a+review pulled once = 2 pulls.
		expect(scopes.filter(Boolean)).toHaveLength(2);
		expect(scopes[0]).toEqual({ listProjects: true, run: "run_a" });
		expect(scopes[1]).toEqual({ listProjects: true, run: "run_a", step: "review" });
	});

	test("distinct steps of the same run are distinct cache variants", async () => {
		const { deps, scopes } = makeDeps();
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_a", "review");
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_a", "test");
		expect(scopes.filter(Boolean)).toHaveLength(2);
		expect(scopes[1]).toEqual({ listProjects: true, run: "run_a", step: "test" });
	});

	test("a step detail routes on a NON-perProject page too", async () => {
		const { deps, scopes } = makeDeps({ perProject: false });
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_x", "lint");
		expect(scopes[0]).toEqual({ run: "run_x", step: "lint" });
	});
});

describe("renderExtensionPage — ?view= variant", () => {
	test("view threads into the scope on its own (perProject → listProjects, no run)", async () => {
		const { deps, scopes } = makeDeps();
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, undefined, undefined, "config");
		// view is INDEPENDENT of run — folded in even with no run.
		expect(scopes[0]).toEqual({ listProjects: true, view: "config" });
	});

	test("view rides alongside a single project (no run)", async () => {
		const { deps, scopes } = makeDeps();
		const project = { id: "p1", name: "P", path: "/p" };
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, project, undefined, undefined, "audit");
		expect(scopes[0]).toEqual({ project, view: "audit" });
	});

	test("view folds in on a NON-perProject page with no run (bare view scope)", async () => {
		const { deps, scopes } = makeDeps({ perProject: false });
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, undefined, undefined, "config");
		expect(scopes[0]).toEqual({ view: "config" });
	});

	test("view rides ALONGSIDE run + step when all present", async () => {
		const { deps, scopes } = makeDeps();
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_a", "review", "config");
		expect(scopes[0]).toEqual({ listProjects: true, run: "run_a", step: "review", view: "config" });
	});

	test("a view render is a DISTINCT cache variant; the bare (no-view) key stays byte-identical", async () => {
		const { deps, scopes } = makeDeps();
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps); // dashboard (listProjects), no view
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps); // cache HIT (bare key unchanged)
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, undefined, undefined, "config"); // view — MISS
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, undefined, undefined, "config"); // view cache HIT
		// dashboard pulled once (2nd from cache), config pulled once = 2 pulls.
		expect(scopes.filter(Boolean)).toHaveLength(2);
		expect(scopes[0]).toEqual({ listProjects: true });
		expect(scopes[1]).toEqual({ listProjects: true, view: "config" });
	});

	test("distinct views (config vs audit) are distinct cache variants", async () => {
		const { deps, scopes } = makeDeps();
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, undefined, undefined, "config");
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, undefined, undefined, "audit");
		expect(scopes.filter(Boolean)).toHaveLength(2);
		expect(scopes[1]).toEqual({ listProjects: true, view: "audit" });
	});

	test("a run detail and a view of that run cache SEPARATELY (view suffix isolates)", async () => {
		const { deps, scopes } = makeDeps();
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_a"); // run detail
		await renderExtensionPage("ez-code-factory", "dashboard", "u1", deps, undefined, "run_a", undefined, "config"); // run + view — MISS
		expect(scopes.filter(Boolean)).toHaveLength(2);
		expect(scopes[1]).toEqual({ listProjects: true, run: "run_a", view: "config" });
	});
});
