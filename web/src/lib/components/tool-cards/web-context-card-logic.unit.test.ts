/**
 * Unit tests for web-context-card-logic.
 *
 * The rules worth pinning here are the ones a renderer test could not
 * prove cheaply:
 *   - the parser round-trips REAL `formatResults` output (the fixture
 *     below is byte-for-byte what `src/search/markdown.ts` emits);
 *   - an LLM-supplied `javascript:` URL never yields an href — it
 *     degrades to inert text that still shows the raw string;
 *   - a running / failed / empty call returns null so the router can
 *     fall through to DefaultCard instead of showing an empty card;
 *   - `_No results._` is a real state ("nothing entered the context"),
 *     not a parse failure.
 */
import { describe, expect, test } from "vitest";
import {
	buildWebContextView,
	firstHeading,
	formatCharCount,
	formatDurationText,
	formatSourceCount,
	hostChipsOf,
	hostOf,
	NO_RESULTS_MARKDOWN,
	outputText,
	parseSearchMarkdown,
	safeUrl,
	WEB_PAGE_CARD_TYPE,
	WEB_SEARCH_CARD_TYPE,
	type WebPageView,
	type WebSearchView,
} from "./web-context-card-logic.js";

/** Exactly the shape `formatResults` renders (bullet + indented snippet). */
const SEARCH_MARKDOWN = [
	"- [Bun v1.3.0 — Release notes](https://bun.sh/blog/bun-v1-3)",
	"  Bun 1.3 ships a built-in Postgres client and a rewritten installer.",
	"- [Release v1.3.0 · oven-sh/bun](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.0)",
	"  What's Changed: bun install now resolves peer deps.",
	"- [Bun 1.3 is out](https://news.ycombinator.com/item?id=1)",
	"  Discussion thread with 240 comments.",
].join("\n");

function searchView(overrides: Partial<Parameters<typeof buildWebContextView>[0]> = {}): WebSearchView {
	const view = buildWebContextView({
		cardType: WEB_SEARCH_CARD_TYPE,
		status: "complete",
		output: SEARCH_MARKDOWN,
		input: { query: "bun 1.3 release notes" },
		duration: 1234,
		...overrides,
	});
	expect(view?.kind).toBe("search");
	return view as WebSearchView;
}

