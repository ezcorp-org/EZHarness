/**
 * HubPageView — DOM tests for the full Hub page experience: tab-bar load,
 * page render (all loadPage branches: 404 / non-ok+error / non-ok plain /
 * ok+tree / stale / ok-but-error / ok-but-no-page / throw), retry + refresh,
 * the requestAction precedence (prompt → confirm → dispatch), the host-owned
 * prompt + confirm dialogs (incl. Enter/Escape, field merge, format widget),
 * the dispatchAction result branches (non-ok toast / ok:false toast / inline
 * tree replace / re-pull / throw toast), and the `ext:page-state` SSE
 * live-invalidation listener (matching id re-pulls; non-matching + detail-less
 * events are ignored).
 *
 * Drives requestAction/dispatchAction through the REAL HubComponentRenderer by
 * rendering `button` nodes whose `action` HubComponentRenderer forwards to
 * `onAction` (= the component's requestAction) on click.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import HubPageView from "./HubPageView.svelte";
import type { HubPageListing, HubPageTree, PageAction } from "$lib/hub";

// addToast is the single error/refusal surface — assert against the mock.
// `vi.mock` factories are hoisted above all module code, so the mock fn must
// live in the hoisted region too (it can't reference a normal top-level const).
const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock("$lib/toast.svelte.js", () => ({ addToast }));

// Stub the shared format-widget registry. The real widgets (SharedFilePicker /
// DatePicker / …) don't mount cleanly under jsdom, so the format branch's
// `<PromptWidget bind:value size absolute placeholder/>` prop lines never get
// attributed as covered. Swap in a tiny stub that accepts those exact props so
// the branch (incl. `bind:value` + the `absolute={format === "file-path"}`
// expression) executes and is measured. The map MUST keep "date" (the existing
// recognized-format test relies on it) AND add "file-path" (drives the truthy
// `absolute` arm). Any OTHER format string is absent → `format in map` is false
// → the text-input branch still renders for the no-format / unknown-format tests.
vi.mock("$lib/components/ui/format-map", async () => {
	// Import the stub INSIDE the (hoisted) factory — a top-level import binding
	// isn't initialized yet when the factory runs, so reference it lazily here.
	const { default: PromptWidgetStub } = await import("./__tests__/PromptWidgetStub.svelte");
	const map: Record<string, unknown> = { "file-path": PromptWidgetStub, date: PromptWidgetStub };
	return {
		formatComponentMap: map,
		getFormatComponent: (format: string) => {
			const c = map[format];
			if (!c) throw new Error(`Unrecognized input format: "${format}"`);
			return c;
		},
	};
});

const EXT_PAGE_ID = "ext:myext:home"; // → POST /api/extensions/myext/events/<event>

const TABS: HubPageListing[] = [
	{ id: EXT_PAGE_ID, title: "Home", icon: "home", kind: "ext" },
	{ id: "ext:myext:logs", title: "Logs", kind: "ext" },
];

/** Build a page tree carrying one actionable `button` node. */
function treeWith(action: PageAction, title = "My Page"): HubPageTree {
	return {
		title,
		nodes: [
			{ type: "text", content: "hello body" },
			{ type: "button", label: "Do it", action },
		],
	};
}

