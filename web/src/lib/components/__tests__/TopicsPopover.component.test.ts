/**
 * DOM tests for TopicsPopover.svelte — the header Topics dropdown. Covers:
 * backdrop close, the Analyze/Refresh trigger + its label states, the stale
 * banner, both empty states, the topic list with type badges + row spinner +
 * in-flight guard, and the extract result panel (copied badge vs. manual Copy
 * fallback + library link) and the 503 error panel.
 */
import { describe, test, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import "@testing-library/jest-dom/vitest";
import TopicsPopover from "../chat/TopicsPopover.svelte";
import {
	type Topic,
	type SavedContext,
	type ExtractState,
	contextTypeMap,
	EXTRACT_IDLE,
	extractResolved,
	extractErrored,
} from "$lib/topic-contexts-logic";

const typeMap = contextTypeMap([
	{ id: "feature", label: "Feature", description: "", sortOrder: 0 },
	{ id: "bug-fix", label: "Bug fix", description: "", sortOrder: 1 },
]);

const topics: Topic[] = [
	{ id: "t1", label: "Auth flow", typeId: "feature", messageIds: ["m1"] },
	{ id: "t2", label: "Rate limiting", typeId: "bug-fix", messageIds: ["m2"] },
];

const sampleContext: SavedContext = {
	id: "ctx-1",
	topicLabel: "Auth flow",
	typeId: "feature",
	title: "Auth flow context",
	content: "# Auth\nJWT with refresh rotation.",
	model: "ollama/qwen3:1.7b",
	updatedAt: "2026-07-13T00:00:00.000Z",
};

function props(overrides: Record<string, unknown> = {}) {
	return {
		topics,
		stale: false,
		analyzedAt: "2026-07-13T00:00:00.000Z" as string | null,
		newCount: 0,
		analyzing: false,
		extractState: EXTRACT_IDLE as ExtractState,
		busyId: null as string | null,
		typeMap,
		onclose: vi.fn(),
		onanalyze: vi.fn(),
		onextract: vi.fn(),
		onmanualcopy: vi.fn(),
		...overrides,
	};
}

describe("TopicsPopover shell", () => {
	test("clicking the backdrop closes the popover", async () => {
		const onclose = vi.fn();
		const { getByTestId } = render(TopicsPopover, props({ onclose }));
		await fireEvent.click(getByTestId("topics-backdrop"));
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	test("never-analyzed shows the Analyze label + empty prompt", () => {
		const { getByTestId } = render(
			TopicsPopover,
			props({ analyzedAt: null, topics: [] }),
		);
		expect(getByTestId("topics-analyze-btn")).toHaveTextContent("Analyze");
		expect(getByTestId("topics-empty")).toHaveTextContent("click Analyze");
	});

	test("analyzed-but-empty shows the 'no topics detected' state", () => {
		const { getByTestId } = render(TopicsPopover, props({ topics: [] }));
		expect(getByTestId("topics-empty")).toHaveTextContent(
			"No topics were detected",
		);
	});

	test("clicking Analyze fires onanalyze", async () => {
		const onanalyze = vi.fn();
		const { getByTestId } = render(TopicsPopover, props({ onanalyze }));
		await fireEvent.click(getByTestId("topics-analyze-btn"));
		expect(onanalyze).toHaveBeenCalledTimes(1);
	});

	test("analyzing shows a spinner + disables the trigger", () => {
		const { getByTestId } = render(
			TopicsPopover,
			props({ analyzing: true, stale: true }),
		);
		expect(getByTestId("topics-analyze-btn")).toBeDisabled();
		expect(getByTestId("topics-analyze-spinner")).toBeInTheDocument();
		expect(getByTestId("topics-analyze-btn")).toHaveTextContent("Analyzing");
		// Stale banner is suppressed while analyzing.
		expect(document.querySelector('[data-testid="topics-stale-banner"]')).toBeNull();
	});

	test("stale shows the refresh banner + 'Refresh (N new)' label", () => {
		const { getByTestId } = render(
			TopicsPopover,
			props({ stale: true, newCount: 3 }),
		);
		expect(getByTestId("topics-analyze-btn")).toHaveTextContent(
			"Refresh (3 new)",
		);
		expect(getByTestId("topics-stale-banner")).toBeInTheDocument();
	});

	test("a detection 503 renders the analyze-error banner (over the stale one)", () => {
		const { getByTestId, queryByTestId } = render(
			TopicsPopover,
			props({ stale: true, analyzeError: "Model unavailable" }),
		);
		expect(getByTestId("topics-analyze-error")).toHaveTextContent(
			"Model unavailable",
		);
		expect(queryByTestId("topics-stale-banner")).toBeNull();
	});
});

describe("TopicsPopover topic list", () => {
	test("renders a row + type badge per topic", () => {
		const { getByTestId, getAllByTestId } = render(TopicsPopover, props());
		expect(getByTestId("topic-pill-t1")).toHaveTextContent("Auth flow");
		expect(getByTestId("topic-pill-t2")).toHaveTextContent("Rate limiting");
		const badges = getAllByTestId("topic-type-badge").map((b) => b.textContent?.trim());
		expect(badges).toEqual(["Feature", "Bug fix"]);
	});

	test("clicking a topic row fires onextract with its id", async () => {
		const onextract = vi.fn();
		const { getByTestId } = render(TopicsPopover, props({ onextract }));
		await fireEvent.click(getByTestId("topic-pill-t2"));
		expect(onextract).toHaveBeenCalledWith("t2");
	});

	test("in-flight row shows a spinner + guards further clicks", async () => {
		const onextract = vi.fn();
		const { getByTestId } = render(
			TopicsPopover,
			props({ busyId: "t1", onextract }),
		);
		expect(getByTestId("topic-row-spinner")).toBeInTheDocument();
		await fireEvent.click(getByTestId("topic-pill-t2"));
		expect(onextract).not.toHaveBeenCalled();
	});
});

describe("TopicsPopover extract result", () => {
	test("copied → content preview + copied badge, no Copy button", () => {
		const { getByTestId, queryByTestId } = render(
			TopicsPopover,
			props({ extractState: extractResolved(sampleContext, true) }),
		);
		const panel = getByTestId("topic-extract-result");
		expect(panel).toHaveTextContent("Auth flow context");
		expect(panel).toHaveTextContent("JWT with refresh rotation");
		expect(getByTestId("topic-copied-badge")).toBeInTheDocument();
		expect(queryByTestId("topic-copy-btn")).toBeNull();
	});

	test("copyFailed → manual Copy button fires onmanualcopy with the content", async () => {
		const onmanualcopy = vi.fn();
		const { getByTestId, queryByTestId } = render(
			TopicsPopover,
			props({
				extractState: extractResolved(sampleContext, false),
				onmanualcopy,
			}),
		);
		expect(queryByTestId("topic-copied-badge")).toBeNull();
		await fireEvent.click(getByTestId("topic-copy-btn"));
		expect(onmanualcopy).toHaveBeenCalledWith(sampleContext.content);
	});

	test("error state renders the 503 message", () => {
		const { getByTestId } = render(
			TopicsPopover,
			props({ extractState: extractErrored("Model unavailable") }),
		);
		expect(getByTestId("topic-extract-error")).toHaveTextContent(
			"Model unavailable",
		);
	});
});

describe("TopicsPopover capability notice", () => {
	test("no capability → neither notice renders", () => {
		const { queryByTestId } = render(TopicsPopover, props({ capability: null }));
		expect(queryByTestId("topics-unsupported-notice")).toBeNull();
		expect(queryByTestId("topics-fallback-note")).toBeNull();
	});

	test("supported capability → no notice", () => {
		const { queryByTestId } = render(
			TopicsPopover,
			props({ capability: { localModel: "qwen3.5:4b", supported: true, activeLane: "local" } }),
		);
		expect(queryByTestId("topics-unsupported-notice")).toBeNull();
		expect(queryByTestId("topics-fallback-note")).toBeNull();
	});

	test("unsupported + no fallback → prominent notice with model + reason", () => {
		const { getByTestId, queryByTestId } = render(
			TopicsPopover,
			props({
				capability: { localModel: "qwen3.5:4b", supported: false, reason: "load-failed", activeLane: "local" },
			}),
		);
		const notice = getByTestId("topics-unsupported-notice");
		expect(notice).toHaveTextContent("qwen3.5:4b");
		expect(notice).toHaveTextContent("couldn't load it");
		expect(queryByTestId("topics-fallback-note")).toBeNull();
	});

	test("unsupported + fallback lane → subtle note only", () => {
		const { getByTestId, queryByTestId } = render(
			TopicsPopover,
			props({
				capability: { localModel: "qwen3.5:4b", supported: false, reason: "timeout", activeLane: "turn-model" },
			}),
		);
		expect(getByTestId("topics-fallback-note")).toHaveTextContent("using the chat model");
		expect(queryByTestId("topics-unsupported-notice")).toBeNull();
	});
});
