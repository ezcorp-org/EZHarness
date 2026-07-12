/**
 * jsdom unit tests for the Ez client-tool dispatcher.
 *
 * Exercises every handler + dependency-resolution path: the same-origin
 * navigate allowlist, read_page serialization (summary/full), fill_form
 * (invalid-input / form-not-found / success), navigate_to destination
 * serialization (success / best-effort failure), the no-DOM guard, and the
 * default global fallbacks (document.body / location / document.title).
 */
import { describe, test, expect, beforeEach } from "vitest";
import {
	dispatch,
	isAllowedNavigateTarget,
	type EzClientToolEvent,
	type DispatcherDeps,
} from "../client-tool-dispatcher";

function evt(toolName: string, input: unknown): EzClientToolEvent {
	return { conversationId: "c", toolCallId: "t", toolName, input };
}

function makeRoot(html: string): HTMLElement {
	const root = document.createElement("div");
	root.innerHTML = html;
	return root;
}

beforeEach(() => {
	document.body.innerHTML = "";
	document.title = "";
});

describe("isAllowedNavigateTarget", () => {
	test("accepts in-app routes, rejects everything else", () => {
		expect(isAllowedNavigateTarget("/marketplace")).toBe(true);
		expect(isAllowedNavigateTarget("/agents/new")).toBe(true);
		expect(isAllowedNavigateTarget("https://evil.test/")).toBe(false); // ://
		expect(isAllowedNavigateTarget("//evil.test")).toBe(false); // //
		expect(isAllowedNavigateTarget("/agents\nx")).toBe(false); // control char
		expect(isAllowedNavigateTarget("relative")).toBe(false); // no leading /
		expect(isAllowedNavigateTarget("/login")).toBe(false); // not allowlisted
		expect(isAllowedNavigateTarget("")).toBe(false);
		expect(isAllowedNavigateTarget(42)).toBe(false);
	});
});

describe("dispatch — read_page", () => {
	test("no-DOM guard when the root is unavailable", async () => {
		const r = await dispatch(evt("read_page", {}), { goto: async () => {}, root: null });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("no-dom");
	});

	test("summary serialization (no field values) via injected root/path/title", async () => {
		const deps: DispatcherDeps = {
			goto: async () => {},
			root: makeRoot('<h1>Agents</h1><form id="f"><input name="q" value="hi" /></form>'),
			currentPath: () => "/agents",
			currentTitle: () => "Agents",
		};
		const r = await dispatch(evt("read_page", { detail: "summary" }), deps);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.detail).toMatchObject({ path: "/agents", title: "Agents", headings: ["Agents"] });
			const forms = (r.detail as { forms: { fields: { value?: string }[] }[] }).forms;
			expect(forms[0]!.fields[0]!.value).toBeUndefined();
		}
	});

	test("full serialization includes field values", async () => {
		const deps: DispatcherDeps = {
			goto: async () => {},
			root: makeRoot('<form id="f"><input name="q" value="hi" /></form>'),
			currentPath: () => "/x/agents",
			currentTitle: () => "T",
		};
		const r = await dispatch(evt("read_page", { detail: "full" }), deps);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const forms = (r.detail as { forms: { fields: { value?: string }[] }[] }).forms;
			expect(forms[0]!.fields[0]!.value).toBe("hi");
		}
	});

	test("falls back to document.body / location / document.title when nothing is injected", async () => {
		document.body.innerHTML = "<h1>Live</h1>";
		document.title = "Live Title";
		const r = await dispatch(evt("read_page", {}), { goto: async () => {} });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.detail).toMatchObject({ title: "Live Title", headings: ["Live"] });
			// jsdom's default location.pathname.
			expect(typeof (r.detail as { path: string }).path).toBe("string");
		}
	});
});