const PLAIN_TREE: HubPageTree = {
	title: "Plain Page",
	nodes: [{ type: "text", content: "just text" }],
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

// ── Configurable fetch router (set per test) ─────────────────────────
let originalFetch: typeof fetch;
let fetchCalls: { url: string; method: string }[];

// Handlers, overridable per test. Each returns a Response (or throws).
let tabsHandler: () => Promise<Response> | Response;
let pageHandler: (id: string) => Promise<Response> | Response;
let actionHandler: (url: string, body: unknown) => Promise<Response> | Response;

beforeEach(() => {
	addToast.mockClear();
	fetchCalls = [];
	originalFetch = globalThis.fetch;

	tabsHandler = () => jsonResponse({ pages: TABS });
	pageHandler = () => jsonResponse({ page: PLAIN_TREE });
	actionHandler = () => jsonResponse({ ok: true });

	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = (init?.method ?? "GET").toUpperCase();
		fetchCalls.push({ url, method });
		if (url === "/api/hub/pages") return tabsHandler();
		if (url.startsWith("/api/hub/pages/")) {
			const id = decodeURIComponent(url.slice("/api/hub/pages/".length));
			return pageHandler(id);
		}
		if (url.startsWith("/api/extensions/") && url.includes("/events/")) {
			const body = init?.body ? JSON.parse(init.body as string) : undefined;
			return actionHandler(url, body);
		}
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

/** Render and wait for the initial onMount/$effect load to settle. */
async function renderView(pageId = EXT_PAGE_ID) {
	const utils = render(HubPageView, { props: { pageId, hubBase: "/hub" } });
	// onMount loadTabs + $effect loadPage both resolve on the microtask queue.
	await tick();
	await tick();
	return utils;
}

function pageGets(): string[] {
	return fetchCalls.filter((c) => c.url.startsWith("/api/hub/pages/")).map((c) => c.url);
}

describe("HubPageView · tab bar + initial load", () => {
	test("renders one tab per listing, links prefixed by hubBase, active tab marked", async () => {
		const { findAllByTestId } = await renderView();
		const tabs = await findAllByTestId("hub-tab");
		expect(tabs).toHaveLength(2);
		expect(tabs[0]).toHaveTextContent("Home");
		expect(tabs[1]).toHaveTextContent("Logs");
		// hubBase prefixes the href; the active page id is aria-selected.
		expect(tabs[0]).toHaveAttribute("href", `/hub/${encodeURIComponent(EXT_PAGE_ID)}`);
		expect(tabs[0]).toHaveAttribute("aria-selected", "true");
		expect(tabs[1]).toHaveAttribute("aria-selected", "false");
	});

	test("renders tabs ALPHABETICALLY by title regardless of the listing order", async () => {
		// A deliberately out-of-order listing → the tab bar must sort it ABC.
		tabsHandler = () =>
			jsonResponse({
				pages: [
					{ id: "ext:myext:zed", title: "Zed", kind: "ext" },
					{ id: EXT_PAGE_ID, title: "Home", icon: "home", kind: "ext" },
					{ id: "ext:myext:logs", title: "Logs", kind: "ext" },
				],
			});
		const { findAllByTestId } = await renderView();
		const tabs = await findAllByTestId("hub-tab");
		expect(tabs.map((t) => t.textContent?.trim())).toEqual(["Home", "Logs", "Zed"]);
	});

	test("renders the page title + body (real HubComponentRenderer) once the tree loads", async () => {
		pageHandler = () => jsonResponse({ page: PLAIN_TREE });
		const { findByTestId } = await renderView();
		expect(await findByTestId("hub-page-title")).toHaveTextContent("Plain Page");
		const body = await findByTestId("hub-page-body");
		expect(body).toHaveTextContent("just text");
	});

	test("a tabs fetch that throws degrades silently — page still renders", async () => {
		tabsHandler = () => {
			throw new Error("network down");
		};
		const { findByTestId, queryByTestId } = await renderView();
		// No tab bar, but the page body still loads via its own fetch.
		expect(await findByTestId("hub-page-title")).toBeInTheDocument();
		expect(queryByTestId("hub-tab")).toBeNull();
	});

	test("a non-ok tabs response yields no tab bar (data ignored)", async () => {
		tabsHandler = () => new Response("nope", { status: 500 });
		const { findByTestId, queryByTestId } = await renderView();
		expect(await findByTestId("hub-page-title")).toBeInTheDocument();
		expect(queryByTestId("hub-tab")).toBeNull();
	});
});

describe("HubPageView · loadPage branches", () => {
	test("404 → error card with retry button", async () => {
		pageHandler = () => new Response("missing", { status: 404 });
		const { findByTestId } = await renderView();
		const card = await findByTestId("hub-error-card");
		expect(card).toHaveTextContent("doesn't exist");
		expect(await findByTestId("hub-retry-btn")).toBeInTheDocument();
	});

	test("non-ok with {error} body → that error message in the card", async () => {
		pageHandler = () => jsonResponse({ error: "boom from server" }, 502);
		const { findByTestId } = await renderView();
		expect(await findByTestId("hub-error-card")).toHaveTextContent("boom from server");
	});

	test("non-ok with no JSON body → generic HTTP message", async () => {
		pageHandler = () => new Response("plain", { status: 503 });
		const { findByTestId } = await renderView();
		expect(await findByTestId("hub-error-card")).toHaveTextContent("HTTP 503");
	});

	test("ok with {error} (no page) → error card", async () => {
		pageHandler = () => jsonResponse({ error: "render failed" });
		const { findByTestId } = await renderView();
		expect(await findByTestId("hub-error-card")).toHaveTextContent("render failed");
	});

	test("ok with neither page nor error → fallback render error", async () => {
		pageHandler = () => jsonResponse({});
		const { findByTestId } = await renderView();
		expect(await findByTestId("hub-error-card")).toHaveTextContent("failed to render");
	});

	test("ok with stale:true → stale indicator shows alongside the page", async () => {
		pageHandler = () => jsonResponse({ page: PLAIN_TREE, stale: true });
		const { findByTestId } = await renderView();
		expect(await findByTestId("hub-page-title")).toBeInTheDocument();
		expect(await findByTestId("hub-stale-indicator")).toHaveTextContent("refreshing");
	});

	test("fetch throwing → error card with the thrown message", async () => {
		pageHandler = () => {
			throw new Error("socket hangup");
		};
		const { findByTestId } = await renderView();
		expect(await findByTestId("hub-error-card")).toHaveTextContent("socket hangup");
	});

	test("Retry button re-pulls the page (error → success)", async () => {
		let calls = 0;
		pageHandler = () => {
			calls += 1;
			return calls === 1 ? new Response("x", { status: 404 }) : jsonResponse({ page: PLAIN_TREE });
		};
		const { findByTestId, queryByTestId } = await renderView();
		const retry = await findByTestId("hub-retry-btn");
		await fireEvent.click(retry);
		expect(await findByTestId("hub-page-title")).toHaveTextContent("Plain Page");
		expect(queryByTestId("hub-error-card")).toBeNull();
	});

	test("Refresh button re-pulls the page", async () => {
		const { findByTestId } = await renderView();
		await findByTestId("hub-page-title");
		const before = pageGets().length;
		await fireEvent.click(await findByTestId("hub-refresh-btn"));
		await waitFor(() => expect(pageGets().length).toBeGreaterThan(before));
	});

	test("changing the pageId prop re-loads the new page ($effect)", async () => {
		const seen: string[] = [];
		pageHandler = (id) => {
			seen.push(id);
			return jsonResponse({ page: { ...PLAIN_TREE, title: id } });
		};
		const { rerender, findByTestId } = await renderView(EXT_PAGE_ID);
		await findByTestId("hub-page-title");
		await rerender({ pageId: "ext:myext:logs", hubBase: "/hub" });
		await tick();
		await waitFor(() => expect(seen).toContain("ext:myext:logs"));
	});
});

describe("HubPageView · requestAction precedence", () => {
	test("plain action (no prompt/confirm) dispatches immediately — no dialog", async () => {
		const action: PageAction = { event: "myext:refresh", payload: { a: 1 } };
		pageHandler = () => jsonResponse({ page: treeWith(action) });
		const { findByTestId, queryByTestId } = await renderView();
		await fireEvent.click(await findByTestId("hub-node-button"));
		await waitFor(() =>
			expect(
				fetchCalls.some((c) => c.method === "POST" && c.url.includes("/events/refresh")),
			).toBe(true),
		);
		expect(queryByTestId("hub-prompt-dialog")).toBeNull();
		expect(queryByTestId("hub-confirm-dialog")).toBeNull();
	});

	test("action with confirm opens the confirm dialog (no dispatch yet)", async () => {
		const action: PageAction = { event: "myext:wipe", confirm: "Really wipe?" };
		pageHandler = () => jsonResponse({ page: treeWith(action) });
		const { findByTestId } = await renderView();
		await fireEvent.click(await findByTestId("hub-node-button"));
		const dialog = await findByTestId("hub-confirm-dialog");
		expect(dialog).toHaveTextContent("Really wipe?");
		expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
	});

	test("action with prompt takes precedence over confirm (prompt dialog opens)", async () => {
		const action: PageAction = {
			event: "myext:add",
			confirm: "are you sure",
			prompt: { label: "Topic", field: "topic" },
		};
		pageHandler = () => jsonResponse({ page: treeWith(action) });
		const { findByTestId, queryByTestId } = await renderView();
		await fireEvent.click(await findByTestId("hub-node-button"));
		expect(await findByTestId("hub-prompt-dialog")).toBeInTheDocument();
		// The confirm text shows as the prompt body, but the confirm dialog
		// itself must NOT be open (prompt wins).
		expect(queryByTestId("hub-confirm-dialog")).toBeNull();
		expect(await findByTestId("hub-prompt-dialog")).toHaveTextContent("are you sure");
	});
});

describe("HubPageView · confirm dialog", () => {
	const action: PageAction = { event: "myext:wipe", confirm: "Really wipe?" };

	test("Confirm → dispatch fires; dialog closes", async () => {
		pageHandler = () => jsonResponse({ page: treeWith(action) });
		const { findByTestId, queryByTestId } = await renderView();
		await fireEvent.click(await findByTestId("hub-node-button"));
		await fireEvent.click(await findByTestId("hub-confirm-ok"));
		await waitFor(() =>
			expect(fetchCalls.some((c) => c.method === "POST" && c.url.includes("/events/wipe"))).toBe(
				true,
			),
		);
		await waitFor(() => expect(queryByTestId("hub-confirm-dialog")).toBeNull());
	});

	test("Cancel → no dispatch; dialog closes", async () => {
		pageHandler = () => jsonResponse({ page: treeWith(action) });
		const { findByTestId, queryByTestId } = await renderView();
		await fireEvent.click(await findByTestId("hub-node-button"));
		await fireEvent.click(await findByTestId("hub-confirm-cancel"));
		await waitFor(() => expect(queryByTestId("hub-confirm-dialog")).toBeNull());
		expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
	});
});

describe("HubPageView · prompt dialog", () => {
	test("Submit disabled until input non-empty; submit merges payload[field] then dispatches", async () => {
		const action: PageAction = {
			event: "myext:add",
			payload: { keep: "yes" },
			prompt: { label: "Topic", field: "topic", placeholder: "type…" },
		};
		pageHandler = () => jsonResponse({ page: treeWith(action) });
		let dispatchedBody: { payload?: Record<string, unknown> } | undefined;
		actionHandler = (_url, body) => {
			dispatchedBody = body as typeof dispatchedBody;
			return jsonResponse({ ok: true });
		};
		const { findByTestId } = await renderView();
		await fireEvent.click(await findByTestId("hub-node-button"));

		const submit = (await findByTestId("hub-prompt-submit")) as HTMLButtonElement;
		expect(submit).toBeDisabled();

		const input = (await findByTestId("hub-prompt-input")) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "  weather  " } });
		expect(submit).not.toBeDisabled();

		await fireEvent.click(submit);
		await waitFor(() => expect(dispatchedBody?.payload).toBeDefined());
		// Trimmed value merged under the custom field; existing payload kept.
		expect(dispatchedBody?.payload).toEqual({ keep: "yes", topic: "weather" });
	});

	test("field defaults to 'value' when prompt.field is omitted", async () => {
		const action: PageAction = {
			event: "myext:add",
			prompt: { label: "Anything" },
		};
		pageHandler = () => jsonResponse({ page: treeWith(action) });
		let dispatchedBody: { payload?: Record<string, unknown> } | undefined;
		actionHandler = (_url, body) => {
			dispatchedBody = body as typeof dispatchedBody;
			return jsonResponse({ ok: true });
		};
		const { findByTestId } = await renderView();
		await fireEvent.click(await findByTestId("hub-node-button"));
		const input = (await findByTestId("hub-prompt-input")) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "x" } });
		await fireEvent.click(await findByTestId("hub-prompt-submit"));
		await waitFor(() => expect(dispatchedBody?.payload).toEqual({ value: "x" }));
	});

	test("Enter submits the prompt; Escape cancels it", async () => {
		const action: PageAction = { event: "myext:add", prompt: { label: "Topic", field: "topic" } };
		pageHandler = () => jsonResponse({ page: treeWith(action) });
		const { findByTestId, queryByTestId } = await renderView();

		// Escape first: opens, then cancels — no dispatch.
		await fireEvent.click(await findByTestId("hub-node-button"));
		let input = (await findByTestId("hub-prompt-input")) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "abc" } });
		await fireEvent.keyDown(input, { key: "Escape" });
		await waitFor(() => expect(queryByTestId("hub-prompt-dialog")).toBeNull());
		expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);

		// Enter submits.
		await fireEvent.click(await findByTestId("hub-node-button"));
		input = (await findByTestId("hub-prompt-input")) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "abc" } });
		await fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() =>
			expect(fetchCalls.some((c) => c.method === "POST" && c.url.includes("/events/add"))).toBe(
				true,
			),
		);
		await waitFor(() => expect(queryByTestId("hub-prompt-dialog")).toBeNull());
	});

	test("Cancel button closes the prompt without dispatching", async () => {
		const action: PageAction = { event: "myext:add", prompt: { label: "Topic" } };
		pageHandler = () => jsonResponse({ page: treeWith(action) });
		const { findByTestId, queryByTestId } = await renderView();
		await fireEvent.click(await findByTestId("hub-node-button"));
		await findByTestId("hub-prompt-dialog");
		await fireEvent.click(await findByTestId("hub-prompt-cancel"));
		await waitFor(() => expect(queryByTestId("hub-prompt-dialog")).toBeNull());
		expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
	});

	test("a recognized prompt.format renders the shared format widget instead of the text input", async () => {
		const action: PageAction = {
			event: "myext:add",
			prompt: { label: "When", format: "date" },
		};
		pageHandler = () => jsonResponse({ page: treeWith(action) });
		const { findByTestId, queryByTestId } = await renderView();
		await fireEvent.click(await findByTestId("hub-node-button"));
		// The format branch renders `hub-prompt-format` and NOT the plain input.
		expect(await findByTestId("hub-prompt-format")).toBeInTheDocument();
		expect(queryByTestId("hub-prompt-input")).toBeNull();
	});

	test("file-path format mounts the widget with size + truthy absolute + placeholder + two-way value", async () => {
		// Drives the PromptWidget prop lines: `bind:value`, `size="md"`,
		// `absolute={format === "file-path"}` (TRUTHY arm here), and the
		// placeholder fallback. Asserts each prop reached the widget and that
		// the binding round-trips the typed value back into the submit payload.
		const action: PageAction = {
			event: "myext:add",
			payload: { keep: "yes" },
			prompt: { label: "Folder", field: "folder", format: "file-path", placeholder: "/srv" },
		};
		pageHandler = () => jsonResponse({ page: treeWith(action) });
		let dispatchedBody: { payload?: Record<string, unknown> } | undefined;
		actionHandler = (_url, body) => {
			dispatchedBody = body as typeof dispatchedBody;
			return jsonResponse({ ok: true });
		};
		const { findByTestId, queryByTestId } = await renderView();
		await fireEvent.click(await findByTestId("hub-node-button"));

		// Widget branch — not the plain text input.
		expect(await findByTestId("hub-prompt-format")).toBeInTheDocument();
		expect(queryByTestId("hub-prompt-input")).toBeNull();

		// Props passed through: size="md", absolute=true (format === "file-path"),
		// placeholder forwarded.
		const widget = (await findByTestId("prompt-widget-stub")) as HTMLInputElement;
		expect(widget).toHaveAttribute("data-size", "md");
		expect(widget).toHaveAttribute("data-absolute", "true");
		expect(widget).toHaveAttribute("placeholder", "/srv");

		// `bind:value` is two-way: typing into the widget feeds promptValue, which
		// the Submit handler merges under the prompt field.
		await fireEvent.input(widget, { target: { value: "/srv/data" } });
		await fireEvent.click(await findByTestId("hub-prompt-submit"));
		await waitFor(() => expect(dispatchedBody?.payload).toBeDefined());
		expect(dispatchedBody?.payload).toEqual({ keep: "yes", folder: "/srv/data" });
	});

	test("a non-file-path recognized format passes absolute=false (falsy arm of the file-path check)", async () => {
		// Same widget branch, but format "date" ≠ "file-path" → absolute is false,
		// covering the falsy side of the `format === "file-path"` expression.
		const action: PageAction = {
			event: "myext:add",
			prompt: { label: "When", format: "date" },
		};
		pageHandler = () => jsonResponse({ page: treeWith(action) });
		const { findByTestId } = await renderView();
		await fireEvent.click(await findByTestId("hub-node-button"));
		const widget = (await findByTestId("prompt-widget-stub")) as HTMLInputElement;
		expect(widget).toHaveAttribute("data-absolute", "false");
		// placeholder omitted on the action → the `?? ""` fallback yields empty.
		expect(widget).toHaveAttribute("placeholder", "");
	});
});

