/**
 * DOM tests for ChatHeader.svelte — covers the double-click-to-rename
 * affordance on the conversation title, plus the loaded-tools badge and
 * popover (count, grouping, type badges, token sums — all derived
 * in-component from the single `loadedTools` prop; the page passes
 * `chrome.loadedTools` and nothing else. Regression pin for the
 * "loaded tools always shows 0" bug where the page hardcoded `[]`).
 *
 * Display mode renders a <span data-testid="chat-title">. Double-clicking
 * swaps it for an inline edit form with Save / Cancel buttons. Clicking
 * Save calls `onrename` with the trimmed value and exits edit mode.
 * Empty/whitespace and unchanged titles do NOT call `onrename`. Escape
 * and Cancel both exit without saving.
 */

import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import ChatHeader from "../ChatHeader.svelte";
import type { Conversation } from "$lib/api.js";
import {
	type Topic,
	type SavedContext,
	EXTRACT_IDLE,
	extractResolved,
	contextTypeMap,
} from "$lib/topic-contexts-logic";

function topicsChrome(overrides: Record<string, unknown> = {}) {
	return {
		list: [] as Topic[],
		stale: false,
		analyzedAt: null as string | null,
		newCount: 0,
		analyzing: false,
		analyzeError: null as string | null,
		open: false,
		extractState: EXTRACT_IDLE,
		busyId: null as string | null,
		typeMap: contextTypeMap([]),
		toggle: vi.fn(),
		onanalyze: vi.fn(),
		onextract: vi.fn(),
		onmanualcopy: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	// PermissionModeIndicator + ExportMenu fire fetches on mount; stub so
	// jsdom doesn't surface unhandled rejections during the title tests.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
	);
});

const baseConversation: Conversation = {
	id: "conv-1",
	projectId: "proj-1",
	title: "Original Title",
	model: null,
	provider: null,
	systemPrompt: null,
	agentConfigId: null,
	modeId: null,
	test: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

function defaultProps(overrides: Record<string, unknown> = {}) {
	return {
		projectId: "proj-1",
		convId: "conv-1",
		currentConversation: baseConversation,
		lastTurnInputTokens: null,
		selectedModelContextWindow: null,
		contextBreakdown: null,
		contextToolBreakdown: [],
		loadedTools: [],
		toolsOpen: false,
		diffPanelOpen: false,
		diffFileCount: 0,
		activeLeafId: null,
		showObsButton: false,
		obsOpen: false,
		selectMode: false,
		isStreaming: false,
		topics: topicsChrome(),
		onmobilemenu: vi.fn(),
		ontoolstoggle: vi.fn(),
		ondifftoggle: vi.fn(),
		onobstoggle: vi.fn(),
		onselecttoggle: vi.fn(),
		onsettingstoggle: vi.fn(),
		onpermissionmodechange: vi.fn(),
		oncallclick: vi.fn(),
		onrename: vi.fn(async () => {}),
		...overrides,
	};
}

describe("ChatHeader title rename", () => {
	test("renders the conversation title in display mode", () => {
		const { getByTestId, queryByTestId } = render(ChatHeader, defaultProps());
		expect(getByTestId("chat-title")).toHaveTextContent("Original Title");
		expect(queryByTestId("chat-title-input")).toBeNull();
	});

	test("double-clicking the title enters edit mode with the title pre-filled", async () => {
		const { getByTestId, queryByTestId } = render(ChatHeader, defaultProps());
		await fireEvent.dblClick(getByTestId("chat-title"));
		const input = getByTestId("chat-title-input") as HTMLInputElement;
		expect(input).toBeInTheDocument();
		expect(input.value).toBe("Original Title");
		// Display span is gone while editing.
		expect(queryByTestId("chat-title")).toBeNull();
	});

	test("clicking Save calls onrename with the trimmed value and exits edit mode", async () => {
		const onrename = vi.fn(async () => {});
		const { getByTestId, queryByTestId } = render(ChatHeader, defaultProps({ onrename }));
		await fireEvent.dblClick(getByTestId("chat-title"));
		const input = getByTestId("chat-title-input") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "  Renamed Title  " } });
		await fireEvent.click(getByTestId("chat-title-save"));
		// Wait a microtask so the awaited onrename + state flip flush.
		await Promise.resolve();
		await Promise.resolve();
		expect(onrename).toHaveBeenCalledTimes(1);
		expect(onrename).toHaveBeenCalledWith("Renamed Title");
		expect(queryByTestId("chat-title-input")).toBeNull();
	});

	test("empty / whitespace-only title does NOT call onrename", async () => {
		const onrename = vi.fn(async () => {});
		const { getByTestId, queryByTestId } = render(ChatHeader, defaultProps({ onrename }));
		await fireEvent.dblClick(getByTestId("chat-title"));
		const input = getByTestId("chat-title-input") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "   " } });
		await fireEvent.click(getByTestId("chat-title-save"));
		await Promise.resolve();
		expect(onrename).not.toHaveBeenCalled();
		expect(queryByTestId("chat-title-input")).toBeNull();
	});

	test("unchanged title does NOT call onrename", async () => {
		const onrename = vi.fn(async () => {});
		const { getByTestId, queryByTestId } = render(ChatHeader, defaultProps({ onrename }));
		await fireEvent.dblClick(getByTestId("chat-title"));
		await fireEvent.click(getByTestId("chat-title-save"));
		await Promise.resolve();
		expect(onrename).not.toHaveBeenCalled();
		expect(queryByTestId("chat-title-input")).toBeNull();
	});

	test("Escape key cancels edit mode without calling onrename", async () => {
		const onrename = vi.fn(async () => {});
		const { getByTestId, queryByTestId } = render(ChatHeader, defaultProps({ onrename }));
		await fireEvent.dblClick(getByTestId("chat-title"));
		const input = getByTestId("chat-title-input") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "Discard me" } });
		await fireEvent.keyDown(input, { key: "Escape" });
		expect(onrename).not.toHaveBeenCalled();
		expect(queryByTestId("chat-title-input")).toBeNull();
		expect(getByTestId("chat-title")).toHaveTextContent("Original Title");
	});

	test("Cancel button exits edit mode without calling onrename", async () => {
		const onrename = vi.fn(async () => {});
		const { getByTestId, queryByTestId } = render(ChatHeader, defaultProps({ onrename }));
		await fireEvent.dblClick(getByTestId("chat-title"));
		const input = getByTestId("chat-title-input") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "Throw away" } });
		await fireEvent.click(getByTestId("chat-title-cancel"));
		expect(onrename).not.toHaveBeenCalled();
		expect(queryByTestId("chat-title-input")).toBeNull();
		expect(getByTestId("chat-title")).toHaveTextContent("Original Title");
	});
});

