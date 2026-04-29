/**
 * Phase 48 Wave 3 — DOM tests for EzPanel.
 *
 * Covers:
 *   - panel renders only when the panel-open store is set
 *   - mount triggers `getOrCreateEzConversation` and renders fetched
 *     messages
 *   - the composer is the locked Ez composer (no mode/agent picker —
 *     we assert the absence of those elements)
 *   - clicking the close button closes the panel
 *   - sending a message calls `sendMessage` with content + an
 *     `ezContext` payload synthesized from $page + the registry
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Mock $app/state BEFORE importing the panel so the panel sees our page.
vi.mock("$app/state", () => ({
	page: {
		route: { id: "/(app)/agents/new" },
		params: { id: "abc" },
		url: { pathname: "/agents/new", search: "" },
	},
}));

// Mock the api client so we don't need a server.
const sendMessageMock = vi.fn();
const fetchAllMessagesMock = vi.fn();
vi.mock("$lib/api.js", () => ({
	sendMessage: (...args: unknown[]) => sendMessageMock(...args),
	fetchAllMessages: (...args: unknown[]) => fetchAllMessagesMock(...args),
}));

const getOrCreateMock = vi.fn();
vi.mock("$lib/ez/api.js", () => ({
	getOrCreateEzConversation: () => getOrCreateMock(),
	getDraft: vi.fn(),
	consumeDraft: vi.fn(),
}));

import EzPanel from "$lib/components/ez/EzPanel.svelte";
import { ezPanelState, openEzPanel, closeEzPanel } from "$lib/ez/panel-store.svelte.js";
import { __resetForTests, registerContext } from "$lib/ez/registry";

beforeEach(() => {
	__resetForTests();
	closeEzPanel();
	sendMessageMock.mockReset().mockResolvedValue({ userMessage: { id: "u1", content: "hi", role: "user" }, runId: "r1" });
	fetchAllMessagesMock.mockReset().mockResolvedValue([]);
	getOrCreateMock.mockReset().mockResolvedValue({
		conversationId: "ez-conv-1",
		kind: "ez" as const,
		modeId: "mode-ez",
		title: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
	// stub EventSource so the panel's stream wiring doesn't crash jsdom
	(globalThis as unknown as { EventSource: unknown }).EventSource = class FakeES {
		onmessage: ((e: MessageEvent) => void) | null = null;
		onerror: (() => void) | null = null;
		close() {}
	};
});

afterEach(() => {
	closeEzPanel();
});

describe("EzPanel — render gating", () => {
	test("renders nothing when the panel store is closed", () => {
		const { queryByTestId } = render(EzPanel);
		expect(queryByTestId("ez-panel")).toBeNull();
	});

	test("renders the panel when the store is open", async () => {
		openEzPanel();
		const { findByTestId } = render(EzPanel);
		expect(await findByTestId("ez-panel")).toBeInTheDocument();
	});
});

describe("EzPanel — conversation bootstrap", () => {
	test("fetches the Ez conversation on first open and lists messages", async () => {
		fetchAllMessagesMock.mockResolvedValue([
			{ id: "m1", role: "user", content: "hello there", conversationId: "ez-conv-1", excluded: false, createdAt: "", thinkingContent: null, model: null, provider: null, usage: null, runId: null, parentMessageId: null },
			{ id: "m2", role: "assistant", content: "hi! how can I help?", conversationId: "ez-conv-1", excluded: false, createdAt: "", thinkingContent: null, model: null, provider: null, usage: null, runId: null, parentMessageId: null },
		]);
		openEzPanel();
		const { findAllByTestId } = render(EzPanel);

		await waitFor(() => {
			expect(getOrCreateMock).toHaveBeenCalled();
			expect(fetchAllMessagesMock).toHaveBeenCalledWith("ez-conv-1");
		});

		const msgs = await findAllByTestId("ez-message");
		expect(msgs).toHaveLength(2);
		expect(msgs[0]).toHaveAttribute("data-role", "user");
		expect(msgs[0]).toHaveTextContent(/hello there/);
		expect(msgs[1]).toHaveAttribute("data-role", "assistant");
	});
});

describe("EzPanel — composer", () => {
	test("composer renders without mode/agent/extension pickers (locked to Ez)", async () => {
		openEzPanel();
		const { findByTestId, queryByText } = render(EzPanel);
		expect(await findByTestId("ez-panel-input")).toBeInTheDocument();
		// The full ChatInput renders these labels; the locked Ez composer
		// must NOT include them.
		expect(queryByText(/Switch Model/i)).toBeNull();
		expect(queryByText(/Mode/i, { selector: "label" })).toBeNull();
	});

	test("Send button posts content + ezContext to api.sendMessage", async () => {
		// Register a page-level context entry so the serializer captures
		// some payload — verifies the wire shape end-to-end.
		registerContext({
			routeId: "/(app)/agents/new",
			data: { existingAgentNames: ["Foo"] },
			forms: { "agent-new": { schema: { name: "string" }, fill: () => {} } },
		});

		openEzPanel();
		const { findByTestId } = render(EzPanel);
		await findByTestId("ez-panel");

		// Wait until the conversation resolved and composer is enabled.
		await waitFor(() => expect(getOrCreateMock).toHaveBeenCalled());

		const input = await findByTestId("ez-panel-input") as HTMLTextAreaElement;
		await fireEvent.input(input, { target: { value: "summarize this" } });

		const sendBtn = await findByTestId("ez-panel-send") as HTMLButtonElement;
		await waitFor(() => expect(sendBtn.disabled).toBe(false));
		await fireEvent.click(sendBtn);

		await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
		const [convId, payload] = sendMessageMock.mock.calls[0]!;
		expect(convId).toBe("ez-conv-1");
		expect(payload.content).toBe("summarize this");
		expect(payload.ezContext).toBeDefined();
		expect(payload.ezContext.route.url).toBe("/agents/new");
		expect(payload.ezContext.data).toEqual({ existingAgentNames: ["Foo"] });
		expect(payload.ezContext.formIds).toEqual(["agent-new"]);
	});
});

describe("EzPanel — close button", () => {
	test("clicking close hides the panel via the store", async () => {
		openEzPanel();
		const { findByTestId, queryByTestId } = render(EzPanel);
		const close = await findByTestId("ez-panel-close");
		await fireEvent.click(close);
		expect(ezPanelState.open).toBe(false);
		await waitFor(() => expect(queryByTestId("ez-panel")).toBeNull());
	});
});
