/**
 * The Command Deck breadcrumb tail resolver — `$lib/breadcrumb-tail.svelte.ts`.
 *
 * This is the single mechanism that names the subject of a detail route in the
 * app shell strip, so these tests pin the priority order between its three
 * sources, the staleness rule, and the route table itself. The table is
 * asserted by value: adding a route to it is a claim that the param is fit to
 * show a user, and that claim deserves to be reviewed rather than inferred.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	PARAM_NAME_ROUTES,
	resolveBreadcrumbTail,
	setBreadcrumbTail,
} from "$lib/breadcrumb-tail.svelte.js";

// Own the page state rather than mutating the shared `$app/state` stub: the
// real SvelteKit types narrow `page.url.pathname` to a union of every route in
// the app, so assigning an arbitrary path to the stub type-checks under vitest
// and fails under `tsc`.
const { pageState } = vi.hoisted(() => ({ pageState: { url: { pathname: "/" } } }));
vi.mock("$app/state", () => ({ page: pageState }));

const AGENTS = "/(app)/agents/[name]";

/** Put the page on `pathname`, the way a navigation would. */
function at(pathname: string): void {
	pageState.url.pathname = pathname;
}

beforeEach(() => {
	// Module state outlives a test; withdraw whatever the previous one set.
	at("/reset");
	setBreadcrumbTail(null);
});

describe("PARAM_NAME_ROUTES", () => {
	it("lists exactly the routes whose param is already a human name", () => {
		expect(PARAM_NAME_ROUTES).toEqual({
			"/(app)/agents/[name]": "name",
			"/(app)/commands/[name]": "name",
			"/(app)/workflows/[name]": "name",
			"/(app)/workflows/[name]/edit": "name",
		});
	});

	it("keys on ids that include the layout group, as `page.route.id` reports them", () => {
		// A table keyed on `/agents/[name]` would never match and the tail
		// would silently vanish — no type error, no test failure elsewhere.
		for (const id of Object.keys(PARAM_NAME_ROUTES)) expect(id.startsWith("/(app)/")).toBe(true);
	});
});

describe("resolveBreadcrumbTail", () => {
	it("prefers a load-supplied tail over every fallback", () => {
		at("/agents/summarizer");
		setBreadcrumbTail("runtime name");
		const tail = resolveBreadcrumbTail(AGENTS, "/agents/summarizer", { name: "param name" }, "load name");
		expect(tail).toBe("load name");
	});

	it("prefers the runtime tail over the route param", () => {
		at("/agents/summarizer");
		setBreadcrumbTail("runtime name");
		expect(resolveBreadcrumbTail(AGENTS, "/agents/summarizer", { name: "param name" }, null)).toBe("runtime name");
	});

	it("reads the param when nothing else names the subject", () => {
		expect(resolveBreadcrumbTail(AGENTS, "/agents/summarizer", { name: "summarizer" }, null)).toBe("summarizer");
	});

	it("discards a runtime tail published for a different path", () => {
		// The marketplace fetch resolves after the user has already moved on;
		// the strip must not label the new page with the old subject.
		at("/marketplace/abc");
		setBreadcrumbTail("Old listing");
		expect(resolveBreadcrumbTail(AGENTS, "/agents/summarizer", { name: "summarizer" }, null)).toBe("summarizer");
	});

	it("withdraws the runtime tail when passed null", () => {
		at("/marketplace/abc");
		setBreadcrumbTail("Listing");
		expect(resolveBreadcrumbTail(null, "/marketplace/abc", {}, null)).toBe("Listing");
		setBreadcrumbTail(null);
		expect(resolveBreadcrumbTail(null, "/marketplace/abc", {}, null)).toBeNull();
	});

	it("withdraws the runtime tail when the page has no name yet", () => {
		// Every call site passes an optional chain (`listing?.name`), so the
		// pre-fetch value is `undefined`, not `null`.
		at("/marketplace/abc");
		setBreadcrumbTail("Listing");
		setBreadcrumbTail(undefined);
		expect(resolveBreadcrumbTail(null, "/marketplace/abc", {}, null)).toBeNull();
	});

	it("returns null for a route that names no subject", () => {
		expect(resolveBreadcrumbTail("/(app)/runs/[id]", "/runs/4f8c", { id: "4f8c" }, null)).toBeNull();
	});

	it("returns null when the route id is unknown", () => {
		expect(resolveBreadcrumbTail(null, "/agents/summarizer", { name: "summarizer" }, null)).toBeNull();
		expect(resolveBreadcrumbTail(undefined, "/agents/summarizer", { name: "summarizer" }, null)).toBeNull();
	});

	it("treats empty strings as absent rather than rendering a bare separator", () => {
		expect(resolveBreadcrumbTail(AGENTS, "/agents/", { name: "" }, "")).toBeNull();
		expect(resolveBreadcrumbTail(AGENTS, "/agents/", {}, undefined)).toBeNull();
	});

	it("passes the param through undecoded, because SvelteKit already decoded it", () => {
		// Decoding again double-decodes: `a%20b` would read back as `a b`, and
		// a name that is not valid percent escaping would throw `URIError` and
		// 500 the page. This is the behaviour the deleted per-route load
		// carried; it lives here now.
		expect(resolveBreadcrumbTail(AGENTS, "/agents/x", { name: "a%20b" }, null)).toBe("a%20b");
		expect(resolveBreadcrumbTail(AGENTS, "/agents/x", { name: "50% off" }, null)).toBe("50% off");
		expect(resolveBreadcrumbTail(AGENTS, "/agents/x", { name: "nightly report writer" }, null)).toBe("nightly report writer");
	});

	it("ignores writes outside the browser, so no SSR request can leak its subject", async () => {
		// Module state is per-process on the server and shared by every
		// concurrent request. Effects never run during SSR, so this guard is
		// what keeps that safety structural rather than incidental.
		vi.resetModules();
		vi.doMock("$app/environment", () => ({ browser: false, dev: false, building: false, version: "test" }));
		const mod = await import("$lib/breadcrumb-tail.svelte.js");
		at("/marketplace/abc");
		mod.setBreadcrumbTail("Another user's listing");
		expect(mod.resolveBreadcrumbTail(null, "/marketplace/abc", {}, null)).toBeNull();
		vi.doUnmock("$app/environment");
		vi.resetModules();
	});
});