describe("HubPageView · dispatchAction result branches", () => {
	const plainAction: PageAction = { event: "myext:go" };

	test("ok with {page} replaces the tree inline (no re-pull GET)", async () => {
		pageHandler = () => jsonResponse({ page: treeWith(plainAction, "Before") });
		const updated: HubPageTree = { title: "After", nodes: [{ type: "text", content: "new body" }] };
		actionHandler = () => jsonResponse({ page: updated });
		const { findByTestId } = await renderView();
		await findByTestId("hub-page-title");
		const getsBefore = pageGets().length;
		await fireEvent.click(await findByTestId("hub-node-button"));
		await waitFor(() => expect(findByTestId("hub-page-title")).resolves.toHaveTextContent("After"));
		expect(await findByTestId("hub-page-body")).toHaveTextContent("new body");
		// Inline replace must NOT trigger an extra render GET.
		expect(pageGets().length).toBe(getsBefore);
	});

	test("ok without a page re-pulls via loadPage (extra GET)", async () => {
		pageHandler = () => jsonResponse({ page: treeWith(plainAction) });
		actionHandler = () => jsonResponse({ ok: true });
		const { findByTestId } = await renderView();
		await findByTestId("hub-page-title");
		const getsBefore = pageGets().length;
		await fireEvent.click(await findByTestId("hub-node-button"));
		await waitFor(() => expect(pageGets().length).toBeGreaterThan(getsBefore));
		expect(addToast).not.toHaveBeenCalled();
	});

	test("non-ok response → error toast with the server error", async () => {
		pageHandler = () => jsonResponse({ page: treeWith(plainAction) });
		actionHandler = () => jsonResponse({ error: "denied" }, 403);
		const { findByTestId } = await renderView();
		await fireEvent.click(await findByTestId("hub-node-button"));
		await waitFor(() =>
			expect(addToast).toHaveBeenCalledWith({ type: "error", message: "denied" }),
		);
	});

	test("non-ok with no JSON body → generic HTTP error toast", async () => {
		pageHandler = () => jsonResponse({ page: treeWith(plainAction) });
		actionHandler = () => new Response("nope", { status: 500 });
		const { findByTestId } = await renderView();
		await fireEvent.click(await findByTestId("hub-node-button"));
		await waitFor(() =>
			expect(addToast).toHaveBeenCalledWith({
				type: "error",
				message: expect.stringContaining("HTTP 500"),
			}),
		);
	});

	test("HTTP 200 {ok:false, message} (domain refusal) → error toast", async () => {
		pageHandler = () => jsonResponse({ page: treeWith(plainAction) });
		actionHandler = () => jsonResponse({ ok: false, message: "folder unreachable" });
		const { findByTestId } = await renderView();
		await fireEvent.click(await findByTestId("hub-node-button"));
		await waitFor(() =>
			expect(addToast).toHaveBeenCalledWith({ type: "error", message: "folder unreachable" }),
		);
	});

	test("a thrown action fetch → error toast with the thrown message", async () => {
		pageHandler = () => jsonResponse({ page: treeWith(plainAction) });
		actionHandler = () => {
			throw new Error("connection reset");
		};
		const { findByTestId } = await renderView();
		await fireEvent.click(await findByTestId("hub-node-button"));
		await waitFor(() =>
			expect(addToast).toHaveBeenCalledWith({ type: "error", message: "connection reset" }),
		);
	});
});

