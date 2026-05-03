/**
 * Phase 48 Wave 3 — DOM tests for EzPanel.
 *
 * Post-W4 refactor: EzPanel uses the same building blocks as the
 * regular chat page — the literal `ChatInput` component (with
 * `lockedMode={ modeSlug: 'ez', label: 'Ez' }`) and `ChatMessage` for
 * rendering. The panel composes them into the slide-in drawer chrome
 * and wires up the same SSE consumption pattern via `startStreaming`
 * and the `ez:turn_saved` / `ez:client-tool` window events that
 * `stores.svelte.ts` re-dispatches.
 *
 * Locked mode now keeps the Model and Thinking pickers fully
 * interactive — only the Mode picker is pinned to "Ez" and rendered
 * disabled (the Ez conversation's `modeId` is fixed server-side, but
 * provider/model/thinking-level are user choices the panel persists
 * to its own localStorage keys).
 *
 * Covers:
 *   - panel renders only when the panel-open store is set
 *   - mount triggers `getOrCreateEzConversation` and renders fetched
 *     messages via `ChatMessage`
 *   - the composer is the locked `ChatInput`: the placeholder is the
 *     Ez prompt, the Model column is rendered, the Mode picker is
 *     present-but-disabled and shows "Ez"
 *   - clicking the close button closes the panel
 *   - sending a message calls `sendMessage` with content + an
 *     `ezContext` payload synthesized from $page + the registry, then
 *     registers the runId with the global streaming store via
 *     `startStreaming`
 *   - an `ez:client-tool` window event is dispatched onto the global
 *     bus (by `stores.svelte.ts`) and EzPanel routes it through the
 *     client-tool dispatcher, POSTing the result back to
 *     `/api/conversations/[id]/tool-results`
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

// `vi.mock` factory bodies are hoisted above all imports, so they can't
// reference top-level test variables. `vi.hoisted` lets us declare the
// shared mock state inside the same hoisted region. All `vi.mock`
// factories below close over `mocks.*`.
const mocks = vi.hoisted(() => ({
	sendMessageMock: vi.fn(),
	fetchAllMessagesMock: vi.fn(),
	searchMentionsMock: vi.fn().mockResolvedValue([]),
	getOrCreateMock: vi.fn(),
	clearEzMock: vi.fn(),
	startStreamingMock: vi.fn().mockReturnValue(true),
	stopStreamingMock: vi.fn(),
	fakeStore: { streamingMessages: {}, streamingStatus: {} } as Record<string, unknown>,
}));

vi.mock("$lib/api.js", () => ({
	sendMessage: (...args: unknown[]) => mocks.sendMessageMock(...args),
	fetchAllMessages: (...args: unknown[]) => mocks.fetchAllMessagesMock(...args),
	searchMentions: (...args: unknown[]) => mocks.searchMentionsMock(...args),
}));
// `$lib/api` (without `.js`) is also referenced via PanelChatInput's
// `import { searchMentions } from "$lib/api"` — alias both spellings so
// the import resolves to the same mock under vitest's vite transform.
vi.mock("$lib/api", () => ({
	sendMessage: (...args: unknown[]) => mocks.sendMessageMock(...args),
	fetchAllMessages: (...args: unknown[]) => mocks.fetchAllMessagesMock(...args),
	searchMentions: (...args: unknown[]) => mocks.searchMentionsMock(...args),
}));

vi.mock("$lib/ez/api.js", () => ({
	getOrCreateEzConversation: () => mocks.getOrCreateMock(),
	clearEzConversation: () => mocks.clearEzMock(),
	getDraft: vi.fn(),
	consumeDraft: vi.fn(),
}));

// Stub the global runtime store imports we depend on (`startStreaming`,
// `stopStreaming`, `store`). The real implementations spin up an SSE
// client on import via `initStores`, which we don't want under jsdom —
// the panel only reads two slots (`streamingMessages`, `streamingStatus`)
// keyed by runId, and calls `startStreaming` / `stopStreaming` to register
// the active run.
vi.mock("$lib/stores.svelte.js", () => ({
	store: mocks.fakeStore,
	startStreaming: (...args: unknown[]) => mocks.startStreamingMock(...args),
	stopStreaming: (...args: unknown[]) => mocks.stopStreamingMock(...args),
}));

// `ChatMessage` pulls in `$lib/stores.svelte.js` *types* but doesn't
// access the running module at module-eval. Other transitive imports
// (MarkdownRenderer, ToolCallCard, ...) do touch DOM; those are fine
// under jsdom.

// Stub `connectionState` (used by ChatInput, not PanelChatInput, but
// imported via shared paths) — provide a minimal subscribe surface so
// any incidental subscription resolves cleanly.
vi.mock("$lib/stores/connection", () => ({
	connectionState: {
		subscribe: (fn: (s: { state: string; attempt: number; maxAttempts: number }) => void) => {
			fn({ state: "connected", attempt: 0, maxAttempts: 10 });
			return () => {};
		},
		set: () => {},
	},
}));

// Stub the toast helper so the api wrapper's lazy import in tests
// doesn't try to resolve the real $lib/toast on a 429 path.
vi.mock("$lib/toast.svelte", () => ({ addToast: vi.fn() }));
vi.mock("$lib/toast.svelte.js", () => ({ addToast: vi.fn() }));

import EzPanel from "$lib/components/ez/EzPanel.svelte";
import { ezPanelState, openEzPanel, closeEzPanel } from "$lib/ez/panel-store.svelte.js";
import { __resetForTests, registerContext } from "$lib/ez/registry";

beforeEach(() => {
	__resetForTests();
	closeEzPanel();
	// Clear localStorage between tests — `EzPanel.svelte`'s loadStoredModel
	// reads `ez-panel:selected-model` at module init, so a prior test that
	// triggered `handleModelAutoSelect` would leak the saved choice into
	// the next test's render. Tests that need a saved model should set it
	// explicitly. This isolates the regression test for the "Send disabled
	// while autoselect pending" path from the "happy-path send" test.
	if (typeof localStorage !== "undefined") {
		localStorage.clear();
	}
	// jsdom doesn't ship IntersectionObserver; PanelChatInput's
	// scroll-to-bottom effect calls it when both sentinel + container
	// refs are bound. Provide a no-op stub so the effect doesn't throw.
	if (typeof (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver === "undefined") {
		(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
	mocks.sendMessageMock.mockReset().mockResolvedValue({ userMessage: { id: "u1", content: "hi", role: "user" }, runId: "r1" });
	mocks.fetchAllMessagesMock.mockReset().mockResolvedValue([]);
	mocks.startStreamingMock.mockReset().mockReturnValue(true);
	mocks.stopStreamingMock.mockReset();
	mocks.fakeStore.streamingMessages = {};
	mocks.fakeStore.streamingStatus = {};
	mocks.getOrCreateMock.mockReset().mockResolvedValue({
		conversationId: "ez-conv-1",
		kind: "ez" as const,
		modeId: "mode-ez",
		title: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
	mocks.clearEzMock.mockReset().mockResolvedValue({
		conversationId: "ez-conv-1",
		deletedCount: 0,
	});
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
		mocks.fetchAllMessagesMock.mockResolvedValue([
			{ id: "m1", role: "user", content: "hello there", conversationId: "ez-conv-1", excluded: false, createdAt: "", thinkingContent: null, model: null, provider: null, usage: null, runId: null, parentMessageId: null },
			{ id: "m2", role: "assistant", content: "hi! how can I help?", conversationId: "ez-conv-1", excluded: false, createdAt: "", thinkingContent: null, model: null, provider: null, usage: null, runId: null, parentMessageId: null },
		]);
		openEzPanel();
		const { findAllByTestId } = render(EzPanel);

		await waitFor(() => {
			expect(mocks.getOrCreateMock).toHaveBeenCalled();
			expect(mocks.fetchAllMessagesMock).toHaveBeenCalledWith("ez-conv-1");
		});

		const msgs = await findAllByTestId("ez-message");
		expect(msgs).toHaveLength(2);
		expect(msgs[0]).toHaveAttribute("data-role", "user");
		expect(msgs[0]).toHaveTextContent(/hello there/);
		expect(msgs[1]).toHaveAttribute("data-role", "assistant");
	});
});

describe("EzPanel — composer", () => {
	test("composer is the locked ChatInput — Model picker visible, Mode picker pinned to Ez and disabled", async () => {
		openEzPanel();
		const { findByPlaceholderText, queryByText, findByTestId } = render(EzPanel);
		// ChatInput exposes its textarea via the placeholder we pass in —
		// no `data-testid="ez-panel-input"`.
		expect(await findByPlaceholderText(/Ask Ez to do something/i)).toBeInTheDocument();

		// The Model column renders in locked mode now — users can pick a
		// provider/model for Ez runs.
		expect(queryByText(/^Model$/)).not.toBeNull();
		// The Mode column also renders, but as a disabled <ModeSelector>
		// pinned to the synthesized "Ez" mode. We tag the wrapping
		// <div> with `data-testid="chat-input-locked-mode"` so the test
		// can assert the lock-state without depending on chevron/icon
		// presence.
		const lockedMode = await findByTestId("chat-input-locked-mode");
		expect(lockedMode).toHaveAttribute("data-mode-slug", "ez");
		expect(lockedMode).toHaveTextContent(/Ez/);
		// The trigger button inside the locked-mode wrapper must be
		// disabled (so click events don't open the dropdown).
		const modeButton = lockedMode.querySelector("button");
		expect(modeButton).not.toBeNull();
		expect(modeButton!.disabled).toBe(true);
		expect(modeButton).toHaveAttribute("aria-disabled", "true");

		// Thinking column only renders once the active model advertises
		// reasoning support — we haven't selected a model in this test
		// (no `/api/models` mock), so the column stays hidden. That's
		// the same behavior as the chat page on first load.
		expect(queryByText(/^Thinking$/)).toBeNull();
	});

	test("Send posts content + ezContext to api.sendMessage and starts streaming", async () => {
		// Register a page-level context entry so the serializer captures
		// some payload — verifies the wire shape end-to-end.
		registerContext({
			routeId: "/(app)/agents/new",
			data: { existingAgentNames: ["Foo"] },
			forms: { "agent-new": { schema: { name: "string" }, fill: () => {} } },
		});

		// Mock /api/models so ModelSelector's autoselect fires and the
		// Send button enables. ChatInput now blocks submit when no model
		// is selected (locked-mode included) — see EzPanel-model-routing
		// regression test below.
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/api/models")) {
				return new Response(
					JSON.stringify([
						{ provider: "anthropic", model: "claude-sonnet-4-6", tier: "balanced", costTier: "medium", available: true },
					]),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		try {
			openEzPanel();
			const { findByPlaceholderText, findByLabelText } = render(EzPanel);

			// Wait until the conversation resolved and composer is enabled.
			await waitFor(() => expect(mocks.getOrCreateMock).toHaveBeenCalled());

			const input = await findByPlaceholderText(/Ask Ez to do something/i) as HTMLTextAreaElement;
			await waitFor(() => expect(input.disabled).toBe(false));
			await fireEvent.input(input, { target: { value: "summarize this" } });

			const sendBtn = await findByLabelText("Send message") as HTMLButtonElement;
			await waitFor(() => expect(sendBtn.disabled).toBe(false));
			await fireEvent.click(sendBtn);

			await waitFor(() => expect(mocks.sendMessageMock).toHaveBeenCalledTimes(1));
			const [convId, payload] = mocks.sendMessageMock.mock.calls[0]!;
			expect(convId).toBe("ez-conv-1");
			expect(payload.content).toBe("summarize this");
			expect(payload.ezContext).toBeDefined();
			expect(payload.ezContext.route.url).toBe("/agents/new");
			expect(payload.ezContext.data).toEqual({ existingAgentNames: ["Foo"] });
			expect(payload.ezContext.formIds).toEqual(["agent-new"]);
			expect(payload.thinkingLevel).toBe("medium");
			// REGRESSION GUARD (model-routing fix): the panel MUST ship the
			// auto-selected provider/model on the wire. The previous
			// implementation omitted them when `selectedModel` was null —
			// that left a race window where a fast Enter before
			// /api/models resolved would reach the server without
			// provider/model and the runtime would silently fall back to
			// default-tier resolution (resolveModel L3) instead of the
			// model the picker UI advertised.
			expect(payload.provider).toBe("anthropic");
			expect(payload.model).toBe("claude-sonnet-4-6");

			// Ez follows the same SSE consumption pattern as the chat page —
			// once `sendMessage` returns a runId, the panel registers it with
			// the global streaming store. `run:token` / `run:status` events
			// then accumulate into `store.streamingMessages[runId]`.
			await waitFor(() => expect(mocks.startStreamingMock).toHaveBeenCalledWith("r1", "ez-conv-1"));
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("Send button is disabled while ModelSelector's autoselect has not yet resolved (regression)", async () => {
		// Reproduces the "Ez panel sometimes uses a different model"
		// bug: before the fix, ChatInput's submit gate was `(!isLocked
		// && !selectedModel)` — so locked-mode surfaces (the Ez panel)
		// allowed submit with `selectedModel == null`, the request
		// shipped without provider/model, and the runtime fell back to
		// its default-tier preference order. This test pins the gate by
		// withholding /api/models indefinitely so autoselect never fires
		// and asserting that Send stays disabled.
		const originalFetch = globalThis.fetch;
		// Pending fetch — never resolves within the test window.
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/api/models")) {
				return new Promise<Response>(() => {}); // never resolves
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		try {
			openEzPanel();
			const { findByPlaceholderText, findByLabelText } = render(EzPanel);

			await waitFor(() => expect(mocks.getOrCreateMock).toHaveBeenCalled());

			const input = await findByPlaceholderText(/Ask Ez to do something/i) as HTMLTextAreaElement;
			await waitFor(() => expect(input.disabled).toBe(false));
			await fireEvent.input(input, { target: { value: "trying to send fast" } });

			const sendBtn = await findByLabelText("Send message") as HTMLButtonElement;
			// The button stays disabled because no model has been
			// auto-selected (or chosen from localStorage).
			expect(sendBtn.disabled).toBe(true);
			expect(sendBtn.title).toMatch(/Select a model first/i);

			// Even if we click anyway, sendMessage must not be invoked —
			// the click should be a no-op while disabled.
			await fireEvent.click(sendBtn);
			expect(mocks.sendMessageMock).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("EzPanel — client-tool dispatch", () => {
	test("an ez:client-tool window event invokes the dispatcher and POSTs the result", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
		// Spy on global fetch so we can assert the tool-results POST.
		// Cast through `unknown` because the vitest mock type has the
		// same call signature as `fetch` but omits the static helpers
		// (`preconnect`, etc.) that the upstream typedef requires.
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		openEzPanel();
		const { findByTestId } = render(EzPanel);
		await findByTestId("ez-panel");
		await waitFor(() => expect(mocks.getOrCreateMock).toHaveBeenCalled());

		// Dispatch the same window event `stores.svelte.ts` re-dispatches
		// for `ez:client-tool` bus messages. The panel's onMount listener
		// should pick this up and route through the dispatcher.
		// `navigate_to` with a same-origin path resolves cleanly without
		// needing a registered form handler.
		window.dispatchEvent(
			new CustomEvent("ez:client-tool", {
				detail: {
					conversationId: "ez-conv-1",
					toolCallId: "tc-1",
					toolName: "navigate_to",
					input: { path: "/agents/new" },
				},
			}),
		);

		await waitFor(() => {
			const calls = fetchMock.mock.calls;
			const toolResultsCall = calls.find((c) =>
				typeof c[0] === "string" && c[0].includes("/tool-results"),
			);
			expect(toolResultsCall).toBeDefined();
		});

		const toolResultsCall = fetchMock.mock.calls.find((c) =>
			typeof c[0] === "string" && c[0].includes("/tool-results"),
		)!;
		expect(toolResultsCall[0]).toBe(
			"/api/conversations/ez-conv-1/tool-results",
		);
		const body = JSON.parse((toolResultsCall[1] as RequestInit).body as string);
		expect(body.toolCallId).toBe("tc-1");
		expect(body.result.ok).toBe(true);
		expect(body.result.toolName).toBe("navigate_to");

		globalThis.fetch = originalFetch;
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

describe("EzPanel — clear conversation", () => {
	test("clicking clear (after confirm) calls the API and empties the message list", async () => {
		// Seed a couple of messages so we can verify the list goes
		// empty post-clear. The test doesn't care about message
		// content — only that the rendered `ez-message` count drops
		// to zero after the DELETE round-trips.
		mocks.fetchAllMessagesMock.mockResolvedValue([
			{ id: "m1", role: "user", content: "hello", conversationId: "ez-conv-1", excluded: false, createdAt: "", thinkingContent: null, model: null, provider: null, usage: null, runId: null, parentMessageId: null },
			{ id: "m2", role: "assistant", content: "hi!", conversationId: "ez-conv-1", excluded: false, createdAt: "", thinkingContent: null, model: null, provider: null, usage: null, runId: null, parentMessageId: null },
		]);
		mocks.clearEzMock.mockResolvedValue({ conversationId: "ez-conv-1", deletedCount: 2 });

		// Stub `window.confirm` to auto-accept — the panel's destructive-
		// action guard uses the codebase's existing confirm() pattern
		// (see project-settings, custom-mode delete, pipelines).
		const originalConfirm = window.confirm;
		window.confirm = vi.fn().mockReturnValue(true);

		openEzPanel();
		const { findByTestId, findAllByTestId, queryAllByTestId } = render(EzPanel);

		// Wait for bootstrap so messages are rendered before we click.
		await waitFor(() => expect(mocks.getOrCreateMock).toHaveBeenCalled());
		const before = await findAllByTestId("ez-message");
		expect(before).toHaveLength(2);

		const clearBtn = await findByTestId("ez-panel-clear");
		expect(clearBtn).toHaveAttribute("aria-label", "Clear conversation");
		await fireEvent.click(clearBtn);

		// Confirm dialog was shown and accepted.
		expect(window.confirm).toHaveBeenCalledTimes(1);

		// API was hit, message list emptied, conversation id unchanged
		// (panel still operates against the same conversation).
		await waitFor(() => expect(mocks.clearEzMock).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(queryAllByTestId("ez-message")).toHaveLength(0));

		window.confirm = originalConfirm;
	});

	test("clicking clear and dismissing the confirm dialog is a no-op", async () => {
		mocks.fetchAllMessagesMock.mockResolvedValue([
			{ id: "m1", role: "user", content: "hello", conversationId: "ez-conv-1", excluded: false, createdAt: "", thinkingContent: null, model: null, provider: null, usage: null, runId: null, parentMessageId: null },
		]);
		const originalConfirm = window.confirm;
		// User cancels the destructive action — no DELETE should fire,
		// no messages removed.
		window.confirm = vi.fn().mockReturnValue(false);

		openEzPanel();
		const { findByTestId, findAllByTestId } = render(EzPanel);
		await waitFor(() => expect(mocks.getOrCreateMock).toHaveBeenCalled());
		await findAllByTestId("ez-message");

		const clearBtn = await findByTestId("ez-panel-clear");
		await fireEvent.click(clearBtn);

		expect(window.confirm).toHaveBeenCalledTimes(1);
		expect(mocks.clearEzMock).not.toHaveBeenCalled();
		// Messages remain in the DOM.
		const after = await findAllByTestId("ez-message");
		expect(after).toHaveLength(1);

		window.confirm = originalConfirm;
	});
});

// ── Iter 6: empty-turn rendering ─────────────────────────────────────
// The user reported the blank-bubble bug as still visible "in the ez chat
// ui" even after iter 5 fixed the main chat page. Root cause: EzPanel
// rendered `messages` raw, with NO `getHistoricalToolCalls`, NO
// `inlineToolStore` hydration, NO `buildHistoricalBlocks`, and NO
// `filterEmptyAssistantTurns`. After `run:complete` cleared the streaming
// caches, an empty-content tool-only turn fell through ChatMessage to a
// blank shell. These tests pin the iter-6 wiring.

import { inlineToolStore } from "$lib/inline-tool-store.svelte.js";

describe("EzPanel — empty-turn rendering (iter 6)", () => {
	beforeEach(() => {
		// Clear the global inlineToolStore so tests can seed deterministic
		// historical tool calls without leaking into one another.
		(inlineToolStore as unknown as { calls: unknown[] }).calls = [];
		// Stub the messages?withToolCalls=true endpoint so the panel's
		// hydrate call doesn't reach the real network. Tests that need
		// specific tool-call data seed it directly into `inlineToolStore`
		// AFTER initial hydration completes (or override the fetch stub
		// to return the desired payload).
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("?withToolCalls=true")) {
				return new Response(JSON.stringify({ messages: [], orphanedToolCalls: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;
		// Restore via afterEach; the stub is per-test.
		(globalThis as unknown as { __origFetch?: typeof fetch }).__origFetch = originalFetch;
	});

	afterEach(() => {
		const orig = (globalThis as unknown as { __origFetch?: typeof fetch }).__origFetch;
		if (orig) globalThis.fetch = orig;
		(inlineToolStore as unknown as { calls: unknown[] }).calls = [];
	});

	test("empty-content assistant turn with hydrated tool call → renders the tool card, no blank `.markdown-body`", async () => {
		// Two assistant turns sharing a runId: the first is the prod
		// blank-bubble shape (empty content + tool call), the second
		// carries the actual reply.
		mocks.fetchAllMessagesMock.mockResolvedValue([
			{ id: "u1", role: "user", content: "scan the dir", conversationId: "ez-conv-1", excluded: false, createdAt: "", thinkingContent: null, model: null, provider: null, usage: null, runId: null, parentMessageId: null },
			{ id: "a1-tool", role: "assistant", content: "", conversationId: "ez-conv-1", excluded: false, createdAt: "", thinkingContent: null, model: null, provider: null, usage: null, runId: "run-x", parentMessageId: "u1" },
			{ id: "a2-reply", role: "assistant", content: "Here is what I found.", conversationId: "ez-conv-1", excluded: false, createdAt: "", thinkingContent: null, model: null, provider: null, usage: null, runId: "run-x", parentMessageId: "a1-tool" },
		]);
		// Override fetch so the hydrate call returns a tool call anchored
		// to the empty turn `a1-tool` — exactly the prod shape.
		globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("?withToolCalls=true")) {
				return new Response(JSON.stringify({
					messages: [
						{
							id: "a1-tool",
							toolCalls: [
								{
									id: "tc-1",
									extensionId: "fs",
									toolName: "fs__list",
									input: { path: "/tmp" },
									outputSummary: "ok",
									success: true,
									durationMs: 12,
									status: "success",
									messageId: "a1-tool",
									cardType: null,
									cardLayout: null,
									fullOutput: "[\"a.md\",\"b.md\"]",
								},
							],
						},
					],
					orphanedToolCalls: [],
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		openEzPanel();
		const { container, findAllByTestId } = render(EzPanel);
		await waitFor(() => expect(mocks.getOrCreateMock).toHaveBeenCalled());
		await waitFor(() => expect(mocks.fetchAllMessagesMock).toHaveBeenCalled());

		// Wait for hydration to land tool call into the store.
		await waitFor(() => {
			expect(inlineToolStore.getByMessage("a1-tool").length).toBe(1);
		});

		// Both assistant rows render (the empty one is kept by hydrated tools).
		const msgs = await findAllByTestId("ez-message");
		// 1 user + 2 assistant = 3.
		expect(msgs.length).toBe(3);

		// The empty-content row has its tool card mounted (id starts with
		// `tool-call-`) but NO `.markdown-body` (the iter-4 fix suppresses
		// the empty markdown wrapper).
		const a1Row = container.querySelector('[data-message-id="a1-tool"]');
		expect(a1Row).not.toBeNull();
		expect(a1Row?.querySelector("[id^='tool-call-']")).not.toBeNull();
		expect(a1Row?.querySelector(".markdown-body")).toBeNull();

		// The reply row renders its text via `.markdown-body`.
		const a2Row = container.querySelector('[data-message-id="a2-reply"]');
		expect(a2Row).not.toBeNull();
		expect(a2Row?.querySelector(".markdown-body")).not.toBeNull();
		expect(a2Row?.textContent).toContain("Here is what I found.");
	});

	test("empty-content assistant turn with NO tool calls / memories / thinking → row hidden by filter (no blank shell)", async () => {
		// `a1-blank` is the user-reported deduped-blank shape: empty
		// content, no tool/agent/thinking signal at all. Filter must drop
		// it entirely — pre-iter-6 it rendered as a blank avatar+toolbar
		// shell in the EzPanel.
		mocks.fetchAllMessagesMock.mockResolvedValue([
			{ id: "u1", role: "user", content: "?", conversationId: "ez-conv-1", excluded: false, createdAt: "", thinkingContent: null, model: null, provider: null, usage: null, runId: null, parentMessageId: null },
			{ id: "a1-blank", role: "assistant", content: "", conversationId: "ez-conv-1", excluded: false, createdAt: "", thinkingContent: null, model: null, provider: null, usage: null, runId: "run-y", parentMessageId: "u1" },
			{ id: "a2-reply", role: "assistant", content: "Final reply.", conversationId: "ez-conv-1", excluded: false, createdAt: "", thinkingContent: null, model: null, provider: null, usage: null, runId: "run-y", parentMessageId: "a1-blank" },
		]);

		openEzPanel();
		const { container, findAllByTestId } = render(EzPanel);
		await waitFor(() => expect(mocks.getOrCreateMock).toHaveBeenCalled());
		await waitFor(() => expect(mocks.fetchAllMessagesMock).toHaveBeenCalled());

		// One user + one final reply — the blank intermediate is filtered.
		const msgs = await findAllByTestId("ez-message");
		expect(msgs.length).toBe(2);

		// Critically: no DOM node for the blank intermediate.
		expect(container.querySelector('[data-message-id="a1-blank"]')).toBeNull();
		// Reply IS rendered.
		const a2Row = container.querySelector('[data-message-id="a2-reply"]');
		expect(a2Row).not.toBeNull();
		expect(a2Row?.textContent).toContain("Final reply.");
	});

	test("non-empty assistant turn always renders its text", async () => {
		mocks.fetchAllMessagesMock.mockResolvedValue([
			{ id: "u1", role: "user", content: "hi", conversationId: "ez-conv-1", excluded: false, createdAt: "", thinkingContent: null, model: null, provider: null, usage: null, runId: null, parentMessageId: null },
			{ id: "a1", role: "assistant", content: "hello back", conversationId: "ez-conv-1", excluded: false, createdAt: "", thinkingContent: null, model: null, provider: null, usage: null, runId: "run-z", parentMessageId: "u1" },
		]);

		openEzPanel();
		const { container, findAllByTestId } = render(EzPanel);
		await waitFor(() => expect(mocks.getOrCreateMock).toHaveBeenCalled());
		await waitFor(() => expect(mocks.fetchAllMessagesMock).toHaveBeenCalled());

		const msgs = await findAllByTestId("ez-message");
		expect(msgs.length).toBe(2);

		const a1Row = container.querySelector('[data-message-id="a1"]');
		expect(a1Row?.querySelector(".markdown-body")?.textContent).toContain("hello back");
	});
});
