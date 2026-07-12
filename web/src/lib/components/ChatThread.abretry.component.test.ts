/**
 * Sessions P5 — A/B retry affordance wiring in <ChatThread>.
 *
 * The A/B retry reuses the EXISTING regenerate mechanism (editOf → sibling
 * response); the only new surface is a flag-gated, run-blocked "Retry" affordance
 * in the assistant-row A/B controls (next to the ‹n/m› switcher). Covers: shown
 * when the `sessions:historyProducer` flag is ON; clicking it forks an
 * alternative via sendMessage(editOf); hidden when the flag is OFF.
 *
 * vitest + jsdom + @testing-library/svelte. Scaffolding mirrors
 * ChatThread.rewind.component.test.ts.
 */

import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Message } from "$lib/api.js";

interface TreeResult {
	enabled: boolean;
	tree: { conversationId: string; currentLeaf: string | null; nodes: unknown[] } | null;
}

const { sendMessageMock, fetchAllMessagesMock, fetchConversationTreeMock } = vi.hoisted(() => ({
	sendMessageMock: vi.fn(async (_c: string, d: { content: string; editOf?: string }) => ({
		userMessage: {
			id: "srv-1",
			conversationId: "conv-1",
			role: "user",
			content: d.content,
			createdAt: new Date().toISOString(),
			parentMessageId: null,
			excluded: false,
		},
		runId: "run-ab",
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
}));

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
	backgroundFetch: vi.fn(async () => null),
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
		msg("u1", { role: "user", content: "the prompt", createdAt: "2026-01-01T00:00:01.000Z" }),
		msg("a1", { role: "assistant", parentMessageId: "u1", content: "first answer", createdAt: "2026-01-01T00:00:02.000Z" }),
	];
}
function mount() {
	return render(ChatThread, { conversationId: "conv-1", projectId: "proj-1", seedMessages: seed(), seedLeafId: "a1" });
}

beforeEach(() => {
	sendMessageMock.mockClear();
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

describe("ChatThread A/B retry affordance (Sessions P5)", () => {
	test("flag ON → assistant row shows Retry; clicking forks an alternative via editOf regenerate", async () => {
		const { container } = mount();
		const btn = await vi.waitFor(() => {
			const el = container.querySelector('[data-testid="ab-retry-btn"]');
			if (!el) throw new Error("retry button not yet rendered");
			return el as HTMLButtonElement;
		});
		await fireEvent.click(btn);
		await vi.waitFor(() => expect(sendMessageMock).toHaveBeenCalled());
		const [, data] = sendMessageMock.mock.calls[0]!;
		// Regenerate re-sends the preceding user content as a sibling of a1.
		expect((data as { editOf?: string }).editOf).toBe("a1");
		expect((data as { content?: string }).content).toBe("the prompt");
	});

	test("flag OFF → the Retry affordance is never rendered", async () => {
		fetchConversationTreeMock.mockResolvedValue({ enabled: false, tree: null });
		const { container } = mount();
		await vi.waitFor(() => expect(fetchConversationTreeMock).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 0));
		expect(container.querySelector('[data-testid="ab-retry-btn"]')).toBeNull();
	});
});