describe("HubPageView · ext:page-state SSE live-invalidation", () => {
	test("a matching {extensionName,pageId} event re-pulls the current page", async () => {
		const { findByTestId } = await renderView(EXT_PAGE_ID);
		await findByTestId("hub-page-title");
		const before = pageGets().length;
		window.dispatchEvent(
			new CustomEvent("ext:page-state", {
				detail: { extensionName: "myext", pageId: "home" },
			}),
		);
		await waitFor(() => expect(pageGets().length).toBeGreaterThan(before));
	});

	test("a non-matching event is ignored (no re-pull)", async () => {
		const { findByTestId } = await renderView(EXT_PAGE_ID);
		await findByTestId("hub-page-title");
		const before = pageGets().length;
		window.dispatchEvent(
			new CustomEvent("ext:page-state", {
				detail: { extensionName: "other", pageId: "elsewhere" },
			}),
		);
		await tick();
		await tick();
		expect(pageGets().length).toBe(before);
	});

	test("an event missing detail fields is ignored", async () => {
		const { findByTestId } = await renderView(EXT_PAGE_ID);
		await findByTestId("hub-page-title");
		const before = pageGets().length;
		window.dispatchEvent(new CustomEvent("ext:page-state", { detail: {} }));
		window.dispatchEvent(new CustomEvent("ext:page-state", {}));
		await tick();
		await tick();
		expect(pageGets().length).toBe(before);
	});

	test("the listener is removed on unmount (no re-pull after destroy)", async () => {
		const { findByTestId, unmount } = await renderView(EXT_PAGE_ID);
		await findByTestId("hub-page-title");
		const before = pageGets().length;
		unmount();
		window.dispatchEvent(
			new CustomEvent("ext:page-state", {
				detail: { extensionName: "myext", pageId: "home" },
			}),
		);
		await tick();
		await tick();
		expect(pageGets().length).toBe(before);
	});
});

