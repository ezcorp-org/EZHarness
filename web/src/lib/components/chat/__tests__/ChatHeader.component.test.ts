/**
 * DOM tests for ChatHeader.svelte — covers the double-click-to-rename
 * affordance on the conversation title.
 *
 * Display mode renders a <span data-testid="chat-title">. Double-clicking
 * swaps it for an inline edit form with Save / Cancel buttons. Clicking
 * Save calls `onrename` with the trimmed value and exits edit mode.
 * Empty/whitespace and unchanged titles do NOT call `onrename`. Escape
 * and Cancel both exit without saving.
 */

import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import ChatHeader from "../ChatHeader.svelte";
import type { Conversation } from "$lib/api.js";

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
		toolsByExtension: new Map(),
		extensionTypeMap: new Map(),
		toolsOpen: false,
		diffPanelOpen: false,
		diffFileCount: 0,
		activeLeafId: null,
		showObsButton: false,
		obsOpen: false,
		selectMode: false,
		isStreaming: false,
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
