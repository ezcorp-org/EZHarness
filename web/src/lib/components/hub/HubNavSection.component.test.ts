/**
 * HubNavSection — DOM tests for the sidebar's collapsible "Hub" dropdown.
 *
 * Covers: starts collapsed (no listing fetch until first expand), the ABC
 * ordering of the lazily-loaded page list, the lazy-once fetch guard
 * (collapse + re-expand reuses the cached list — no second GET), the active
 * highlight on the index row (`active` prop) and on the matching page row
 * (`currentPath`), the icon branch, the `onnavigate` callback (fired on a
 * link click, and safely absent), and every `loadPages` outcome: loading
 * indicator (in-flight), populated list, empty list (both `{pages:[]}` and a
 * missing `pages` key → `?? []`), a non-ok response, and a thrown fetch —
 * both degrading to the empty state without crashing.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import HubNavSection from "./HubNavSection.svelte";
import type { HubPageListing } from "$lib/hub";

// Deliberately OUT of alphabetical order + a page WITH an icon and one WITHOUT,
// so the render proves the component sorts (not the source order) and exercises
// both the icon and no-icon arms.
const LISTING: HubPageListing[] = [
	{ id: "core:zephyr", title: "Zephyr", kind: "core" },
	{ id: "ext:cron:dashboard", title: "Cron Dashboard", icon: "Clock", kind: "ext" },
	{ id: "core:briefing", title: "Briefing", kind: "core" },
];

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

let originalFetch: typeof fetch;
let fetchCalls: string[];
// The listing handler, overridable per test.
let listHandler: () => Promise<Response> | Response;

beforeEach(() => {
	fetchCalls = [];
	originalFetch = globalThis.fetch;
	listHandler = () => jsonResponse({ pages: LISTING });
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		fetchCalls.push(url);
		if (url === "/api/hub/pages") return listHandler();
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function listGets(): number {
	return fetchCalls.filter((u) => u === "/api/hub/pages").length;
}

describe("HubNavSection · collapsed by default", () => {
	test("renders the Hub index link but no page list; no listing fetch fires", async () => {
		const { getByTestId, queryByTestId } = render(HubNavSection, {
			props: { hubBase: "/hub", currentPath: "/hub" },
		});
		await tick();

		const link = getByTestId("hub-nav-link");
		expect(link).toHaveTextContent("Hub");
		expect(link).toHaveAttribute("href", "/hub");
		// Collapsed: the list is absent and nothing was fetched yet.
		expect(queryByTestId("hub-nav-pages")).toBeNull();
		expect(getByTestId("hub-nav-toggle")).toHaveAttribute("aria-expanded", "false");
		expect(listGets()).toBe(0);
	});
});

describe("HubNavSection · expand loads + sorts the page list", () => {
	test("first expand fetches the listing and lists pages ALPHABETICALLY", async () => {
		const { getByTestId, findAllByTestId } = render(HubNavSection, {
			props: { hubBase: "/hub", currentPath: "/hub" },
		});
		await fireEvent.click(getByTestId("hub-nav-toggle"));

		const rows = await findAllByTestId("hub-nav-page");
		expect(rows.map((r) => r.textContent?.trim())).toEqual(["Briefing", "Cron Dashboard", "Zephyr"]);
		// hrefs are prefixed by hubBase and encode the id's colons.
		expect(rows[0]).toHaveAttribute("href", "/hub/core%3Abriefing");
		expect(getByTestId("hub-nav-toggle")).toHaveAttribute("aria-expanded", "true");
		expect(listGets()).toBe(1);
	});

	test("collapse hides the list; re-expand reuses the cached list (no second GET)", async () => {
		const { getByTestId, findAllByTestId, queryByTestId } = render(HubNavSection, {
			props: { hubBase: "/hub", currentPath: "/hub" },
		});
		const toggle = getByTestId("hub-nav-toggle");

		await fireEvent.click(toggle); // expand → 1 fetch
		await findAllByTestId("hub-nav-page");
		expect(listGets()).toBe(1);

		await fireEvent.click(toggle); // collapse
		await waitFor(() => expect(queryByTestId("hub-nav-pages")).toBeNull());

		await fireEvent.click(toggle); // re-expand → cached, no new fetch
		await findAllByTestId("hub-nav-page");
		expect(listGets()).toBe(1);
	});
});

describe("HubNavSection · active highlighting", () => {
	test("the matching page row is aria-current=page; the others are not", async () => {
		const { getByTestId, findAllByTestId } = render(HubNavSection, {
			props: { hubBase: "/hub", currentPath: "/hub/core%3Abriefing" },
		});
		await fireEvent.click(getByTestId("hub-nav-toggle"));
		const rows = await findAllByTestId("hub-nav-page");

		const briefing = rows.find((r) => r.getAttribute("data-page-id") === "core:briefing");
		const zephyr = rows.find((r) => r.getAttribute("data-page-id") === "core:zephyr");
		expect(briefing).toHaveAttribute("aria-current", "page");
		expect(zephyr).not.toHaveAttribute("aria-current");
	});

	test("the Hub index row reflects the `active` prop (true then false)", async () => {
		const { getByTestId, rerender } = render(HubNavSection, {
			props: { hubBase: "/hub", currentPath: "/other", active: true },
		});
		// The index row is the toggle's parent .deck-row.
		const row = getByTestId("hub-nav-toggle").parentElement as HTMLElement;
		expect(row).toHaveAttribute("aria-current", "page");

		await rerender({ hubBase: "/hub", currentPath: "/other", active: false });
		expect(row).not.toHaveAttribute("aria-current");
	});
});

describe("HubNavSection · icon branch", () => {
	test("a page that declares an icon still renders its title (icon arm executes)", async () => {
		const { getByTestId, findAllByTestId } = render(HubNavSection, {
			props: { hubBase: "/hub", currentPath: "/hub" },
		});
		await fireEvent.click(getByTestId("hub-nav-toggle"));
		const rows = await findAllByTestId("hub-nav-page");
		const cron = rows.find((r) => r.getAttribute("data-page-id") === "ext:cron:dashboard");
		expect(cron).toHaveTextContent("Cron Dashboard");
	});
});

describe("HubNavSection · onnavigate callback", () => {
	test("fires on a page-link click and on the Hub index link click", async () => {
		const onnavigate = vi.fn();
		const { getByTestId, findAllByTestId } = render(HubNavSection, {
			props: { hubBase: "/hub", currentPath: "/hub", onnavigate },
		});
		await fireEvent.click(getByTestId("hub-nav-toggle"));
		const rows = await findAllByTestId("hub-nav-page");

		await fireEvent.click(rows[0]!);
		expect(onnavigate).toHaveBeenCalledTimes(1);

		await fireEvent.click(getByTestId("hub-nav-link"));
		expect(onnavigate).toHaveBeenCalledTimes(2);
	});

	test("a link click without an onnavigate handler is a safe no-op", async () => {
		const { getByTestId, findAllByTestId } = render(HubNavSection, {
			props: { hubBase: "/hub", currentPath: "/hub" },
		});
		await fireEvent.click(getByTestId("hub-nav-toggle"));
		const rows = await findAllByTestId("hub-nav-page");
		// No handler passed → the optional-chain short-circuits without throwing.
		await expect(fireEvent.click(rows[0]!)).resolves.not.toThrow();
	});
});

describe("HubNavSection · loadPages outcomes", () => {
	test("shows a loading indicator while the listing is in flight, then the list", async () => {
		let resolveList: (r: Response) => void = () => {};
		listHandler = () => new Promise<Response>((res) => (resolveList = res));

		const { getByTestId, findByTestId, findAllByTestId } = render(HubNavSection, {
			props: { hubBase: "/hub", currentPath: "/hub" },
		});
		await fireEvent.click(getByTestId("hub-nav-toggle"));

		// In-flight: the loading row shows and no page rows exist yet.
		expect(await findByTestId("hub-nav-loading")).toHaveTextContent("Loading");

		resolveList(jsonResponse({ pages: LISTING }));
		const rows = await findAllByTestId("hub-nav-page");
		expect(rows.length).toBe(3);
	});

	test("an empty `{pages:[]}` listing renders the empty state", async () => {
		listHandler = () => jsonResponse({ pages: [] });
		const { getByTestId, findByTestId } = render(HubNavSection, {
			props: { hubBase: "/hub", currentPath: "/hub" },
		});
		await fireEvent.click(getByTestId("hub-nav-toggle"));
		expect(await findByTestId("hub-nav-empty")).toHaveTextContent("No Hub pages yet");
	});

	test("a listing with NO `pages` key falls back to empty (?? []) — no crash", async () => {
		listHandler = () => jsonResponse({});
		const { getByTestId, findByTestId } = render(HubNavSection, {
			props: { hubBase: "/hub", currentPath: "/hub" },
		});
		await fireEvent.click(getByTestId("hub-nav-toggle"));
		expect(await findByTestId("hub-nav-empty")).toBeInTheDocument();
	});

	test("a non-ok response degrades to the empty state", async () => {
		listHandler = () => new Response("nope", { status: 500 });
		const { getByTestId, findByTestId } = render(HubNavSection, {
			props: { hubBase: "/hub", currentPath: "/hub" },
		});
		await fireEvent.click(getByTestId("hub-nav-toggle"));
		expect(await findByTestId("hub-nav-empty")).toBeInTheDocument();
	});

	test("a thrown fetch degrades to the empty state (caught)", async () => {
		listHandler = () => {
			throw new Error("network down");
		};
		const { getByTestId, findByTestId } = render(HubNavSection, {
			props: { hubBase: "/hub", currentPath: "/hub" },
		});
		await fireEvent.click(getByTestId("hub-nav-toggle"));
		expect(await findByTestId("hub-nav-empty")).toBeInTheDocument();
	});
});

describe("HubNavSection · project hub base", () => {
	test("page hrefs are prefixed by a project hubBase", async () => {
		const { getByTestId, findAllByTestId } = render(HubNavSection, {
			props: { hubBase: "/project/p-1/hub", currentPath: "/project/p-1/hub" },
		});
		await fireEvent.click(getByTestId("hub-nav-toggle"));
		const rows = await findAllByTestId("hub-nav-page");
		expect(rows[0]).toHaveAttribute("href", "/project/p-1/hub/core%3Abriefing");
		expect(getByTestId("hub-nav-link")).toHaveAttribute("href", "/project/p-1/hub");
	});
});