const sampleTools = [
	{ name: "scan", description: "Scan code", extension: "analyzer", extensionType: "extension", extensionDescription: "Static analysis helpers", tokenEstimate: 25 },
	{ name: "lint", description: "Lint files", extension: "analyzer", extensionType: "extension", extensionDescription: "Static analysis helpers", tokenEstimate: 22 },
	{ name: "summarize", description: "Summarize text", extension: "markdown-utils", extensionType: "mcp", tokenEstimate: 30 },
];

describe("ChatHeader loaded-tools badge + popover", () => {
	function toolButton(container: HTMLElement) {
		return container.querySelector('button[aria-label^="Loaded tools"]') as HTMLButtonElement;
	}

	test("badge shows the loadedTools count (not 0)", () => {
		const { container } = render(ChatHeader, defaultProps({ loadedTools: sampleTools }));
		expect(toolButton(container)).toHaveTextContent("3");
	});

	test("badge shows 0 and popover shows empty state with no tools", () => {
		const { container, getByTestId, getByText } = render(
			ChatHeader,
			defaultProps({ loadedTools: [], toolsOpen: true }),
		);
		expect(toolButton(container)).toHaveTextContent("0");
		expect(getByTestId("tools-popover")).toBeInTheDocument();
		expect(getByText("No tools loaded")).toBeInTheDocument();
	});

	test("popover groups tools by extension with type badges (derived in-component)", () => {
		const { getByTestId, getByText } = render(
			ChatHeader,
			defaultProps({ loadedTools: sampleTools, toolsOpen: true }),
		);
		const popover = getByTestId("tools-popover");
		expect(popover).toBeInTheDocument();
		// Group headers + member tools
		expect(getByText("analyzer")).toBeInTheDocument();
		expect(getByText("markdown-utils")).toBeInTheDocument();
		expect(getByText("scan", { exact: false })).toBeInTheDocument();
		expect(getByText("lint", { exact: false })).toBeInTheDocument();
		expect(getByText("summarize", { exact: false })).toBeInTheDocument();
		// Type badges derived from extensionType
		const badges = [...popover.querySelectorAll('[data-testid="type-badge"]')];
		expect(badges.map((b) => b.textContent).sort()).toEqual(["extension", "mcp"]);
	});

	test("popover shows per-group and grand-total token sums", () => {
		const { getByTestId, getByText } = render(
			ChatHeader,
			defaultProps({ loadedTools: sampleTools, toolsOpen: true }),
		);
		expect(getByTestId("tools-popover")).toBeInTheDocument();
		// analyzer group: 25 + 22 = 47; grand total: 77
		expect(getByText("47")).toBeInTheDocument();
		expect(getByText("77")).toBeInTheDocument();
	});

	test("hovering a tool row shows a tooltip with the tool name + description", async () => {
		const { getByTestId, getAllByTestId, getByRole } = render(
			ChatHeader,
			defaultProps({ loadedTools: sampleTools, toolsOpen: true }),
		);
		expect(getByTestId("tools-popover")).toBeInTheDocument();
		const scanRow = getAllByTestId("tool-row").find((r) => r.textContent?.includes("scan"))!;
		// Tooltip listens on its wrapper span (mouseenter does not bubble).
		await fireEvent.mouseEnter(scanRow.parentElement!);
		await waitFor(() => {
			const tip = getByRole("tooltip");
			expect(tip).toHaveTextContent("scan");
			expect(tip).toHaveTextContent("Scan code");
		});
	});

	test("hovering an extension group header shows the extension's description", async () => {
		const { getByTestId, getAllByTestId, getByRole } = render(
			ChatHeader,
			defaultProps({ loadedTools: sampleTools, toolsOpen: true }),
		);
		expect(getByTestId("tools-popover")).toBeInTheDocument();
		const analyzerHeader = getAllByTestId("ext-group-header").find((h) =>
			h.textContent?.includes("analyzer"),
		)!;
		await fireEvent.mouseEnter(analyzerHeader.parentElement!);
		await waitFor(() => {
			const tip = getByRole("tooltip");
			expect(tip).toHaveTextContent("analyzer");
			expect(tip).toHaveTextContent("Static analysis helpers");
		});
	});

	test("an extension without a description shows the fallback on group-header hover", async () => {
		const { getByTestId, getAllByTestId, getByRole } = render(
			ChatHeader,
			defaultProps({ loadedTools: sampleTools, toolsOpen: true }),
		);
		expect(getByTestId("tools-popover")).toBeInTheDocument();
		// markdown-utils rows carry no extensionDescription.
		const mdHeader = getAllByTestId("ext-group-header").find((h) =>
			h.textContent?.includes("markdown-utils"),
		)!;
		await fireEvent.mouseEnter(mdHeader.parentElement!);
		await waitFor(() => {
			expect(getByRole("tooltip")).toHaveTextContent("No description provided.");
		});
	});

	test("clicking the badge calls ontoolstoggle with the inverted state", async () => {
		const ontoolstoggle = vi.fn();
		const { container } = render(
			ChatHeader,
			defaultProps({ loadedTools: sampleTools, ontoolstoggle }),
		);
		await fireEvent.click(toolButton(container));
		expect(ontoolstoggle).toHaveBeenCalledWith(true);
	});
});

