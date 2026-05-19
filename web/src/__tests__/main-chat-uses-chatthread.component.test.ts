/**
 * PHASE 4 — the main chat page renders EXACTLY ONE <ChatThread>.
 *
 * The DRY guarantee: after the extraction the page is a route shell that
 * delegates the whole thread to a single shared <ChatThread variant=
 * "page">. This test fails loudly if a future change reintroduces a
 * parallel inlined thread (two <ChatThread>s, or zero + a hand-rolled
 * message list) — the exact regression `ez-slop-cleaner` would flag.
 *
 * The route page pulls a large dependency graph (sidebar, header,
 * side-panels). We stub the leaf modules so the assertion is purely
 * "the shell mounts one ChatThread", not transport.
 *
 * vitest + jsdom + @testing-library/svelte.
 */

import { render } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("$app/state", () => ({
	page: {
		params: { id: "proj-1", convId: "conv-1" },
		url: new URL("http://localhost/project/proj-1/chat/conv-1"),
	},
}));
vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("$app/environment", () => ({
	browser: true,
	dev: false,
	building: false,
	version: "test",
}));
vi.mock("$lib/api.js", () => ({
	fetchModes: vi.fn(async () => []),
	createConversation: vi.fn(async () => ({ id: "new" })),
	updateConversation: vi.fn(async () => ({ id: "conv-1" })),
	fetchAllMessages: vi.fn(async () => []),
	sendMessage: vi.fn(),
	createSubConversation: vi.fn(),
	cloneTurns: vi.fn(),
	setMessageExcluded: vi.fn(),
	patchMessageContent: vi.fn(),
}));
vi.mock("$lib/oauth.js", () => ({
	listenForOAuthResult: vi.fn(() => () => {}),
	startOAuthFlow: vi.fn(),
	completeOAuthWithCode: vi.fn(),
	isLoginCommand: () => null,
}));
vi.mock("$lib/commands.js", () => ({ isModelCommand: () => null }));
vi.mock("$lib/mention-logic.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/mention-logic.js")>();
	return { ...actual };
});
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
vi.mock("$lib/utils/fetch-policy.js", () => ({
	userFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
	backgroundFetch: vi.fn(async () => null),
	invalidate: vi.fn(),
}));

import Page from "../routes/(app)/project/[id]/chat/[convId]/+page.svelte";

beforeEach(() => {
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
	g.fetch = vi.fn(async () =>
		new Response(JSON.stringify({ value: false, tools: [] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	) as unknown as typeof fetch;
});

describe("main chat page renders exactly one <ChatThread>", () => {
	test("mounts a single ChatThread (variant=page) — no parallel thread", () => {
		const { container } = render(Page);
		const threads = container.querySelectorAll(
			'[data-testid="chat-thread"]',
		);
		expect(threads.length).toBe(1);
		expect(threads[0]!.getAttribute("data-variant")).toBe("page");
	});

	test("the page does NOT itself render a second messages container", () => {
		const { container } = render(Page);
		// ChatThread owns the only messages container; the shell must
		// not hand-roll a parallel one.
		const containers = container.querySelectorAll(
			'[data-testid="chat-messages-container"]',
		);
		expect(containers.length).toBe(1);
	});
});