describe("dispatch — fill_form", () => {
	test("no-DOM guard", async () => {
		const r = await dispatch(evt("fill_form", { formId: "f", values: {} }), { goto: async () => {}, root: null });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("no-dom");
	});

	test("invalid-input when formId or values are missing", async () => {
		const deps = { goto: async () => {}, root: makeRoot("<form id='f'></form>") };
		const noId = await dispatch(evt("fill_form", { values: {} }), deps);
		expect(noId.ok).toBe(false);
		if (!noId.ok) expect(noId.code).toBe("invalid-input");
		const noValues = await dispatch(evt("fill_form", { formId: "f" }), deps);
		expect(noValues.ok).toBe(false);
		if (!noValues.ok) expect(noValues.code).toBe("invalid-input");
	});

	test("no-handler when the form id does not exist", async () => {
		const deps = { goto: async () => {}, root: makeRoot('<form id="real"><input name="a" /></form>') };
		const r = await dispatch(evt("fill_form", { formId: "ghost", values: { a: "1" } }), deps);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("no-handler");
	});

	test("fills a matched form and returns the per-field report", async () => {
		const root = makeRoot('<form id="f"><input name="a" /><input name="pw" type="password" /></form>');
		const r = await dispatch(evt("fill_form", { formId: "f", values: { a: "hi", pw: "x" } }), { goto: async () => {}, root });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.detail).toEqual({
				formId: "f",
				filled: ["a"],
				skipped: [{ field: "pw", reason: "refused: password field" }],
			});
		}
		expect(root.querySelector<HTMLInputElement>('[name="a"]')!.value).toBe("hi");
	});
});

describe("dispatch — navigate_to", () => {
	test("rejects off-origin targets without calling goto", async () => {
		let called = false;
		const r = await dispatch(evt("navigate_to", { path: "https://evil.test" }), {
			goto: async () => {
				called = true;
			},
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("rejected");
		expect(called).toBe(false);
	});

	test("reports goto exceptions as rejected", async () => {
		const r = await dispatch(evt("navigate_to", { path: "/marketplace" }), {
			goto: async () => {
				throw new Error("boom");
			},
		});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.code).toBe("rejected");
			expect(r.error).toContain("boom");
		}
	});

	test("navigates then serializes the destination (path/title/headings + content excerpt)", async () => {
		const calls: string[] = [];
		const deps: DispatcherDeps = {
			goto: async (p) => {
				calls.push(p);
			},
			root: makeRoot('<h1>Marketplace</h1><p>Browse extensions here.</p><form id="f"><input name="q" /></form>'),
			currentPath: () => "/marketplace",
			currentTitle: () => "Marketplace",
			afterNavigate: async () => {},
		};
		const r = await dispatch(evt("navigate_to", { path: "/marketplace?q=pdf" }), deps);
		expect(calls).toEqual(["/marketplace?q=pdf"]);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.detail).toEqual({
				path: "/marketplace?q=pdf",
				destination: {
					path: "/marketplace",
					title: "Marketplace",
					headings: ["Marketplace"],
					content: "Marketplace Browse extensions here.",
				},
			});
			// Destination carries no forms key — identity + excerpt only.
			expect((r.detail as Record<string, unknown>).forms).toBeUndefined();
		}
	});

	test("destination content excerpt is capped at 500 chars", async () => {
		const long = `<p>${"w".repeat(60)} </p>`.repeat(30); // ~1.8k chars of content
		const r = await dispatch(evt("navigate_to", { path: "/marketplace" }), {
			goto: async () => {},
			root: makeRoot(`<h1>M</h1>${long}`),
			currentPath: () => "/marketplace",
			currentTitle: () => "M",
			afterNavigate: async () => {},
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			const destination = (r.detail as { destination: { content: string } }).destination;
			expect(destination.content.length).toBeLessThanOrEqual(501); // 500 + ellipsis
			expect(destination.content.endsWith("…")).toBe(true);
		}
	});

	test("still succeeds (path only) when destination serialization is unavailable/throws", async () => {
		// afterNavigate throws → serializeDestination swallows and returns
		// undefined; the navigation result must still be ok with just the path.
		const r = await dispatch(evt("navigate_to", { path: "/settings" }), {
			goto: async () => {},
			root: null, // also exercises the null-root branch inside serializeDestination
			afterNavigate: async () => {
				throw new Error("no route yet");
			},
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.detail).toEqual({ path: "/settings" });
	});

	test("uses the default macrotask wait when afterNavigate is not injected", async () => {
		const r = await dispatch(evt("navigate_to", { path: "/docs" }), { goto: async () => {}, root: null });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.detail).toEqual({ path: "/docs" });
	});
});

describe("dispatch — unknown tool", () => {
	test("returns unknown-tool for names outside the client allowlist", async () => {
		const r = await dispatch(evt("summarize_conversation", {}), { goto: async () => {} });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("unknown-tool");
	});
});
