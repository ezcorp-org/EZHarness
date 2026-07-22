/**
 * Extension Pages Hub — pure-logic unit tests for $lib/hub.
 */
import { describe, test, expect } from "vitest";
import {
	parseHubPageId,
	buildActionRequest,
	isSafeInternalHref,
	sortHubPagesByTitle,
	type HubPageListing,
	type ParsedHubPageId,
	type PageAction,
	type PagePrompt,
} from "./hub";

describe("parseHubPageId", () => {
	test("parses core ids", () => {
		expect(parseHubPageId("core:briefing")).toEqual({ kind: "core", providerId: "briefing" });
		expect(parseHubPageId("core:a1-b2")).toEqual({ kind: "core", providerId: "a1-b2" });
	});

	test("parses ext ids", () => {
		expect(parseHubPageId("ext:cron-dashboard:dashboard")).toEqual({
			kind: "ext",
			extension: "cron-dashboard",
			pageId: "dashboard",
		});
		expect(parseHubPageId("ext:my_ext.v2:page-1")).toEqual({
			kind: "ext",
			extension: "my_ext.v2",
			pageId: "page-1",
		});
	});

	test("rejects malformed ids", () => {
		for (const bad of [
			"",
			"briefing",
			"core:",
			"core:UPPER",
			"core:has space",
			"core:briefing:extra",
			"ext:only-two",
			"ext::page",
			"ext:name:",
			"ext:name:PAGE",
			"ext:..:page",
			"other:briefing",
			`core:${"x".repeat(40)}`,
			`ext:${"x".repeat(70)}:p`,
			"x".repeat(200),
		]) {
			expect(parseHubPageId(bad)).toBeNull();
		}
	});

	test("rejects non-string input defensively", () => {
		expect(parseHubPageId(undefined as unknown as string)).toBeNull();
		expect(parseHubPageId(42 as unknown as string)).toBeNull();
	});
});

describe("buildActionRequest", () => {
	const core: ParsedHubPageId = { kind: "core", providerId: "briefing" };
	const ext: ParsedHubPageId = { kind: "ext", extension: "cron-dashboard", pageId: "dashboard" };

	test("core actions route to the hub actions endpoint", () => {
		expect(buildActionRequest(core, { event: "run-now" })).toEqual({
			url: "/api/hub/pages/core%3Abriefing/actions/run-now",
			body: {},
		});
	});

	test("core actions carry the payload when present", () => {
		expect(buildActionRequest(core, { event: "run-now", payload: { a: 1 } })).toEqual({
			url: "/api/hub/pages/core%3Abriefing/actions/run-now",
			body: { payload: { a: 1 } },
		});
	});

	test("core actions with non-slug events are refused", () => {
		expect(buildActionRequest(core, { event: "Run Now" })).toBeNull();
		expect(buildActionRequest(core, { event: "ns:run" })).toBeNull();
	});

	test("ext actions route to the extension events endpoint with hub source", () => {
		expect(
			buildActionRequest(ext, { event: "cron-dashboard:clear-log", payload: { all: true } }),
		).toEqual({
			url: "/api/extensions/cron-dashboard/events/clear-log",
			body: { source: "hub", pageId: "dashboard", payload: { all: true } },
		});
	});

	test("ext actions omit payload key when absent", () => {
		expect(buildActionRequest(ext, { event: "cron-dashboard:clear-log" })).toEqual({
			url: "/api/extensions/cron-dashboard/events/clear-log",
			body: { source: "hub", pageId: "dashboard" },
		});
	});

	test("ext actions must be namespaced to the page's extension", () => {
		expect(buildActionRequest(ext, { event: "other-ext:clear-log" })).toBeNull();
		expect(buildActionRequest(ext, { event: "clear-log" })).toBeNull();
		expect(buildActionRequest(ext, { event: "cron-dashboard:" })).toBeNull();
		expect(buildActionRequest(ext, { event: "cron-dashboard:a:b" })).toBeNull();
	});
});