const sampleTopics: Topic[] = [
	{ id: "t1", label: "Auth flow", typeId: "feature", messageIds: ["m1"] },
	{ id: "t2", label: "Rate limiting", typeId: "bug-fix", messageIds: ["m2"] },
];

describe("ChatHeader Topics button + popover", () => {
	test("shows a count badge when topics exist", () => {
		const { getByTestId } = render(
			ChatHeader,
			defaultProps({ topics: topicsChrome({ list: sampleTopics }) }),
		);
		expect(getByTestId("topics-badge")).toHaveTextContent("2");
	});

	test("no badge when there are no topics", () => {
		const { queryByTestId } = render(ChatHeader, defaultProps());
		expect(queryByTestId("topics-badge")).toBeNull();
	});

	test("clicking the Topics button toggles the popover open", async () => {
		const toggle = vi.fn();
		const { getByTestId } = render(
			ChatHeader,
			defaultProps({ topics: topicsChrome({ toggle }) }),
		);
		await fireEvent.click(getByTestId("topics-btn"));
		expect(toggle).toHaveBeenCalledWith(true);
	});

	test("renders the popover with the topic list when open", () => {
		const { getByTestId } = render(
			ChatHeader,
			defaultProps({
				topics: topicsChrome({ open: true, list: sampleTopics }),
			}),
		);
		expect(getByTestId("topics-popover")).toBeInTheDocument();
		expect(getByTestId("topic-pill-t1")).toHaveTextContent("Auth flow");
	});

	test("popover interactions forward to the chrome callbacks", async () => {
		const context: SavedContext = {
			id: "ctx-1",
			topicLabel: "Auth flow",
			typeId: "feature",
			title: "Auth flow",
			content: "JWT rotation",
			model: "m",
			updatedAt: "2026-07-13T00:00:00.000Z",
		};
		const toggle = vi.fn();
		const onanalyze = vi.fn();
		const onextract = vi.fn();
		const onmanualcopy = vi.fn();
		const { getByTestId } = render(
			ChatHeader,
			defaultProps({
				topics: topicsChrome({
					open: true,
					list: sampleTopics,
					// copyFailed → the manual Copy button renders so onmanualcopy
					// is reachable.
					extractState: extractResolved(context, false),
					toggle,
					onanalyze,
					onextract,
					onmanualcopy,
				}),
			}),
		);
		await fireEvent.click(getByTestId("topics-analyze-btn"));
		expect(onanalyze).toHaveBeenCalled();
		await fireEvent.click(getByTestId("topic-pill-t1"));
		expect(onextract).toHaveBeenCalledWith("t1");
		await fireEvent.click(getByTestId("topic-copy-btn"));
		expect(onmanualcopy).toHaveBeenCalledWith("JWT rotation");
		await fireEvent.click(getByTestId("topics-backdrop"));
		expect(toggle).toHaveBeenCalledWith(false);
	});
});
