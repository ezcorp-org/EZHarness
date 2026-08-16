/**
 * Pure logic for WebContextCard — the source-disclosure card behind the
 * bundled `web-search` extension's two tools.
 *
 * WHY IT PARSES INSTEAD OF READING A STRUCTURED ENVELOPE: `search-web`
 * and `read-url` hand the LLM plain markdown (`src/search/markdown.ts`
 * `formatResults`, and the reader's own markdown). That text IS the
 * context the model received, so the card reconstructs its view from the
 * PERSISTED output rather than from a side channel. Two consequences
 * that are the point, not a compromise:
 *   - what the model sees stays byte-identical — no envelope, no
 *     provenance line, no re-prompting risk;
 *   - every historical tool_call row renders richly with no migration.
 *
 * The search shape is fixed by `formatResults`:
 *
 *     - [title](https://example.com/a)
 *       snippet text
 *     - [title 2](https://example.com/b)
 *
 * with `_No results._` for the empty case. Snippet lines are indented,
 * but a snippet containing a newline loses that indent on its 2nd line,
 * so continuation is defined as "any line until the next bullet" rather
 * than "any indented line".
 *
 * Everything derives here rather than in the `.svelte` file so the
 * link-safety rule below is unit-testable without a renderer.
 *
 * SECURITY: both the URLs and the page body come from an LLM-supplied
 * query or URL. `safeUrl` allows ONLY `http:`/`https:`, so a
 * `javascript:` or `data:` target never reaches an `href` — it degrades
 * to unlinked text that still shows the raw string, because hiding a
 * hostile URL would be worse disclosure than showing it inert.
 */

/** The card types this module builds a view for (see `KNOWN_CARD_TYPES`). */
export const WEB_SEARCH_CARD_TYPE = "web-search";
export const WEB_PAGE_CARD_TYPE = "web-page";

/** Hosts shown as chips in the collapsed header before "+N". */
export const HOST_CHIP_LIMIT = 3;

/** Rendered when `formatResults` found nothing. */
export const NO_RESULTS_MARKDOWN = "_No results._";

export interface WebSource {
	/** 1-based rank, exactly the order the model received. */
	rank: number;
	title: string;
	/** "" when the URL was absent or not http(s) — never an unsafe href. */
	href: string;
	/** The verbatim URL string, shown even when `href` is "". */
	rawUrl: string;
	/** "bun.sh" — `www.` stripped; "" when the URL is unusable. */
	host: string;
	snippet: string;
}

export interface WebSearchView {
	kind: "search";
	query: string;
	sources: WebSource[];
	sourceCount: number;
	/** "5 sources" / "1 source" / "No results". */
	countText: string;
	/** Distinct hosts for the collapsed header, capped at HOST_CHIP_LIMIT. */
	hostChips: string[];
	/** Hosts beyond the chip limit — 0 renders no "+N". */
	extraHostCount: number;
	empty: boolean;
	/** The verbatim tool output: what actually entered the model's context. */
	raw: string;
	durationText: string;
}

export interface WebPageView {
	kind: "page";
	/** "" when the URL is absent or not http(s). */
	href: string;
	rawUrl: string;
	host: string;
	/** First markdown heading, else the host, else the URL. */
	title: string;
	markdown: string;
	charCount: number;
	/** "18.4k chars" / "412 chars". */
	charText: string;
	raw: string;
	durationText: string;
}

export type WebContextView = WebSearchView | WebPageView;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The tool output as a string — `null` when there is nothing to show. */
export function outputText(output: unknown): string | null {
	if (output == null) return null;
	const text = typeof output === "string" ? output : JSON.stringify(output);
	return text.trim() === "" ? null : text;
}

/**
 * An href the card may safely put in an anchor, or "" if it may not.
 *
 * Only `http:`/`https:` pass. Anything else — `javascript:`, `data:`,
 * a relative path, a malformed string — returns "" and the caller
 * renders inert text instead.
 */
export function safeUrl(raw: unknown): string {
	if (typeof raw !== "string" || raw.trim() === "") return "";
	try {
		const parsed = new URL(raw.trim());
		return parsed.protocol === "http:" || parsed.protocol === "https:"
			? parsed.href
			: "";
	} catch {
		return "";
	}
}

/** "bun.sh" from "https://www.bun.sh/blog"; "" when unusable. */
export function hostOf(raw: unknown): string {
	const safe = safeUrl(raw);
	if (safe === "") return "";
	return new URL(safe).hostname.replace(/^www\./, "");
}

/** "1.2s" for a completed call; "" when the duration is unknown. */
export function formatDurationText(duration: unknown): string {
	if (typeof duration !== "number" || !Number.isFinite(duration)) return "";
	return `${(duration / 1000).toFixed(1)}s`;
}