describe("safeUrl — the link-safety boundary", () => {
	test("passes http and https through, normalised", () => {
		expect(safeUrl("https://bun.sh/blog")).toBe("https://bun.sh/blog");
		expect(safeUrl("  http://example.com  ")).toBe("http://example.com/");
	});

	test("refuses every other scheme", () => {
		expect(safeUrl("javascript:alert(1)")).toBe("");
		expect(safeUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe("");
		expect(safeUrl("file:///etc/passwd")).toBe("");
	});

	test("refuses malformed, relative, empty and non-string input", () => {
		expect(safeUrl("not a url")).toBe("");
		expect(safeUrl("/relative/path")).toBe("");
		expect(safeUrl("   ")).toBe("");
		expect(safeUrl(undefined)).toBe("");
		expect(safeUrl(42)).toBe("");
	});
});

describe("hostOf", () => {
	test("strips the www prefix", () => {
		expect(hostOf("https://www.bun.sh/blog")).toBe("bun.sh");
	});

	test("keeps other subdomains", () => {
		expect(hostOf("https://news.ycombinator.com/item?id=1")).toBe("news.ycombinator.com");
	});

	test("is empty for a URL the safety check refused", () => {
		expect(hostOf("javascript:alert(1)")).toBe("");
	});
});

describe("formatters", () => {
	test("duration renders one decimal, or nothing when unknown", () => {
		expect(formatDurationText(1234)).toBe("1.2s");
		expect(formatDurationText(null)).toBe("");
		expect(formatDurationText(Number.NaN)).toBe("");
	});

	test("char counts switch to k past a thousand", () => {
		expect(formatCharCount(1)).toBe("1 char");
		expect(formatCharCount(412)).toBe("412 chars");
		expect(formatCharCount(18_432)).toBe("18.4k chars");
	});

	test("source counts are singular, plural, or an explicit zero state", () => {
		expect(formatSourceCount(0)).toBe("No results");
		expect(formatSourceCount(1)).toBe("1 source");
		expect(formatSourceCount(5)).toBe("5 sources");
	});
});

describe("outputText", () => {
	test("returns a plain string unchanged", () => {
		expect(outputText("hello")).toBe("hello");
	});

	test("serialises a non-string output", () => {
		expect(outputText({ a: 1 })).toBe('{"a":1}');
	});

	test("is null for nullish or blank output", () => {
		expect(outputText(null)).toBeNull();
		expect(outputText(undefined)).toBeNull();
		expect(outputText("   \n ")).toBeNull();
	});
});

describe("parseSearchMarkdown", () => {
	test("parses real formatResults output into ranked sources", () => {
		const sources = parseSearchMarkdown(SEARCH_MARKDOWN);
		expect(sources).toHaveLength(3);
		expect(sources[0]).toEqual({
			rank: 1,
			title: "Bun v1.3.0 — Release notes",
			href: "https://bun.sh/blog/bun-v1-3",
			rawUrl: "https://bun.sh/blog/bun-v1-3",
			host: "bun.sh",
			snippet: "Bun 1.3 ships a built-in Postgres client and a rewritten installer.",
		});
		expect(sources[2]?.rank).toBe(3);
		expect(sources[2]?.host).toBe("news.ycombinator.com");
	});

	test("keeps brackets inside a title (greedy title capture)", () => {
		const sources = parseSearchMarkdown("- [Bun [v1.3] notes](https://bun.sh)");
		expect(sources[0]?.title).toBe("Bun [v1.3] notes");
		expect(sources[0]?.href).toBe("https://bun.sh/");
	});

	test("joins a snippet that lost its indent on the second line", () => {
		const sources = parseSearchMarkdown(
			["- [T](https://a.test)", "  first line", "second line", "", "- [U](https://b.test)"].join("\n"),
		);
		expect(sources[0]?.snippet).toBe("first line second line");
		expect(sources[1]?.snippet).toBe("");
	});

	test("ignores text before the first bullet", () => {
		const sources = parseSearchMarkdown(["stray preamble", "- [T](https://a.test)"].join("\n"));
		expect(sources).toHaveLength(1);
		expect(sources[0]?.snippet).toBe("");
	});

	test("keeps an unsafe URL visible but unlinked", () => {
		const sources = parseSearchMarkdown("- [Click me](javascript:alert(1))");
		expect(sources[0]).toMatchObject({
			title: "Click me",
			href: "",
			rawUrl: "javascript:alert(1)",
			host: "",
		});
	});

	test("returns nothing for the explicit no-results marker", () => {
		expect(parseSearchMarkdown(NO_RESULTS_MARKDOWN)).toEqual([]);
		expect(parseSearchMarkdown(`\n${NO_RESULTS_MARKDOWN}\n`)).toEqual([]);
	});
});

describe("hostChipsOf", () => {
	test("dedupes hosts, caps the chips, and counts the remainder", () => {
		const sources = parseSearchMarkdown(
			[
				"- [a](https://a.test)",
				"- [b](https://b.test)",
				"- [b2](https://b.test/other)",
				"- [c](https://c.test)",
				"- [d](https://d.test)",
				"- [e](https://e.test)",
			].join("\n"),
		);
		expect(hostChipsOf(sources)).toEqual({
			hostChips: ["a.test", "b.test", "c.test"],
			extraHostCount: 2,
		});
	});

	test("skips sources whose URL was refused", () => {
		const sources = parseSearchMarkdown(
			["- [a](https://a.test)", "- [bad](javascript:alert(1))"].join("\n"),
		);
		expect(hostChipsOf(sources)).toEqual({ hostChips: ["a.test"], extraHostCount: 0 });
	});
});

describe("firstHeading", () => {
	test("finds the first heading and drops closing hashes", () => {
		expect(firstHeading("intro\n\n## Bun v1.3.0 ##\n\n# Later")).toBe("Bun v1.3.0");
	});

	test("skips a heading whose text is only whitespace", () => {
		expect(firstHeading("#  \n# Real title")).toBe("Real title");
	});

	test("is empty when the page has no heading", () => {
		expect(firstHeading("just a paragraph\nand another")).toBe("");
	});
});

describe("buildWebContextView — search", () => {
	test("builds the disclosure view from the persisted markdown", () => {
		const view = searchView();
		expect(view.query).toBe("bun 1.3 release notes");
		expect(view.sourceCount).toBe(3);
		expect(view.countText).toBe("3 sources");
		expect(view.hostChips).toEqual(["bun.sh", "github.com", "news.ycombinator.com"]);
		expect(view.extraHostCount).toBe(0);
		expect(view.empty).toBe(false);
		expect(view.durationText).toBe("1.2s");
		// The raw text is the context the model received, verbatim.
		expect(view.raw).toBe(SEARCH_MARKDOWN);
	});

	test("an empty result set is an explicit state, not a null view", () => {
		const view = searchView({ output: NO_RESULTS_MARKDOWN });
		expect(view.empty).toBe(true);
		expect(view.countText).toBe("No results");
		expect(view.sources).toEqual([]);
	});

	test("a missing or non-object input leaves the query blank", () => {
		expect(searchView({ input: undefined }).query).toBe("");
		expect(searchView({ input: "not an object" }).query).toBe("");
		expect(searchView({ input: { query: 42 } }).query).toBe("");
	});
});

describe("buildWebContextView — page", () => {
	const PAGE_MARKDOWN = "# Bun v1.3.0\n\nBun 1.3 ships a built-in Postgres client.";

	function pageView(overrides: Partial<Parameters<typeof buildWebContextView>[0]> = {}): WebPageView {
		const view = buildWebContextView({
			cardType: WEB_PAGE_CARD_TYPE,
			status: "complete",
			output: PAGE_MARKDOWN,
			input: { url: "https://www.bun.sh/blog/bun-v1-3" },
			duration: 2800,
			...overrides,
		});
		expect(view?.kind).toBe("page");
		return view as WebPageView;
	}

	test("titles the card from the first heading and discloses the size", () => {
		const view = pageView();
		expect(view.title).toBe("Bun v1.3.0");
		expect(view.host).toBe("bun.sh");
		expect(view.href).toBe("https://www.bun.sh/blog/bun-v1-3");
		expect(view.charCount).toBe(PAGE_MARKDOWN.length);
		expect(view.charText).toBe(`${PAGE_MARKDOWN.length} chars`);
		expect(view.durationText).toBe("2.8s");
		expect(view.markdown).toBe(PAGE_MARKDOWN);
	});

	test("falls back to the host, then the raw URL, then a generic title", () => {
		expect(pageView({ output: "no heading here" }).title).toBe("bun.sh");
		expect(
			pageView({ output: "no heading here", input: { url: "ftp://files.test/x" } }).title,
		).toBe("ftp://files.test/x");
		expect(pageView({ output: "no heading here", input: {} }).title).toBe("Fetched page");
	});

	test("refuses to link a non-http URL but still shows it", () => {
		const view = pageView({ input: { url: "javascript:alert(1)" } });
		expect(view.href).toBe("");
		expect(view.rawUrl).toBe("javascript:alert(1)");
		expect(view.host).toBe("");
	});
});

describe("buildWebContextView — degradation to DefaultCard", () => {
	test("is null for a card type this module does not own", () => {
		expect(buildWebContextView({ cardType: "terminal", status: "complete", output: "x" })).toBeNull();
		expect(buildWebContextView({ status: "complete", output: "x" })).toBeNull();
	});

	test("is null while the call is running or after it failed", () => {
		expect(
			buildWebContextView({ cardType: WEB_SEARCH_CARD_TYPE, status: "running", output: null }),
		).toBeNull();
		expect(
			buildWebContextView({
				cardType: WEB_SEARCH_CARD_TYPE,
				status: "error",
				output: "Search failed: quota exceeded",
			}),
		).toBeNull();
	});

	test("is null when a completed call carried no output", () => {
		expect(
			buildWebContextView({ cardType: WEB_PAGE_CARD_TYPE, status: "complete", output: "  " }),
		).toBeNull();
	});
});
