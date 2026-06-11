/**
 * ChatThread → `chrome.loadedTools` surfacing contract (integration).
 *
 * Regression pin for "loaded tools in chat always shows 0": ChatThread
 * fetches `/api/tools` on mount, but the chrome-state object handed to
 * the page's header snippet never carried the result — so the route
 * shell could only pass `loadedTools={[]}` to ChatHeader and the badge
 * was permanently 0. This suite mounts the REAL <ChatThread> through a
 * probe harness whose header snippet reads `chrome.loadedTools` (the
 * exact consumption path of the page's <ChatHeader>) and asserts the
 * fetched tools flow through. Also pins the mode-scoping contract: the
 * fetch carries conversationId, refetches with modeId when a mode is
 * picked, and the chrome then carries ONLY the mode's tools.
 *
 * Mocking style mirrors the sibling
 * `ChatThread.oncurrentconversation.component.test.ts` (only
 * network/IO leaves stubbed). vitest + jsdom + @testing-library/svelte.
 */

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Message } from "$lib/api.js";
import { __resetCapabilityCacheForTests } from "$lib/chat/attachment-client";
import { makeCapabilitiesFetch } from "../../../__tests__/stubs/model-capabilities";

vi.mock("$lib/api.js", () => ({
	sendMessage: vi.fn(),
	updateConversation: vi.fn(async (id: string) => ({ id })),
	createSubConversation: vi.fn(async () => ({ id: "sub-1", agentConfigId: "" })),
	cloneTurns: vi.fn(async () => ({ id: "x" })),
	setMessageExcluded: vi.fn(async (_c: string, id: string, ex: boolean) => ({
		id,
		excluded: ex,
	})),
	fetchAllMessages: vi.fn(async () => [] as Message[]),
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

import Probe from "./ChatThreadLoadedToolsProbe.svelte";

const mockTools = [
	{ name: "scan", description: "Scan code", extension: "analyzer", extensionType: "extension", tokenEstimate: 25 },
	{ name: "summarize", description: "Summarize text", extension: "markdown-utils", extensionType: "mcp", tokenEstimate: 30 },
];

// The mode-scoped subset the stub serves when `modeId=mode-scoped` is on
// the request — mirrors the server, which filters the listing through the
// same computeModeToolScope the executor uses.
const modeScopedTools = [mockTools[0]!];

let toolsResponse: (url: string) => Response;
let toolsRequests: string[];

beforeEach(() => {
	__resetCapabilityCacheForTests();
	toolsRequests = [];
	toolsResponse = (url: string) => {
		const scoped = new URL(url, "http://localhost").searchParams.get("modeId") === "mode-scoped";
		const tools = scoped ? modeScopedTools : mockTools;
		return new Response(JSON.stringify({ tools, count: tools.length }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
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
	g.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.includes("/api/tools")) {
			toolsRequests.push(url);
			return toolsResponse(url);
		}
		if (url.includes("/api/extensions")) {
			// One installed extension matching the mocked analyzer tool, so the
			// composer's Tools dropdown renders a real toggle for the
			// nonce-refetch test below.
			return new Response(
				JSON.stringify({
					extensions: [
						{ id: "ext-analyzer", name: "analyzer", manifest: { tools: [{ name: "scan" }] } },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		return (
			capsFetch(input) ??
			new Response(JSON.stringify({}), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		);
	}) as unknown as typeof fetch;
});

describe("ChatThread chrome.loadedTools surfacing contract", () => {
	test("fetched /api/tools land on chrome.loadedTools for the header snippet", async () => {
		const { getByTestId } = render(Probe, {});
		await tick();

		await vi.waitFor(() => {
			expect(getByTestId("probe-tool-count")).toHaveTextContent("2");
		});
		expect(getByTestId("probe-tool-names")).toHaveTextContent("scan,summarize");
	});

	test("a failed /api/tools fetch leaves chrome.loadedTools empty (badge shows 0)", async () => {
		toolsResponse = () => new Response("nope", { status: 500 });
		const { getByTestId } = render(Probe, {});
		await tick();

		// Give the swallowed fetch chain a beat to settle, then assert
		// the chrome still carries an empty (not undefined) list.
		await new Promise((r) => setTimeout(r, 0));
		expect(getByTestId("probe-tool-count")).toHaveTextContent("0");
		expect(getByTestId("probe-tool-names")).toHaveTextContent("");
	});

	test("the request is scoped to the conversation (server applies mode/conv narrowing)", async () => {
		const { getByTestId } = render(Probe, {});
		await tick();
		await vi.waitFor(() => {
			expect(getByTestId("probe-tool-count")).toHaveTextContent("2");
		});
		expect(toolsRequests.length).toBeGreaterThan(0);
		const first = new URL(toolsRequests[0]!, "http://localhost");
		expect(first.searchParams.get("conversationId")).toBe("conv-1");
		expect(first.searchParams.get("modeId")).toBeNull();
	});

	test("setting a mode refetches with modeId and chrome carries ONLY the mode's tools", async () => {
		const { getByTestId, rerender } = render(Probe, {});
		await tick();
		await vi.waitFor(() => {
			expect(getByTestId("probe-tool-count")).toHaveTextContent("2");
		});

		await rerender({ selectedMode: { id: "mode-scoped", name: "Scoped" } as never });
		await tick();

		await vi.waitFor(() => {
			expect(getByTestId("probe-tool-count")).toHaveTextContent("1");
		});
		// Exactly the mode-scoped tool — the unscoped extra never reappears.
		expect(getByTestId("probe-tool-names")).toHaveTextContent("scan");
		const last = new URL(toolsRequests[toolsRequests.length - 1]!, "http://localhost");
		expect(last.searchParams.get("modeId")).toBe("mode-scoped");
		expect(last.searchParams.get("conversationId")).toBe("conv-1");

		// Clearing the mode restores the unscoped listing — and the request
		// carries an EXPLICIT empty modeId (authoritative "no mode"), so the
		// server never falls back to the conversation's possibly-stale
		// persisted modeId (the PUT that nulls it is fire-and-forget).
		await rerender({ selectedMode: null });
		await tick();
		await vi.waitFor(() => {
			expect(getByTestId("probe-tool-count")).toHaveTextContent("2");
		});
		const cleared = new URL(toolsRequests[toolsRequests.length - 1]!, "http://localhost");
		expect(cleared.searchParams.has("modeId")).toBe(true);
		expect(cleared.searchParams.get("modeId")).toBe("");
	});

	test("toggling a tool in the composer dropdown refetches the badge after the PUT lands", async () => {
		const { getByTestId, findByTestId } = render(Probe, {});
		await tick();
		await vi.waitFor(() => {
			expect(getByTestId("probe-tool-count")).toHaveTextContent("2");
		});
		const requestsBefore = toolsRequests.length;

		// Open the real composer Tools dropdown (real ChatInput →
		// ConversationToolsSelector) and master-toggle the analyzer
		// extension off. persistExtensionTools awaits the (mocked)
		// updateConversation PUT, then bumps the refetch nonce.
		const { fireEvent } = await import("@testing-library/svelte");
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		const master = await findByTestId("conv-ext-toggle-ext-analyzer");
		await fireEvent.click(master);

		await vi.waitFor(() => {
			expect(toolsRequests.length).toBeGreaterThan(requestsBefore);
		});
		// Same scope params as the initial fetch — the server recomputes the
		// narrowing from the freshly-persisted conv.extensionTools.
		const refetch = new URL(toolsRequests[toolsRequests.length - 1]!, "http://localhost");
		expect(refetch.searchParams.get("conversationId")).toBe("conv-1");
	});
});
