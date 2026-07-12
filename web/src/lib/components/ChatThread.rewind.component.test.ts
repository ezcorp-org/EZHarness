/**
 * Sessions P4 — rewind/checkpoint affordance wiring in <ChatThread>.
 *
 * Covers the flag-gated rewind button: ChatThread learns the
 * `sessions:historyProducer` flag from `fetchConversationTree` (GET .../tree),
 * shows the assistant-row "Continue from here" button ONLY when enabled, wires a
 * click to the rewind POST (via `sendApi.handleRewind` → userFetch), hides the
 * button when the flag is off or the tree fetch fails, and re-pulls on a
 * `conversation:tree-changed` window event (guarded by conversationId).
 *
 * vitest + jsdom + @testing-library/svelte. Modeled on
 * ChatThread.render-branches.component.test.ts.
 */

import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Message } from "$lib/api.js";

interface TreeResult {
	enabled: boolean;
	tree: { conversationId: string; currentLeaf: string | null; nodes: unknown[] } | null;
}

const { sendMessageMock, fetchAllMessagesMock, fetchConversationTreeMock, userFetchMock } =
	vi.hoisted(() => ({
		sendMessageMock: vi.fn(async (_c: string, d: { content: string }) => ({
			userMessage: {
				id: "srv-1",
				conversationId: "conv-1",
				role: "user",
				content: d.content,
				createdAt: new Date().toISOString(),
				parentMessageId: null,
				excluded: false,
			},
			runId: "run-rw",
			attachments: [] as unknown[],
			ezActionResults: [] as unknown[],
		})),
		fetchAllMessagesMock: vi.fn(async () => [] as Message[]),
		fetchConversationTreeMock: vi.fn(
			async (): Promise<TreeResult> => ({
				enabled: true,
				tree: { conversationId: "conv-1", currentLeaf: "a1", nodes: [] },
			}),
		),
		userFetchMock: vi.fn(async (_url: string, _init?: RequestInit) => ({
			ok: true,
			json: async () => ({}) as unknown,
		})),
	}));

vi.mock("$app/state", () => ({
	page: {
		params: { id: "proj-1", convId: "conv-1" },
		url: new URL("http://localhost/project/proj-1/chat/conv-1"),
	},
}));
vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("$app/environment", () => ({ browser: true, dev: false, building: false, version: "t" }));
vi.mock("$lib/oauth.js", () => ({
	listenForOAuthResult: vi.fn(() => () => {}),
	startOAuthFlow: vi.fn(),
	completeOAuthWithCode: vi.fn(),
	isLoginCommand: () => null,
}));
vi.mock("$lib/commands.js", () => ({ isModelCommand: () => null }));
vi.mock("$lib/mention-logic.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/mention-logic.js")>();
	return { ...actual };
});
vi.mock("$lib/sub-conversation-store.svelte.js", () => ({
	subConversationStore: {
		get activeSubConversation() { return null; },
		get isInSubConversation() { return false; },
		get activeSubConversationId() { return null; },
		get subConvoMessages() { return []; },
		startSubConversation: vi.fn(),
		endSubConversation: vi.fn(() => []),
		addMessage: vi.fn(),
		setStreaming: vi.fn(),
	},
}));
vi.mock("$lib/utils/fetch-policy.js", () => ({
	userFetch: userFetchMock,
	// loadMessages() (invoked by the tree-changed handler) reads the tree via
	// backgroundFetch — return empty-safe shapes so it never throws.
	backgroundFetch: vi.fn(async (_key: string, url: string) => {
		if (url.includes("withToolCalls=true")) {
			return { ok: true, json: async () => ({ messages: [], orphanedToolCalls: [], subConversations: [], subConversationToolCalls: {} }) };
		}
		if (/\/api\/conversations\/[^/]+$/.test(url)) {
			return { ok: true, json: async () => ({ id: "conv-1", projectId: "proj-1", model: null }) };
		}
		return { ok: true, json: async () => [] };
	}),
	invalidate: vi.fn(),
}));
vi.mock("$lib/api.js", () => ({
	sendMessage: sendMessageMock,
	fetchAllMessages: fetchAllMessagesMock,
	fetchConversationTree: fetchConversationTreeMock,
	updateConversation: vi.fn(async (id: string) => ({ id })),
	createSubConversation: vi.fn(async () => ({ id: "s", agentConfigId: "" })),
	cloneTurns: vi.fn(),
	setMessageExcluded: vi.fn(async (_c: string, id: string, ex: boolean) => ({ id, excluded: ex })),
	fetchModes: vi.fn(async () => []),
	createConversation: vi.fn(),
	patchMessageContent: vi.fn(async (_c: string, _i: string, content: string) => ({ content })),
}));

