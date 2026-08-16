/**
 * DOM tests for WebContextCard.svelte.
 *
 * The component is template-only (every string and link decision comes
 * from web-context-card-logic.ts), so these assert what a user can SEE —
 * which is the whole point of the card:
 *   - collapsed, it still discloses the query, the source count and the
 *     domains, so a reader never has to expand to learn what was read;
 *   - expanded, every title is a real link, opened safely
 *     (`rel="noopener noreferrer"` paired with `target="_blank"`);
 *   - a URL the logic module refused renders as inert text WITH the raw
 *     string, never as a hidden result and never as an href;
 *   - the footer states that this text entered the conversation context.
 */
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, test } from "vitest";
import "@testing-library/jest-dom/vitest";
import WebContextCard from "./WebContextCard.svelte";
import {
	buildWebContextView,
	NO_RESULTS_MARKDOWN,
	WEB_PAGE_CARD_TYPE,
	WEB_SEARCH_CARD_TYPE,
	type WebContextView,
} from "./web-context-card-logic.js";

afterEach(() => cleanup());

const SEARCH_MARKDOWN = [
	"- [Bun v1.3.0 — Release notes](https://bun.sh/blog/bun-v1-3)",
	"  Bun 1.3 ships a built-in Postgres client.",
	"- [Release v1.3.0 · oven-sh/bun](https://github.com/oven-sh/bun/releases)",
	"  What's Changed: bun install now resolves peer deps.",
	"- [Bun 1.3 is out](https://news.ycombinator.com/item?id=1)",
	"- [Bun 1.3 roundup](https://blog.test/roundup)",
].join("\n");

const PAGE_MARKDOWN = "# Bun v1.3.0\n\nBun 1.3 ships a built-in Postgres client.";

function viewFor(call: Parameters<typeof buildWebContextView>[0]): WebContextView {
	const view = buildWebContextView(call);
	expect(view).not.toBeNull();
	return view as WebContextView;
}

function renderSearch(output: string = SEARCH_MARKDOWN, duration: number | null = 1234) {
	return render(WebContextCard, {
		view: viewFor({
			cardType: WEB_SEARCH_CARD_TYPE,
			status: "complete",
			output,
			input: { query: "bun 1.3 release notes" },
			duration,
		}),
	});
}

function renderPage(url = "https://www.bun.sh/blog/bun-v1-3") {
	return render(WebContextCard, {
		view: viewFor({
			cardType: WEB_PAGE_CARD_TYPE,
			status: "complete",
			output: PAGE_MARKDOWN,
			input: { url },
			duration: 2800,
		}),
	});
}

describe("WebContextCard — search, collapsed", () => {
	test("discloses the query, the count and the domains without expanding", () => {
		const { getByTestId, getAllByTestId, queryAllByTestId } = renderSearch();
		expect(getByTestId("web-context-card")).toHaveAttribute("data-kind", "search");
		expect(getByTestId("web-context-query")).toHaveTextContent("bun 1.3 release notes");
		expect(getByTestId("web-context-count")).toHaveTextContent("4 sources");
		expect(getAllByTestId("web-context-host-chip").map((el) => el.textContent)).toEqual([
			"bun.sh",
			"github.com",
			"news.ycombinator.com",
		]);
		expect(getByTestId("web-context-host-more")).toHaveTextContent("+1");
		// The source list itself stays closed.
		expect(queryAllByTestId("web-context-source")).toHaveLength(0);
		expect(getByTestId("web-context-toggle")).toHaveAttribute("aria-expanded", "false");
	});

	test("shows the duration when the call reported one, and nothing when it did not", () => {
		expect(renderSearch(SEARCH_MARKDOWN, 1234).getByTestId("web-context-duration")).toHaveTextContent(
			"1.2s",
		);
		cleanup();
		expect(renderSearch(SEARCH_MARKDOWN, null).queryAllByTestId("web-context-duration")).toHaveLength(
			0,
		);
	});
});

