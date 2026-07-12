/**
 * Sessions P4 reload-restore (Wave-6) — <ChatThread> re-seats the active branch
 * on the DURABLE rewind leaf when a conversation (re)loads.
 *
 * Drives the NON-seeded async load (production embed seam): `loadMessages`
 * populates `allMessages` + sets the default `computeLatestLeaf`, then
 * `restoreDurableLeaf` overrides it with the tree's `currentLeaf` when the
 * producer is on and the pointer is a live row — so a rewind survives reload.
 * Covers: restore to an EARLIER leaf; no restore when the flag is off (keeps the
 * latest leaf); no restore for a stale pointer not among the loaded rows; and a
 * failing tree fetch fails open to the latest leaf.
 *
 * vitest + jsdom + @testing-library/svelte. A dedicated non-seeded harness
 * (ChatThreadRestoreHarness) binds ChatThread's live `activeLeafId` mirror.
 */

import { render } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Message } from "$lib/api.js";

interface TreeResult {
	enabled: boolean;
	tree: { conversationId: string; currentLeaf: string | null; nodes: unknown[] } | null;
}

const { fetchConversationTreeMock } = vi.hoisted(() => ({
	fetchConversationTreeMock: vi.fn(
		async (): Promise<TreeResult> => ({ enabled: false, tree: null }),
	),
}));

// Linear conversation u1 → a1 → u2 → a2. computeLatestLeaf → "a2".
const TREE: Message[] = [
	{ id: "u1", conversationId: "conv-1", role: "user", content: "q1", parentMessageId: null, excluded: false, createdAt: "2026-01-01T00:00:01.000Z" } as Message,
	{ id: "a1", conversationId: "conv-1", role: "assistant", content: "a-one", parentMessageId: "u1", excluded: false, createdAt: "2026-01-01T00:00:02.000Z" } as Message,
	{ id: "u2", conversationId: "conv-1", role: "user", content: "q2", parentMessageId: "a1", excluded: false, createdAt: "2026-01-01T00:00:03.000Z" } as Message,
	{ id: "a2", conversationId: "conv-1", role: "assistant", content: "a-two", parentMessageId: "u2", excluded: false, createdAt: "2026-01-01T00:00:04.000Z" } as Message,
];

vi.mock("$app/state", () => ({
	page: { params: { id: "proj-1", convId: "conv-1" }, url: new URL("http://localhost/project/proj-1/chat/conv-1") },
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
	userFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
	backgroundFetch: vi.fn(async (_k: string, url: string) => {
		if (url.includes("messages?all=true")) return { ok: true, json: async () => TREE };
		if (url.includes("withToolCalls=true"))
			return { ok: true, json: async () => ({ messages: [], orphanedToolCalls: [], subConversations: [], subConversationToolCalls: {} }) };
		if (/\/api\/conversations\/[^/]+$/.test(url))
			return { ok: true, json: async () => ({ id: "conv-1", projectId: "proj-1", model: null, provider: null, modeId: null }) };
		return null;
	}),
	invalidate: vi.fn(),
}));
vi.mock("$lib/api.js", () => ({
	sendMessage: vi.fn(),
	retryMessage: vi.fn(),
	fetchAllMessages: vi.fn(async () => TREE),
	fetchConversationTree: fetchConversationTreeMock,
	updateConversation: vi.fn(async (id: string) => ({ id })),
	createSubConversation: vi.fn(async () => ({ id: "s", agentConfigId: "" })),
	cloneTurns: vi.fn(),
	setMessageExcluded: vi.fn(),
	fetchModes: vi.fn(async () => []),
	createConversation: vi.fn(),
	patchMessageContent: vi.fn(),
}));

import Harness from "./ChatThreadRestoreHarness.svelte";

function leafText(container: HTMLElement): string {
	return container.querySelector('[data-testid="active-leaf"]')?.textContent ?? "";
}

beforeEach(() => {
	fetchConversationTreeMock.mockReset();
	fetchConversationTreeMock.mockResolvedValue({ enabled: false, tree: null });
	type C = { new (...a: unknown[]): unknown };
	const g = globalThis as unknown as { IntersectionObserver?: C; ResizeObserver?: C };
	if (typeof g.IntersectionObserver === "undefined")
		g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as C;
	if (typeof g.ResizeObserver === "undefined")
		g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as C;
	if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

describe("ChatThread reload-restore (Sessions P4 durable leaf)", () => {
	test("restores the active branch to the durable currentLeaf (an earlier turn)", async () => {
		fetchConversationTreeMock.mockResolvedValue({
			enabled: true,
			tree: { conversationId: "conv-1", currentLeaf: "a1", nodes: [] },
		});
		const { container } = render(Harness, { conversationId: "conv-1" });
		// The load walks: default computeLatestLeaf → a2, then restore → a1.
		await vi.waitFor(() => expect(leafText(container)).toBe("a1"));
	});

	test("flag OFF → keeps the latest leaf (no restore)", async () => {
		fetchConversationTreeMock.mockResolvedValue({ enabled: false, tree: null });
		const { container } = render(Harness, { conversationId: "conv-1" });
		await vi.waitFor(() => expect(leafText(container)).toBe("a2"));
	});

	test("stale currentLeaf not among loaded rows → falls back to the latest leaf", async () => {
		fetchConversationTreeMock.mockResolvedValue({
			enabled: true,
			tree: { conversationId: "conv-1", currentLeaf: "ghost", nodes: [] },
		});
		const { container } = render(Harness, { conversationId: "conv-1" });
		await vi.waitFor(() => expect(fetchConversationTreeMock).toHaveBeenCalled());
		// Give the post-load microtasks a beat, then assert it never moved off a2.
		await new Promise((r) => setTimeout(r, 10));
		expect(leafText(container)).toBe("a2");
	});

	test("tree fetch failure → fails open to the latest leaf", async () => {
		fetchConversationTreeMock.mockRejectedValue(new Error("network"));
		const { container } = render(Harness, { conversationId: "conv-1" });
		await vi.waitFor(() => expect(leafText(container)).toBe("a2"));
	});
});