import ChatThread from "./ChatThread.svelte";

function msg(id: string, o: Partial<Message> = {}): Message {
	return {
		id,
		conversationId: "conv-1",
		role: "user",
		content: `c-${id}`,
		createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
		parentMessageId: null,
		excluded: false,
		...o,
	} as Message;
}
function seed(): Message[] {
	return [
		msg("u1", { role: "user", createdAt: "2026-01-01T00:00:01.000Z" }),
		msg("a1", { role: "assistant", parentMessageId: "u1", content: "ans", createdAt: "2026-01-01T00:00:02.000Z" }),
	];
}
function mount() {
	return render(ChatThread, {
		conversationId: "conv-1",
		projectId: "proj-1",
		seedMessages: seed(),
		seedLeafId: "a1",
	});
}

beforeEach(() => {
	sendMessageMock.mockClear();
	userFetchMock.mockClear();
	fetchConversationTreeMock.mockClear();
	fetchConversationTreeMock.mockResolvedValue({
		enabled: true,
		tree: { conversationId: "conv-1", currentLeaf: "a1", nodes: [] },
	});
	type C = { new (...a: unknown[]): unknown };
	const g = globalThis as unknown as { IntersectionObserver?: C; ResizeObserver?: C };
	if (typeof g.IntersectionObserver === "undefined")
		g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as C;
	if (typeof g.ResizeObserver === "undefined")
		g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as C;
	if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

describe("ChatThread rewind/checkpoint affordance (Sessions P4)", () => {
	test("flag ON → assistant row shows the rewind button; clicking POSTs the rewind", async () => {
		const { container } = mount();
		const btn = await vi.waitFor(() => {
			const el = container.querySelector('[data-testid="rewind-btn"]');
			if (!el) throw new Error("rewind button not yet rendered");
			return el as HTMLButtonElement;
		});
		expect(fetchConversationTreeMock).toHaveBeenCalledWith("conv-1");
		await fireEvent.click(btn);
		await vi.waitFor(() => {
			const call = userFetchMock.mock.calls.find(([u]) => String(u).endsWith("/rewind"));
			expect(call).toBeTruthy();
		});
		const [url, init] = userFetchMock.mock.calls.find(([u]) => String(u).endsWith("/rewind"))!;
		expect(url).toBe("/api/conversations/conv-1/rewind");
		expect((init as RequestInit).method).toBe("POST");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({ targetMessageId: "a1" });
	});

	test("flag OFF → the rewind button is never rendered", async () => {
		fetchConversationTreeMock.mockResolvedValue({ enabled: false, tree: null });
		const { container } = mount();
		await vi.waitFor(() => expect(fetchConversationTreeMock).toHaveBeenCalled());
		// Give the reactive effect a tick; the button must stay absent.
		await new Promise((r) => setTimeout(r, 0));
		expect(container.querySelector('[data-testid="rewind-btn"]')).toBeNull();
	});

	test("a failing tree fetch fails quiet → button hidden (no dead affordance)", async () => {
		fetchConversationTreeMock.mockRejectedValue(new Error("network down"));
		const { container } = mount();
		await vi.waitFor(() => expect(fetchConversationTreeMock).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 0));
		expect(container.querySelector('[data-testid="rewind-btn"]')).toBeNull();
	});

	test("a matching conversation:tree-changed event re-pulls the tree; a mismatched one is ignored", async () => {
		mount();
		await vi.waitFor(() => expect(fetchConversationTreeMock).toHaveBeenCalledTimes(1));

		// Mismatched conversation → guarded early return, no refetch.
		window.dispatchEvent(new CustomEvent("conversation:tree-changed", { detail: { conversationId: "other" } }));
		await new Promise((r) => setTimeout(r, 0));
		expect(fetchConversationTreeMock).toHaveBeenCalledTimes(1);

		// Matching conversation → re-pull.
		window.dispatchEvent(new CustomEvent("conversation:tree-changed", { detail: { conversationId: "conv-1" } }));
		await vi.waitFor(() => expect(fetchConversationTreeMock).toHaveBeenCalledTimes(2));
	});
});