describe("WebContextCard — search, expanded", () => {
	test("every source is a titled link with its host and snippet", async () => {
		const { getByTestId, getAllByTestId } = renderSearch();
		await fireEvent.click(getByTestId("web-context-toggle"));

		const sources = getAllByTestId("web-context-source");
		expect(sources).toHaveLength(4);
		expect(sources[0]).toHaveTextContent("1");
		expect(sources[0]).toHaveTextContent("bun.sh");

		const links = getAllByTestId("web-context-source-link");
		expect(links).toHaveLength(4);
		expect(links[0]).toHaveTextContent("Bun v1.3.0 — Release notes");
		expect(links[0]).toHaveAttribute("href", "https://bun.sh/blog/bun-v1-3");
		// target="_blank" without this rel would leak an opener handle.
		for (const link of links) {
			expect(link).toHaveAttribute("target", "_blank");
			expect(link).toHaveAttribute("rel", "noopener noreferrer");
		}

		expect(getAllByTestId("web-context-snippet")[0]).toHaveTextContent(
			"Bun 1.3 ships a built-in Postgres client.",
		);
		expect(getByTestId("web-context-toggle")).toHaveAttribute("aria-expanded", "true");
	});

	test("states that the text entered the context and offers a copy", async () => {
		const { getByTestId, getByLabelText } = renderSearch();
		await fireEvent.click(getByTestId("web-context-toggle"));
		expect(getByTestId("web-context-footer")).toHaveTextContent(
			"This text was added to the conversation context.",
		);
		expect(getByLabelText("Copy output")).toBeInTheDocument();
	});

	test("collapses again on a second click", async () => {
		const { getByTestId } = renderSearch();
		await fireEvent.click(getByTestId("web-context-toggle"));
		expect(getByTestId("web-context-toggle")).toHaveAttribute("aria-expanded", "true");
		await fireEvent.click(getByTestId("web-context-toggle"));
		expect(getByTestId("web-context-toggle")).toHaveAttribute("aria-expanded", "false");
		// The DOM removal itself is asserted in the browser
		// (web/e2e/web-search-source-card.spec.ts): jsdom has no
		// Element.animate, so Svelte's slide OUTRO never settles here and the
		// node would linger regardless of the component being correct.
	});

	test("a refused URL renders inert text plus the raw string, never an href", async () => {
		const { getByTestId, queryAllByTestId } = renderSearch(
			"- [Click me](javascript:alert(1))\n  totally safe promise",
		);
		await fireEvent.click(getByTestId("web-context-toggle"));
		expect(queryAllByTestId("web-context-source-link")).toHaveLength(0);
		expect(getByTestId("web-context-source-unlinked")).toHaveTextContent("Click me");
		expect(getByTestId("web-context-source-raw")).toHaveTextContent("javascript:alert(1)");
	});

	test("an empty result set says so instead of rendering a blank list", async () => {
		const { getByTestId, queryAllByTestId } = renderSearch(NO_RESULTS_MARKDOWN);
		expect(getByTestId("web-context-count")).toHaveTextContent("No results");
		await fireEvent.click(getByTestId("web-context-toggle"));
		expect(queryAllByTestId("web-context-source")).toHaveLength(0);
		expect(getByTestId("web-context-empty")).toHaveTextContent(
			"The search returned no results, so nothing was added to the context.",
		);
	});
});

describe("WebContextCard — fetched page", () => {
	test("names the page, its host and how much text was pulled in", () => {
		const { getByTestId } = renderPage();
		expect(getByTestId("web-context-card")).toHaveAttribute("data-kind", "page");
		expect(getByTestId("web-context-page-title")).toHaveTextContent("Bun v1.3.0");
		expect(getByTestId("web-context-host-chip")).toHaveTextContent("bun.sh");
		expect(getByTestId("web-context-count")).toHaveTextContent("pulled into context");
	});

	test("expands to the source link and the extracted markdown", async () => {
		const { getByTestId } = renderPage();
		await fireEvent.click(getByTestId("web-context-toggle"));
		const link = getByTestId("web-context-source-link");
		expect(link).toHaveAttribute("href", "https://www.bun.sh/blog/bun-v1-3");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
		expect(getByTestId("web-context-page-body")).toHaveTextContent(
			"Bun 1.3 ships a built-in Postgres client.",
		);
		expect(getByTestId("web-context-footer")).toBeInTheDocument();
	});

	test("a refused page URL is shown raw and unlinked", async () => {
		const { getByTestId, queryAllByTestId } = renderPage("javascript:alert(1)");
		await fireEvent.click(getByTestId("web-context-toggle"));
		expect(queryAllByTestId("web-context-source-link")).toHaveLength(0);
		expect(getByTestId("web-context-source-raw")).toHaveTextContent("javascript:alert(1)");
	});

	test("omits the URL row entirely when the call carried no url argument", async () => {
		const { getByTestId, queryAllByTestId } = render(WebContextCard, {
			view: viewFor({
				cardType: WEB_PAGE_CARD_TYPE,
				status: "complete",
				output: PAGE_MARKDOWN,
				input: {},
				duration: 100,
			}),
		});
		await fireEvent.click(getByTestId("web-context-toggle"));
		expect(queryAllByTestId("web-context-source-link")).toHaveLength(0);
		expect(queryAllByTestId("web-context-source-raw")).toHaveLength(0);
		expect(getByTestId("web-context-page-body")).toBeInTheDocument();
	});
});