describe("PagePrompt mirror + prompt-value payload path", () => {
	const core: ParsedHubPageId = { kind: "core", providerId: "briefing" };
	const ext: ParsedHubPageId = { kind: "ext", extension: "cron-dashboard", pageId: "dashboard" };

	test("PagePrompt mirror has the page-schema shape (label required, rest optional)", () => {
		// Compile-time shape pin: a full + a minimal prompt both type-check.
		const full: PagePrompt = {
			label: "Topic to watch",
			placeholder: "e.g. Bun 2.0",
			field: "topic",
			maxLength: 120,
			submitLabel: "Add",
		};
		const minimal: PagePrompt = { label: "Topic" };
		expect(full.field).toBe("topic");
		expect(minimal.placeholder).toBeUndefined();
	});

	test("a prompt-bearing CORE action dispatches with the merged payload.topic", () => {
		// The page route merges the typed value into payload[field] BEFORE
		// buildActionRequest, so the prompt value rides the standard payload
		// path — buildActionRequest carries it verbatim.
		const merged: PageAction = {
			event: "add-watchlist",
			prompt: { label: "Topic to watch", field: "topic" },
			payload: { topic: "Bun 2.0 release" },
		};
		expect(buildActionRequest(core, merged)).toEqual({
			url: "/api/hub/pages/core%3Abriefing/actions/add-watchlist",
			body: { payload: { topic: "Bun 2.0 release" } },
		});
	});

	test("a prompt-bearing EXT action rides the same hub-source payload path", () => {
		const merged: PageAction = {
			event: "cron-dashboard:rename",
			prompt: { label: "New name", field: "name" },
			payload: { name: "Nightly" },
		};
		expect(buildActionRequest(ext, merged)).toEqual({
			url: "/api/extensions/cron-dashboard/events/rename",
			body: { source: "hub", pageId: "dashboard", payload: { name: "Nightly" } },
		});
	});
});

describe("sortHubPagesByTitle", () => {
	function listing(id: string, title: string, kind: "core" | "ext" = "ext"): HubPageListing {
		return { id, title, kind };
	}

	test("orders pages alphabetically by title", () => {
		const sorted = sortHubPagesByTitle([
			listing("core:zebra", "Zebra"),
			listing("core:apple", "Apple"),
			listing("ext:x:mango", "Mango"),
		]);
		expect(sorted.map((p) => p.title)).toEqual(["Apple", "Mango", "Zebra"]);
	});

	test("is case-insensitive (base sensitivity)", () => {
		const sorted = sortHubPagesByTitle([
			listing("core:b", "banana"),
			listing("core:a", "Apple"),
		]);
		expect(sorted.map((p) => p.title)).toEqual(["Apple", "banana"]);
	});

	test("breaks ties on the page id when titles match (case-insensitively)", () => {
		// Equal-by-title entries fall through to the stable id comparator, so a
		// listing with two "Dashboard" tabs always renders in a deterministic order.
		const sorted = sortHubPagesByTitle([
			listing("ext:z:dash", "Dashboard"),
			listing("ext:a:dash", "dashboard"),
		]);
		expect(sorted.map((p) => p.id)).toEqual(["ext:a:dash", "ext:z:dash"]);
	});

	test("returns a NEW array and does not mutate the source order", () => {
		const source = [listing("core:z", "Zebra"), listing("core:a", "Apple")];
		const sorted = sortHubPagesByTitle(source);
		expect(sorted).not.toBe(source);
		// The raw listing order is preserved for callers that depend on it.
		expect(source.map((p) => p.title)).toEqual(["Zebra", "Apple"]);
	});

	test("handles the empty listing", () => {
		expect(sortHubPagesByTitle([])).toEqual([]);
	});
});

describe("isSafeInternalHref", () => {
	test("mirrors the server rule", () => {
		expect(isSafeInternalHref("/project/p/chat/c")).toBe(true);
		expect(isSafeInternalHref("/")).toBe(true);
		expect(isSafeInternalHref("//evil.com")).toBe(false);
		expect(isSafeInternalHref("javascript:alert(1)")).toBe(false);
		expect(isSafeInternalHref("/a\\b")).toBe(false);
		expect(isSafeInternalHref("https://x")).toBe(false);
		expect(isSafeInternalHref("")).toBe(false);
		expect(isSafeInternalHref(null)).toBe(false);
	});
});
