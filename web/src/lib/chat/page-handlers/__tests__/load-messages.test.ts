/**
 * Unit tests for the load-messages module extracted from
 * `routes/(app)/project/[id]/chat/[convId]/+page.svelte` (W5 of the chat-page
 * split).
 *
 * The module exposes three groups of API:
 *   1. Pure tree-walk helpers (`findLeafByMessageId`, `computeLatestLeaf`) and
 *      the pure transform `hydrateToolCallsFromApiData`. These are tested
 *      with no mocking — they take a `Message[]` snapshot in and return a
 *      derived value.
 *   2. The stateful factory `makeLoadMessages(host)` which wraps
 *      `backgroundFetch` and `inlineToolStore` calls behind a per-convId
 *      in-flight Map. We mock the network and store and assert call
 *      counts / wiring.
 *
 * `restoreLastModel` is mocked so the "preload from localStorage" path
 * doesn't depend on a stub Storage implementation in the test file; the
 * dedicated `last-model` test suite already covers that helper.
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import type { Conversation, Message, Mode } from "$lib/api.js";
import type { SubConvoRecord } from "$lib/sub-convo-agent-state.js";

// ── Mocks ────────────────────────────────────────────────────────────────

const backgroundFetchMock = mock(
	async (
		_key: string,
		_url: string,
		_init?: RequestInit,
		_opts?: { minIntervalMs?: number },
	): Promise<Response | null> => null,
);

const hydrateToolCallsMock = mock(
	(_convId: string, _calls: Array<Record<string, unknown>>) => {},
);

const restoreLastModelMock = mock(
	(_storage: Storage | null) => null as { provider: string; model: string } | null,
);

// Stub userFetch + invalidate too — the module is shared across the
// page-handlers test suite; another test file (`inline-tool-handlers`)
// imports userFetch, and bun's mock.module replaces the export object
// for the whole process.
const userFetchMock = mock(async (_url: string, _init?: RequestInit) =>
	new Response(JSON.stringify({ tools: [] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	}),
);
mock.module("$lib/utils/fetch-policy.js", () => ({
	backgroundFetch: backgroundFetchMock,
	userFetch: userFetchMock,
	invalidate: mock(() => {}),
}));

mock.module("$lib/inline-tool-store.svelte.js", () => ({
	inlineToolStore: {
		hydrateToolCalls: hydrateToolCallsMock,
	},
}));

mock.module("$lib/last-model.js", () => ({
	restoreLastModel: restoreLastModelMock,
	persistLastModel: mock(() => {}),
}));

afterAll(() => mock.restore());

// Now safe to import the SUT.
const {
	findLeafByMessageId,
	computeLatestLeaf,
	hydrateToolCallsFromApiData,
	makeLoadMessages,
} = await import("../load-messages.ts");

type LoadMessagesHost = import("../load-messages.ts").LoadMessagesHost;
type HistoricalToolCall = import("../load-messages.ts").HistoricalToolCall;

// ── Helpers ──────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<Message> & { id: string }): Message {
	return {
		conversationId: "conv-1",
		role: "user",
		content: "",
		thinkingContent: null,
		model: null,
		provider: null,
		usage: null,
		runId: null,
		parentMessageId: null,
		excluded: false,
		createdAt: "2025-01-01T00:00:00.000Z",
		...overrides,
	};
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

interface HostState {
	convId: string;
	allMessages: Message[];
	activeLeafId: string | null;
	editingMessageId: string | null;
	error: string | null;
	currentConversation: Conversation | null;
	selectedModel: { provider: string; model: string } | null;
	selectedMode: Mode | null;
	availableModes: Mode[];
	historicalToolCalls: HistoricalToolCall[];
	subConversations: SubConvoRecord[];
	localStorage: Storage | null;
}

function makeHost(initial: Partial<HostState> = {}): {
	host: LoadMessagesHost;
	state: HostState;
} {
	const state: HostState = {
		convId: "conv-1",
		allMessages: [],
		activeLeafId: null,
		editingMessageId: null,
		error: null,
		currentConversation: null,
		selectedModel: null,
		selectedMode: null,
		availableModes: [],
		historicalToolCalls: [],
		subConversations: [],
		localStorage: null,
		...initial,
	};
	const host: LoadMessagesHost = {
		convId: () => state.convId,
		allMessages: { get: () => state.allMessages, set: (v) => { state.allMessages = v; } },
		activeLeafId: { get: () => state.activeLeafId, set: (v) => { state.activeLeafId = v; } },
		editingMessageId: { get: () => state.editingMessageId, set: (v) => { state.editingMessageId = v; } },
		error: { get: () => state.error, set: (v) => { state.error = v; } },
		currentConversation: { get: () => state.currentConversation, set: (v) => { state.currentConversation = v; } },
		selectedModel: { get: () => state.selectedModel, set: (v) => { state.selectedModel = v; } },
		selectedMode: { get: () => state.selectedMode, set: (v) => { state.selectedMode = v; } },
		availableModes: () => state.availableModes,
		historicalToolCalls: { get: () => state.historicalToolCalls, set: (v) => { state.historicalToolCalls = v; } },
		subConversations: { get: () => state.subConversations, set: (v) => { state.subConversations = v; } },
		localStorage: () => state.localStorage,
	};
	return { host, state };
}

beforeEach(() => {
	backgroundFetchMock.mockClear();
	hydrateToolCallsMock.mockClear();
	restoreLastModelMock.mockClear();
	backgroundFetchMock.mockImplementation(async () => null);
	restoreLastModelMock.mockImplementation(() => null);
});

// ── Pure helpers ─────────────────────────────────────────────────────────

describe("findLeafByMessageId", () => {
	test("returns the input id when the message has no children", () => {
		const messages = [makeMessage({ id: "a" })];
		expect(findLeafByMessageId(messages, "a")).toBe("a");
	});

	test("walks forward through children, picking the latest by createdAt", () => {
		const messages = [
			makeMessage({ id: "root" }),
			makeMessage({ id: "c1", parentMessageId: "root", createdAt: "2025-01-01T00:00:01.000Z" }),
			makeMessage({ id: "c2", parentMessageId: "root", createdAt: "2025-01-01T00:00:02.000Z" }), // latest
			makeMessage({ id: "c2-child", parentMessageId: "c2", createdAt: "2025-01-01T00:00:03.000Z" }),
		];
		expect(findLeafByMessageId(messages, "root")).toBe("c2-child");
	});

	test("returns the input id unchanged when not present in messages (no walk progresses)", () => {
		// The original page's behavior: if the id isn't in the map, the
		// child-filter returns [] and the loop returns the seed id.
		expect(findLeafByMessageId([makeMessage({ id: "x" })], "missing")).toBe("missing");
	});

	test("handles an empty messages array", () => {
		expect(findLeafByMessageId([], "any")).toBe("any");
	});

	test("breaks ties by taking the lexicographically latest createdAt", () => {
		// Two children with identical timestamps — the original sort is stable,
		// but our spec says "latest" so for equal timestamps any deterministic
		// pick is fine. We assert it doesn't throw and picks one of them.
		const messages = [
			makeMessage({ id: "root" }),
			makeMessage({ id: "c1", parentMessageId: "root", createdAt: "2025-01-01T00:00:01.000Z" }),
			makeMessage({ id: "c2", parentMessageId: "root", createdAt: "2025-01-01T00:00:01.000Z" }),
		];
		const leaf = findLeafByMessageId(messages, "root");
		expect(["c1", "c2"]).toContain(leaf);
	});
});

describe("computeLatestLeaf", () => {
	test("returns null on an empty array", () => {
		expect(computeLatestLeaf([])).toBeNull();
	});

	test("returns the only message when the tree is a single node", () => {
		expect(computeLatestLeaf([makeMessage({ id: "solo" })])).toBe("solo");
	});

	test("returns the most recently-created leaf in a branched tree", () => {
		const messages = [
			makeMessage({ id: "root", createdAt: "2025-01-01T00:00:00.000Z" }),
			// Branch A
			makeMessage({ id: "a1", parentMessageId: "root", createdAt: "2025-01-01T00:00:01.000Z" }),
			makeMessage({ id: "a2", parentMessageId: "a1", createdAt: "2025-01-01T00:00:02.000Z" }),
			// Branch B (newer leaf)
			makeMessage({ id: "b1", parentMessageId: "root", createdAt: "2025-01-01T00:00:03.000Z" }),
			makeMessage({ id: "b2", parentMessageId: "b1", createdAt: "2025-01-01T00:00:05.000Z" }),
			// Branch C (older leaf)
			makeMessage({ id: "c1", parentMessageId: "root", createdAt: "2025-01-01T00:00:04.000Z" }),
		];
		expect(computeLatestLeaf(messages)).toBe("b2");
	});

	test("falls back to the last array entry when every message is a parent of another (no leaves)", () => {
		// Synthesise a cyclic-ish shape — a → b, b → a — to force the
		// "leaves array empty" branch. Real data should never hit this,
		// but the original page has a defensive fallback.
		const messages = [
			makeMessage({ id: "a", parentMessageId: "b" }),
			makeMessage({ id: "b", parentMessageId: "a" }),
		];
		expect(computeLatestLeaf(messages)).toBe("b");
	});
});

describe("hydrateToolCallsFromApiData", () => {
	test("merges tool calls into messages by id, preserving order", () => {
		const data = {
			messages: [
				{
					id: "m1",
					toolCalls: [
						{
							id: "t1",
							extensionId: "ext-a",
							toolName: "tool-a",
							status: "success" as const,
							input: { x: 1 },
							outputSummary: "ok",
							success: true,
							durationMs: 10,
						},
					],
				},
				{
					id: "m2",
					toolCalls: [
						{
							id: "t2",
							extensionId: "ext-b",
							toolName: "tool-b",
							status: "error" as const,
							input: null,
							outputSummary: null,
							success: false,
							durationMs: 5,
						},
					],
				},
			],
		};
		const bundle = hydrateToolCallsFromApiData(data);
		expect(bundle.historicalToolCalls).toEqual([
			{ id: "t1", messageId: "m1", extensionId: "ext-a", toolName: "tool-a", status: "success" },
			{ id: "t2", messageId: "m2", extensionId: "ext-b", toolName: "tool-b", status: "error" },
		]);
		expect(bundle.hydrateInput.map((c) => c.id)).toEqual(["t1", "t2"]);
		expect(bundle.hydrateInput[0]).toMatchObject({ messageId: "m1", input: { x: 1 } });
	});

	test("orphaned tool calls are appended with their own messageId (null → undefined)", () => {
		const bundle = hydrateToolCallsFromApiData({
			messages: [],
			orphanedToolCalls: [
				{
					id: "orph-1",
					extensionId: "e",
					toolName: "t",
					status: "success",
					input: null,
					outputSummary: null,
					success: true,
					durationMs: 1,
					messageId: null,
				},
				{
					id: "orph-2",
					extensionId: "e",
					toolName: "t",
					status: "success",
					input: null,
					outputSummary: null,
					success: true,
					durationMs: 1,
					messageId: "anchor",
				},
			],
		});
		expect(bundle.historicalToolCalls).toEqual([]);
		expect(bundle.hydrateInput[0]).toMatchObject({ messageId: undefined });
		expect(bundle.hydrateInput[1]).toMatchObject({ messageId: "anchor" });
	});

	test("returns subConversations array when the response includes any (with default fills)", () => {
		const bundle = hydrateToolCallsFromApiData({
			subConversations: [
				{ id: "sub-1", agentName: "Agent", parentMessageId: "p1" },
				{ id: "sub-2" }, // missing all optional fields
			],
		});
		expect(bundle.subConversations).toEqual([
			{
				id: "sub-1",
				agentName: "Agent",
				agentConfigId: "",
				parentMessageId: "p1",
				messageCount: 0,
				lastMessagePreview: null,
			},
			{
				id: "sub-2",
				agentName: "Agent",
				agentConfigId: "",
				parentMessageId: "",
				messageCount: 0,
				lastMessagePreview: null,
			},
		]);
	});

	test("returns null subConversations when the response omits the array", () => {
		// Distinct from `[]` — the loader uses `null` as a sentinel "do not
		// touch the host slot" so an empty server response doesn't wipe a
		// previously-loaded list.
		const bundle = hydrateToolCallsFromApiData({});
		expect(bundle.subConversations).toBeNull();
	});

	test("no-ops when all input arrays are empty/missing", () => {
		const bundle = hydrateToolCallsFromApiData({});
		expect(bundle.historicalToolCalls).toEqual([]);
		expect(bundle.hydrateInput).toEqual([]);
		expect(bundle.subToolCalls).toEqual({});
	});

	test("subConversationToolCalls are keyed by sub id with messageId normalised", () => {
		const bundle = hydrateToolCallsFromApiData({
			subConversationToolCalls: {
				"sub-a": [
					{
						id: "stc-1",
						extensionId: "e",
						toolName: "t",
						status: "success",
						input: null,
						outputSummary: null,
						success: true,
						durationMs: 1,
						messageId: null,
					},
				],
			},
		});
		expect(bundle.subToolCalls["sub-a"]?.[0]).toMatchObject({ id: "stc-1", messageId: undefined });
	});
});

// ── Stateful loaders ────────────────────────────────────────────────────

describe("makeLoadMessages.loadMessages", () => {
	test("calls the messages + conversation API once and writes results via host setters", async () => {
		const messages = [makeMessage({ id: "m1", createdAt: "2025-01-01T00:00:01.000Z" })];
		const conv: Conversation = {
			id: "conv-1",
			projectId: "p",
			title: "T",
			model: "claude-sonnet",
			provider: "anthropic",
			systemPrompt: null,
			agentConfigId: null,
			modeId: null,
			test: null,
			createdAt: "2025-01-01T00:00:00Z",
			updatedAt: "2025-01-01T00:00:00Z",
		};
		backgroundFetchMock.mockImplementation(async (key: string) => {
			if (key.startsWith("messages-all:")) return jsonResponse(messages);
			if (key.startsWith("conv:")) return jsonResponse(conv);
			if (key.startsWith("messages-tools:")) return jsonResponse({});
			return null;
		});

		const { host, state } = makeHost();
		const api = makeLoadMessages(host);
		await api.loadMessages();

		// Three URL keys: messages-all, conv, messages-tools (from the
		// chained hydrateToolCallsFromApi).
		const keys = backgroundFetchMock.mock.calls.map((c) => c[0]);
		expect(keys).toContain("messages-all:conv-1");
		expect(keys).toContain("conv:conv-1");
		expect(keys).toContain("messages-tools:conv-1");

		expect(state.allMessages).toEqual(messages);
		expect(state.activeLeafId).toBe("m1");
		expect(state.currentConversation).toEqual(conv);
		// Conversation's stored model wins over localStorage.
		expect(state.selectedModel).toEqual({ provider: "anthropic", model: "claude-sonnet" });
		expect(state.error).toBeNull();
	});

	test("no-ops when convId is empty", async () => {
		const { host, state } = makeHost({ convId: "" });
		const api = makeLoadMessages(host);
		await api.loadMessages();
		expect(backgroundFetchMock).not.toHaveBeenCalled();
		expect(state.error).toBeNull();
	});

	test("dedup: two concurrent calls share one in-flight request", async () => {
		// Resolve `messages-all` only after we've started both calls.
		let resolveMsgs: (r: Response) => void = () => {};
		const msgsPromise = new Promise<Response>((r) => { resolveMsgs = r; });

		backgroundFetchMock.mockImplementation(async (key: string) => {
			if (key.startsWith("messages-all:")) return msgsPromise;
			if (key.startsWith("conv:")) return jsonResponse({ id: "conv-1" });
			if (key.startsWith("messages-tools:")) return jsonResponse({});
			return null;
		});

		const { host } = makeHost();
		const api = makeLoadMessages(host);

		const p1 = api.loadMessages();
		const p2 = api.loadMessages();

		// Resolve the in-flight messages fetch — both promises should now
		// settle without a second messages-all call.
		resolveMsgs(jsonResponse([]));
		await Promise.all([p1, p2]);

		const messagesAllCalls = backgroundFetchMock.mock.calls.filter((c) =>
			(c[0] as string).startsWith("messages-all:"),
		);
		expect(messagesAllCalls).toHaveLength(1);
	});

	test("cooldown: a throttled `null` from backgroundFetch leaves allMessages unchanged", async () => {
		// Simulate fetch-policy throttling — backgroundFetch returns null
		// for messages-all but a real response for conv.
		const seed = [makeMessage({ id: "seeded" })];
		backgroundFetchMock.mockImplementation(async (key: string) => {
			if (key.startsWith("messages-all:")) return null; // throttled
			if (key.startsWith("conv:")) return jsonResponse({ id: "conv-1" });
			if (key.startsWith("messages-tools:")) return jsonResponse({});
			return null;
		});

		const { host, state } = makeHost({ allMessages: seed });
		const api = makeLoadMessages(host);
		await api.loadMessages();

		// Existing allMessages stays current — the WS push path keeps it live.
		expect(state.allMessages).toBe(seed);
		// activeLeafId is still recomputed from the (unchanged) allMessages.
		expect(state.activeLeafId).toBe("seeded");
	});

	test("convId getter is read fresh each call (mutate host between calls)", async () => {
		backgroundFetchMock.mockImplementation(async (_key: string) => jsonResponse([]));
		const { host, state } = makeHost({ convId: "first" });
		const api = makeLoadMessages(host);

		await api.loadMessages();
		state.convId = "second";
		await api.loadMessages();

		const firstKeys = backgroundFetchMock.mock.calls
			.map((c) => c[0] as string)
			.filter((k) => k.startsWith("messages-all:"));
		expect(firstKeys).toEqual(["messages-all:first", "messages-all:second"]);
	});

	test("preloads selectedModel from localStorage when none is set", async () => {
		restoreLastModelMock.mockImplementation(() => ({
			provider: "openai",
			model: "gpt-4o",
		}));
		backgroundFetchMock.mockImplementation(async (key: string) => {
			if (key.startsWith("messages-all:")) return jsonResponse([]);
			if (key.startsWith("conv:")) {
				// Conversation has no model — localStorage preload should stick.
				return jsonResponse({ id: "conv-1", model: null, provider: null, modeId: null });
			}
			return jsonResponse({});
		});
		const stubStorage = {} as unknown as Storage;
		const { host, state } = makeHost({ localStorage: stubStorage });
		await makeLoadMessages(host).loadMessages();

		expect(restoreLastModelMock).toHaveBeenCalledWith(stubStorage);
		expect(state.selectedModel).toEqual({ provider: "openai", model: "gpt-4o" });
	});

	test("does NOT preload from localStorage when selectedModel is already set", async () => {
		backgroundFetchMock.mockImplementation(async () => jsonResponse([]));
		const { host } = makeHost({
			selectedModel: { provider: "anthropic", model: "sonnet" },
		});
		await makeLoadMessages(host).loadMessages();
		expect(restoreLastModelMock).not.toHaveBeenCalled();
	});

	test("restores selectedMode from conversation.modeId by id lookup in availableModes", async () => {
		const mode: Mode = {
			id: "mode-x",
			name: "X",
			slug: "x",
			icon: null,
			description: "",
			systemPromptInstruction: "",
			instructionPosition: "append",
			preferredModel: null,
			preferredProvider: null,
			preferredThinkingLevel: null,
			temperature: null,
			toolRestriction: "all",
			extensionIds: null,
			builtin: false,
		};
		backgroundFetchMock.mockImplementation(async (key: string) => {
			if (key.startsWith("messages-all:")) return jsonResponse([]);
			if (key.startsWith("conv:")) return jsonResponse({ id: "conv-1", modeId: "mode-x" });
			return jsonResponse({});
		});
		const { host, state } = makeHost({ availableModes: [mode] });
		await makeLoadMessages(host).loadMessages();
		expect(state.selectedMode).toEqual(mode);
	});

	test("clears selectedMode when conversation has no modeId", async () => {
		const mode: Mode = {
			id: "mode-x", name: "X", slug: "x", icon: null, description: "",
			systemPromptInstruction: "", instructionPosition: "append",
			preferredModel: null, preferredProvider: null, preferredThinkingLevel: null,
			temperature: null, toolRestriction: "all", extensionIds: null, builtin: false,
		};
		backgroundFetchMock.mockImplementation(async (key: string) => {
			if (key.startsWith("messages-all:")) return jsonResponse([]);
			if (key.startsWith("conv:")) return jsonResponse({ id: "conv-1", modeId: null });
			return jsonResponse({});
		});
		const { host, state } = makeHost({ availableModes: [mode], selectedMode: mode });
		await makeLoadMessages(host).loadMessages();
		expect(state.selectedMode).toBeNull();
	});

	test("sets error and logs when the messages fetch throws", async () => {
		backgroundFetchMock.mockImplementation(async (key: string) => {
			if (key.startsWith("messages-all:")) throw new Error("boom");
			return null;
		});
		const errSpy = mock(() => {});
		const originalError = console.error;
		console.error = errSpy;
		try {
			const { host, state } = makeHost();
			await makeLoadMessages(host).loadMessages();
			expect(state.error).toBe("Failed to load messages");
			expect(errSpy).toHaveBeenCalled();
		} finally {
			console.error = originalError;
		}
	});
});

describe("makeLoadMessages.hydrateToolCallsFromApi", () => {
	test("pushes historical and inline-store entries from the response", async () => {
		const data = {
			messages: [
				{
					id: "m1",
					toolCalls: [
						{
							id: "t1",
							extensionId: "ext-a",
							toolName: "tool-a",
							status: "success" as const,
							input: null,
							outputSummary: null,
							success: true,
							durationMs: 1,
						},
					],
				},
			],
			subConversations: [
				{ id: "sub-1", agentName: "A", parentMessageId: "p" },
			],
		};
		backgroundFetchMock.mockImplementation(async () => jsonResponse(data));

		const { host, state } = makeHost();
		await makeLoadMessages(host).hydrateToolCallsFromApi();

		expect(state.historicalToolCalls).toEqual([
			{ id: "t1", messageId: "m1", extensionId: "ext-a", toolName: "tool-a", status: "success" },
		]);
		expect(hydrateToolCallsMock).toHaveBeenCalled();
		expect(hydrateToolCallsMock.mock.calls[0]![0]).toBe("conv-1");
		expect(state.subConversations).toHaveLength(1);
		expect(state.subConversations[0]).toMatchObject({ id: "sub-1", agentName: "A" });
	});

	test("dedup: two concurrent calls share one in-flight hydrate request", async () => {
		let resolveRes: (r: Response) => void = () => {};
		const promised = new Promise<Response>((r) => { resolveRes = r; });
		backgroundFetchMock.mockImplementation(async () => promised);

		const { host } = makeHost();
		const api = makeLoadMessages(host);

		const p1 = api.hydrateToolCallsFromApi();
		const p2 = api.hydrateToolCallsFromApi();

		resolveRes(jsonResponse({}));
		await Promise.all([p1, p2]);

		expect(backgroundFetchMock).toHaveBeenCalledTimes(1);
	});

	test("returns silently on a non-ok response (no host writes)", async () => {
		backgroundFetchMock.mockImplementation(async () =>
			new Response("nope", { status: 500 }),
		);
		const { host, state } = makeHost({
			historicalToolCalls: [{
				id: "keep", messageId: "m", extensionId: "e", toolName: "t", status: "success",
			}],
		});
		await makeLoadMessages(host).hydrateToolCallsFromApi();
		expect(state.historicalToolCalls).toHaveLength(1); // unchanged
		expect(state.historicalToolCalls[0]?.id).toBe("keep");
		expect(hydrateToolCallsMock).not.toHaveBeenCalled();
	});

	test("returns silently when fetch-policy throttles (returns null)", async () => {
		backgroundFetchMock.mockImplementation(async () => null);
		const { host } = makeHost();
		await makeLoadMessages(host).hydrateToolCallsFromApi();
		expect(hydrateToolCallsMock).not.toHaveBeenCalled();
	});

	test("hydrates each sub-conversation tool-calls bucket separately, keyed by sub id", async () => {
		backgroundFetchMock.mockImplementation(async () =>
			jsonResponse({
				subConversationToolCalls: {
					"sub-a": [
						{ id: "a1", extensionId: "e", toolName: "t", status: "success", input: null, outputSummary: null, success: true, durationMs: 1 },
					],
					"sub-b": [
						{ id: "b1", extensionId: "e", toolName: "t", status: "success", input: null, outputSummary: null, success: true, durationMs: 1 },
					],
				},
			}),
		);
		const { host } = makeHost();
		await makeLoadMessages(host).hydrateToolCallsFromApi();

		// One call for the parent conv (with empty hydrateInput, since no
		// `messages` in this payload), plus one per sub bucket.
		const calls = hydrateToolCallsMock.mock.calls;
		const keys = calls.map((c) => c[0]);
		expect(keys).toContain("conv-1");
		expect(keys).toContain("sub-a");
		expect(keys).toContain("sub-b");
	});
});
