/**
 * ChatThread → `oncurrentconversation` surfacing contract.
 *
 * Pins the first-paint emit that lets the route shell inherit
 * `selectedMode` from the loaded conversation's `modeId`
 * (see `decideInheritedMode` / inherit-mode.ts). ChatThread holds an
 * `$effect` that mirrors the `currentConversation` prop into local
 * `currentConv` and calls `oncurrentconversation?.(currentConv)` — so a
 * conversation carrying `{ id, modeId }` is surfaced up to the shell
 * exactly once it is known, and again whenever the prop changes.
 *
 * This suite asserts the narrowest meaningful contract: the callback
 * fires with the conversation object whose `id` / `modeId` flow up to
 * the shell. Mocking style mirrors the sibling
 * `ChatThread.component.test.ts` (only network/IO leaves stubbed).
 *
 * vitest + jsdom + @testing-library/svelte.
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Conversation, Message } from "$lib/api.js";
import { __resetCapabilityCacheForTests } from "$lib/chat/attachment-client";
import { makeCapabilitiesFetch } from "../../../__tests__/stubs/model-capabilities";

const { fetchAllMessagesMock } = vi.hoisted(() => ({
	fetchAllMessagesMock: vi.fn(async () => [] as Message[]),
}));

vi.mock("$lib/api.js", () => ({
	sendMessage: vi.fn(),
	updateConversation: vi.fn(async (id: string) => ({ id })),
	createSubConversation: vi.fn(async () => ({ id: "sub-1", agentConfigId: "" })),
	cloneTurns: vi.fn(async () => ({ id: "x" })),
	setMessageExcluded: vi.fn(async (_c: string, id: string, ex: boolean) => ({
		id,
		excluded: ex,
	})),
	fetchAllMessages: fetchAllMessagesMock,
	fetchModes: vi.fn(async () => []),
	createConversation: vi.fn(async () => ({ id: "new" })),
	patchMessageContent: vi.fn(async (_c: string, _id: string, content: string) => ({
		content,
	})),
}));

vi.mock("$lib/oauth.js", () => ({
	startOAuthFlow: vi.fn(),
	completeOAuthWithCode: vi.fn(),
	isLoginCommand: () => null,
	listenForOAuthResult: vi.fn(() => () => {}),
}));
vi.mock("$lib/commands.js", () => ({ isModelCommand: () => null }));
vi.mock("$lib/sub-conversation-store.svelte.js", () => ({
	subConversationStore: {
		get activeSubConversation() {
			return null;
		},
		get isInSubConversation() {
			return false;
		},
		get activeSubConversationId() {
			return null;
		},
		get subConvoMessages() {
			return [];
		},
		startSubConversation: vi.fn(),
		endSubConversation: vi.fn(() => []),
		addMessage: vi.fn(),
		setStreaming: vi.fn(),
	},
}));
vi.mock("$lib/mention-logic.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/mention-logic.js")>();
	return { ...actual };
});
vi.mock("$lib/utils/fetch-policy.js", () => ({
	userFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
	backgroundFetch: vi.fn(async (_key: string, url: string) => {
		if (url.includes("messages?all=true")) {
			return { ok: true, json: async () => [] };
		}
		if (url.includes("withToolCalls=true")) {
			return {
				ok: true,
				json: async () => ({
					messages: [],
					orphanedToolCalls: [],
					subConversations: [],
					subConversationToolCalls: {},
				}),
			};
		}
		if (/\/api\/conversations\/[^/]+$/.test(url)) {
			return {
				ok: true,
				json: async () => ({
					id: "conv-1",
					projectId: "proj-1",
					model: null,
					provider: null,
					modeId: null,
				}),
			};
		}
		return null;
	}),
	invalidate: vi.fn(),
}));
vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("$app/state", () => ({
	page: { params: { id: "proj-1", convId: "conv-1" }, url: new URL("http://x/") },
}));

import ChatThread from "../ChatThread.svelte";

beforeEach(() => {
	fetchAllMessagesMock.mockReset();
	fetchAllMessagesMock.mockResolvedValue([]);
	__resetCapabilityCacheForTests();
	type AnyCtor = { new (...a: unknown[]): unknown };
	const g = globalThis as unknown as {
		IntersectionObserver?: AnyCtor;
		ResizeObserver?: AnyCtor;
		fetch?: typeof fetch;
	};
	if (typeof g.IntersectionObserver === "undefined") {
		g.IntersectionObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as AnyCtor;
	}
	if (typeof g.ResizeObserver === "undefined") {
		g.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as AnyCtor;
	}
	if (!Element.prototype.scrollIntoView) {
		Element.prototype.scrollIntoView = () => {};
	}
	const capsFetch = makeCapabilitiesFetch();
	g.fetch = vi.fn(
		async (input: RequestInfo | URL) =>
			capsFetch(input) ??
			new Response(JSON.stringify({}), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	) as unknown as typeof fetch;
});

function conv(o: Partial<Conversation> = {}): Conversation {
	return {
		id: "conv-1",
		projectId: "proj-1",
		modeId: "mode-7",
		model: null,
		provider: null,
		...o,
	} as Conversation;
}

describe("ChatThread oncurrentconversation surfacing contract", () => {
	test("surfaces the conversation (id + modeId) up to the shell", async () => {
		const oncurrentconversation = vi.fn();
		const c = conv();
		render(ChatThread, {
			conversationId: "conv-1",
			projectId: "proj-1",
			currentConversation: c,
			oncurrentconversation,
		});
		await tick();

		await vi.waitFor(() => {
			expect(oncurrentconversation).toHaveBeenCalled();
		});
		// The callback carries the loaded conversation object — its `id`
		// and `modeId` are what the shell reads to inherit `selectedMode`.
		const surfaced = oncurrentconversation.mock.calls
			.map((c) => c[0])
			.find((arg): arg is Conversation => arg != null);
		expect(surfaced).toBeTruthy();
		expect(surfaced!.id).toBe("conv-1");
		expect(surfaced!.modeId).toBe("mode-7");
	});

	test("a prop change re-surfaces the updated conversation", async () => {
		const oncurrentconversation = vi.fn();
		const { rerender } = render(ChatThread, {
			conversationId: "conv-1",
			projectId: "proj-1",
			currentConversation: conv({ modeId: "mode-7" }),
			oncurrentconversation,
		});
		await tick();
		await vi.waitFor(() =>
			expect(oncurrentconversation).toHaveBeenCalled(),
		);

		oncurrentconversation.mockClear();
		await rerender({
			conversationId: "conv-1",
			projectId: "proj-1",
			currentConversation: conv({ modeId: "mode-99" }),
			oncurrentconversation,
		});
		await tick();

		await vi.waitFor(() => {
			const latest = oncurrentconversation.mock.calls
				.map((c) => c[0])
				.find(
					(arg): arg is Conversation =>
						arg != null && arg.modeId === "mode-99",
				);
			expect(latest).toBeTruthy();
			expect(latest!.id).toBe("conv-1");
		});
	});
});