describe("projectId prop (project-scoped hub route)", () => {
	test("render pull carries ?project= on the initial load AND on re-pulls", async () => {
		render(HubPageView, {
			props: { pageId: EXT_PAGE_ID, hubBase: "/project/p-1/hub", projectId: "p-1" },
		});
		await tick();
		await tick();
		const pagePulls = fetchCalls.filter((c) => c.url.startsWith("/api/hub/pages/ext"));
		expect(pagePulls.length).toBeGreaterThan(0);
		for (const call of pagePulls) {
			expect(call.url).toContain("?project=p-1");
		}
		// SSE invalidation re-pull keeps the project context.
		fetchCalls = [];
		window.dispatchEvent(
			new CustomEvent("ext:page-state", { detail: { extensionName: "myext", pageId: "home" } }),
		);
		await waitFor(() => {
			expect(
				fetchCalls.some((c) => c.url.startsWith("/api/hub/pages/ext") && c.url.includes("?project=p-1")),
			).toBe(true);
		});
	});

	test("without projectId the pull URL stays clean (no query)", async () => {
		await renderView();
		const pagePulls = fetchCalls.filter((c) => c.url.startsWith("/api/hub/pages/ext"));
		expect(pagePulls.length).toBeGreaterThan(0);
		for (const call of pagePulls) {
			expect(call.url).not.toContain("?project=");
		}
	});

	test("with projectId, the active pageId is remembered under the per-project key", async () => {
		localStorage.clear();
		render(HubPageView, {
			props: { pageId: EXT_PAGE_ID, hubBase: "/project/p-1/hub", projectId: "p-1" },
		});
		await tick();
		await tick();
		expect(localStorage.getItem("ezcorp-hub-last-page:p-1")).toBe(EXT_PAGE_ID);
	});

	test("without projectId, localStorage is left untouched (global hub never writes)", async () => {
		localStorage.clear();
		await renderView();
		expect(localStorage.getItem("ezcorp-hub-last-page:p-1")).toBeNull();
		expect(localStorage.length).toBe(0);
	});
});

describe("run prop (?run= detail variant)", () => {
	test("the render pull carries ?run= (and ?project= when both are set)", async () => {
		render(HubPageView, {
			props: { pageId: EXT_PAGE_ID, hubBase: "/project/p-1/hub", projectId: "p-1", run: "run_abc" },
		});
		await tick();
		await tick();
		const pagePulls = fetchCalls.filter((c) => c.url.startsWith("/api/hub/pages/ext"));
		expect(pagePulls.length).toBeGreaterThan(0);
		for (const call of pagePulls) {
			expect(call.url).toContain("run=run_abc");
			expect(call.url).toContain("project=p-1");
		}
	});

	test("run alone (global hub) carries ?run= with no project", async () => {
		render(HubPageView, {
			props: { pageId: EXT_PAGE_ID, hubBase: "/hub", run: "run_abc" },
		});
		await tick();
		await tick();
		const pagePulls = fetchCalls.filter((c) => c.url.startsWith("/api/hub/pages/ext"));
		expect(pagePulls.length).toBeGreaterThan(0);
		for (const call of pagePulls) {
			expect(call.url).toContain("run=run_abc");
			expect(call.url).not.toContain("project=");
		}
	});
});