/** "18.4k chars" past a thousand, "412 chars" below it. */
export function formatCharCount(n: number): string {
	if (n < 1000) return `${n} char${n === 1 ? "" : "s"}`;
	return `${(n / 1000).toFixed(1)}k chars`;
}

/** "5 sources" / "1 source" / "No results". */
export function formatSourceCount(n: number): string {
	if (n === 0) return "No results";
	return `${n} source${n === 1 ? "" : "s"}`;
}

/**
 * Parse `formatResults` output into ranked sources.
 *
 * The title capture is greedy so a title containing `]` still binds to
 * the LAST `](` — `- [Bun [v1.3]](https://bun.sh)` keeps its brackets.
 */
export function parseSearchMarkdown(raw: string): WebSource[] {
	const sources: WebSource[] = [];
	if (raw.trim() === NO_RESULTS_MARKDOWN) return sources;

	// Continuation lines append to the LAST bullet, so a multi-line
	// snippet is not dropped when its 2nd line loses the indent.
	for (const line of raw.split("\n")) {
		const bullet = line.match(/^\s*-\s+\[(.+)\]\((\S+)\)\s*$/);
		if (bullet) {
			const rawUrl = bullet[2] as string;
			sources.push({
				rank: sources.length + 1,
				title: (bullet[1] as string).trim(),
				href: safeUrl(rawUrl),
				rawUrl,
				host: hostOf(rawUrl),
				snippet: "",
			});
			continue;
		}
		const text = line.trim();
		if (text === "") continue;
		const last = sources[sources.length - 1];
		// Text before the first bullet is preamble, not a snippet.
		if (!last) continue;
		last.snippet = last.snippet === "" ? text : `${last.snippet} ${text}`;
	}
	return sources;
}

/** Distinct hosts in rank order, split into chips + a remainder count. */
export function hostChipsOf(sources: readonly WebSource[]): {
	hostChips: string[];
	extraHostCount: number;
} {
	const distinct: string[] = [];
	for (const source of sources) {
		if (source.host !== "" && !distinct.includes(source.host)) {
			distinct.push(source.host);
		}
	}
	return {
		hostChips: distinct.slice(0, HOST_CHIP_LIMIT),
		extraHostCount: Math.max(0, distinct.length - HOST_CHIP_LIMIT),
	};
}

/** The first markdown heading in the page body, or "" if it has none. */
export function firstHeading(markdown: string): string {
	for (const line of markdown.split("\n")) {
		const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
		if (heading) {
			const text = (heading[1] as string).trim();
			if (text !== "") return text;
		}
	}
	return "";
}

/** The tool call's `query` argument, trimmed; "" when absent. */
function inputString(input: unknown, key: string): string {
	if (!isRecord(input)) return "";
	const value = input[key];
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the card's view model from a tool call.
 *
 * Returns `null` when the call is not renderable as a disclosure card —
 * still running, failed, or carrying no output. The router then falls
 * through to `DefaultCard`, which owns the spinner and the failure
 * treatment, so a streaming search never flashes an empty sources card.
 * (Same degradation contract as `buildCityConditionsView` and the
 * `ez-*` parsers.)
 */
export function buildWebContextView(call: {
	cardType?: string | undefined;
	status?: string | undefined;
	output?: unknown;
	input?: unknown;
	duration?: number | null | undefined;
}): WebContextView | null {
	if (call.cardType !== WEB_SEARCH_CARD_TYPE && call.cardType !== WEB_PAGE_CARD_TYPE) {
		return null;
	}
	if (call.status !== "complete") return null;
	const raw = outputText(call.output);
	if (raw === null) return null;
	const durationText = formatDurationText(call.duration);

	if (call.cardType === WEB_PAGE_CARD_TYPE) {
		const rawUrl = inputString(call.input, "url");
		const href = safeUrl(rawUrl);
		const host = hostOf(rawUrl);
		const heading = firstHeading(raw);
		return {
			kind: "page",
			href,
			rawUrl,
			host,
			title: heading || host || rawUrl || "Fetched page",
			markdown: raw,
			charCount: raw.length,
			charText: formatCharCount(raw.length),
			raw,
			durationText,
		};
	}

	const sources = parseSearchMarkdown(raw);
	const { hostChips, extraHostCount } = hostChipsOf(sources);
	return {
		kind: "search",
		query: inputString(call.input, "query"),
		sources,
		sourceCount: sources.length,
		countText: formatSourceCount(sources.length),
		hostChips,
		extraHostCount,
		empty: sources.length === 0,
		raw,
		durationText,
	};
}
