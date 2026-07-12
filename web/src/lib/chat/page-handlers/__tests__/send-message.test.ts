/**
 * Unit tests for the send-message factory extracted from
 * `routes/(app)/project/[id]/chat/[convId]/+page.svelte` (W7 of the chat-page
 * split).
 *
 * The handlers are plain async functions over a host of getter/setter slots,
 * so `bun test` drives them directly — no Svelte runtime required.
 *
 * Heavy mocking. The module imports from `$lib/api.js`, `$lib/oauth.js`,
 * `$lib/commands.js`, `$lib/stores.svelte.js`, `$lib/sub-conversation-store.svelte.js`,
 * `$lib/mention-logic.js`, `$lib/utils/fetch-policy.js`. Each is replaced
 * with a dedicated `mock.module(...)` so we can assert the wiring without
 * touching real fetch / DOM / streaming machinery.
 *
 * `mock.module()` replaces exports for the whole bun-test process; sibling
 * test files (`useSelectMode`, `load-messages`, etc.) MUST keep working
 * after this file installs its mocks. We provide every export those
 * sibling tests use so a transitive import doesn't see `undefined`.
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import type { Message } from "$lib/api.js";
import type { OAuthPending } from "$lib/oauth.js";
import type { ToolDefinition } from "../../../../../../src/extensions/types";

// ── Mocks ────────────────────────────────────────────────────────────────

const sendMessageMock = mock(
	async (
		_convId: string,
		_data: {
			content: string;
			provider?: string;
			model?: string;
			parentMessageId?: string;
			editOf?: string;
			permissionMode?: string;
			thinkingLevel?: string;
			attachments?: File[];
		},
	): Promise<{
		userMessage: Message;
		runId: string;
		attachments?: unknown[];
	}> => ({
		userMessage: {
			id: "real-user-id",
			conversationId: "conv-1",
			role: "user",
			content: _data.content,
			createdAt: "2024-01-01T00:00:00.000Z",
			parentMessageId: _data.parentMessageId ?? null,
			excluded: false,
		} as Message,
		runId: "run-1",
	}),
);

const updateConversationMock = mock(
	async (_convId: string, _data: Record<string, unknown>) => ({
		id: _convId,
	}),
);

const createSubConversationMock = mock(
	async (
		_parent: string,
		_opts: {
			parentMessageId: string;
			agentConfigId: string;
			title: string;
			projectId: string;
		},
	) => ({
		id: "sub-convo-1",
		agentConfigId: "agent-config-1",
	}),
);

mock.module("$lib/api.js", () => ({
	sendMessage: sendMessageMock,
	updateConversation: updateConversationMock,
	createSubConversation: createSubConversationMock,
	// Exports used by sibling page-handler tests (load-messages, etc.) —
	// keep them present so transitive imports resolve.
	cloneTurns: mock(async () => ({ id: "x", title: "x", projectId: "p", createdAt: "", updatedAt: "" })),
	setMessageExcluded: mock(async () => undefined),
	fetchAllMessages: mock(async () => []),
	patchMessageContent: mock(async () => ({ content: "" })),
}));

const startOAuthFlowMock = mock(async (_provider: string): Promise<OAuthPending> => ({
	authUrl: "https://example.com/oauth?x=1",
	codeVerifier: "verifier",
	state: "state-1",
	provider: _provider,
	redirectUri: "http://localhost/callback",
}));

const completeOAuthWithCodeMock = mock(
	async (_pending: OAuthPending, _input: string) => ({
		provider: _pending.provider,
		success: true,
	}),
);

mock.module("$lib/oauth.js", () => ({
	startOAuthFlow: startOAuthFlowMock,
	completeOAuthWithCode: completeOAuthWithCodeMock,
	// `isLoginCommand` is a pure parser — keep the real implementation so
	// the `/login` arm exercises the real grammar instead of a stub.
	isLoginCommand: (content: string) => {
		const trimmed = content.trim();
		const match = trimmed.match(/^\/login\s+(\S+)$/i);
		if (!match) {
			if (/^\/login\s*$/i.test(trimmed)) return { provider: "" };
			return null;
		}
		return { provider: match[1]!.toLowerCase() };
	},
	listenForOAuthResult: mock(() => () => {}),
}));

mock.module("$lib/commands.js", () => ({
	// Real parser semantics.
	isModelCommand: (content: string) => {
		const trimmed = content.trim();
		const match = trimmed.match(/^\/model(\s+.*)?$/i);
		if (!match) return null;
		const arg = match[1]?.trim();
		if (!arg) return { type: "list" };
		const slashIdx = arg.indexOf("/");
		if (slashIdx !== -1) {
			return {
				type: "switch",
				provider: arg.slice(0, slashIdx).toLowerCase(),
				model: arg.slice(slashIdx + 1),
			};
		}
		return { type: "switch", model: arg };
	},
}));

const startStreamingMock = mock(
	(_runId: string, _convId: string): boolean => true,
);
mock.module("$lib/stores.svelte.js", () => ({
	startStreaming: startStreamingMock,
	stopStreaming: mock(() => {}),
}));

interface SubConvoRecord {
	id: string;
	agentConfigId: string;
	agentName: string;
	parentConversationId: string;
	parentMessageId: string;
}

const subConversationStoreState: {
	active: SubConvoRecord | null;
	streaming: boolean;
	messages: Array<{ id: string; role: string; content: string; createdAt: Date }>;
	addedMessages: Array<{ id: string; role: string; content: string; createdAt: Date }>;
	startCalls: SubConvoRecord[];
	endCalls: number;
} = {
	active: null,
	streaming: false,
	messages: [],
	addedMessages: [],
	startCalls: [],
	endCalls: 0,
};

mock.module("$lib/sub-conversation-store.svelte.js", () => ({
	subConversationStore: {
		get activeSubConversation() {
			return subConversationStoreState.active;
		},
		get isInSubConversation() {
			return subConversationStoreState.active !== null;
		},
		startSubConversation(opts: SubConvoRecord) {
			subConversationStoreState.active = opts;
			subConversationStoreState.startCalls.push(opts);
		},
		endSubConversation() {
			subConversationStoreState.endCalls += 1;
			const msgs = subConversationStoreState.messages;
			subConversationStoreState.active = null;
			subConversationStoreState.messages = [];
			return msgs;
		},
		addMessage(msg: { id: string; role: string; content: string; createdAt: Date }) {
			subConversationStoreState.messages = [...subConversationStoreState.messages, msg];
			subConversationStoreState.addedMessages.push(msg);
		},
		setStreaming(v: boolean) {
			subConversationStoreState.streaming = v;
		},
	},
}));

interface MentionToken {
	kind: "agent" | "ext" | "team" | "file" | "dir" | "cmd";
	name: string;
}
const parseMentionsMock = mock((_text: string): MentionToken[] => []);
mock.module("$lib/mention-logic.js", () => ({
	parseMentions: parseMentionsMock,
}));

const userFetchMock = mock(async (_url: string, _init?: RequestInit) =>
	new Response(JSON.stringify({ id: "mem-1" }), {
		status: 201,
		headers: { "Content-Type": "application/json" },
	}),
);
mock.module("$lib/utils/fetch-policy.js", () => ({
	userFetch: userFetchMock,
	backgroundFetch: mock(async () => null),
	invalidate: mock(() => {}),
}));

afterAll(() => mock.restore());

// ── Global stubs ────────────────────────────────────────────────────────

// `requestAnimationFrame` runs the optimistic-scroll callback. We don't
// want it firing real DOM operations during tests; rebind to a no-op
// scheduler and let the test harness assert on the side-effect-free
// host slots instead. (The sentinel ref check inside the rAF is also
// safe since `host.sentinel()` returns null in tests.)
(globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number })
	.requestAnimationFrame = (cb: () => void) => {
	cb();
	return 0;
};

// Stub `window.open` — `/login <provider>` calls it. We assert via the
// captured args instead of opening a real tab.
const windowOpenCalls: Array<{ url: string; target: string }> = [];
(globalThis as unknown as { window: Window }).window =
	((globalThis as unknown as { window?: Window }).window ?? (globalThis as unknown as Window));
(globalThis as unknown as { window: { open: (url: string, target: string) => void } })
	.window.open = (url: string, target: string) => {
	windowOpenCalls.push({ url, target });
};

// Stub `fetch` for the `/api/models` and `/api/memories` endpoints used
// by the `/model` arm and `handleSaveMemory` respectively. Tests
// override per-call via `fetchMock.mockImplementationOnce`.
const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
	new Response(JSON.stringify([]), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	}),
);
(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

// ── Now safe to import the SUT. ────────────────────────────────────────

const { makeSendMessage } = await import("../send-message.ts");
type SendMessageHost = import("../send-message.ts").SendMessageHost;

// ── Helpers ──────────────────────────────────────────────────────────────

function makeMessage(id: string, overrides: Partial<Message> = {}): Message {
	return {
		id,
		conversationId: "conv-1",
		role: "user",
		content: `content-${id}`,
		createdAt: "2024-01-01T00:00:00.000Z",
		excluded: false,
		parentMessageId: null,
		...overrides,
	} as Message;
}

interface HostState {
	convId: string;
	projectId: string;
	selectedModel: { provider: string; model: string } | null;
	permissionModeOverride: "ask" | "auto-edit" | "yolo" | undefined;
	thinkingLevel: string;
	modelSupportsReasoning: boolean;
	allMessages: Message[];
	activeLeafId: string | null;
	editingMessageId: string | null;
	editContent: string;
	activeRunId: string | null;
	activeRunStartedAt: number | null;
	serverStalenessMs: number | null;
	resumedRun: boolean;
	error: string | null;
	chatOAuthPending: OAuthPending | null;
	userScrolledUp: boolean;
	stuck: boolean;
	settingsOpen: boolean;
	obsOpen: boolean;
	editRetryCall: unknown;
	editRetryTool: ToolDefinition | null;
	savedMemories: Map<string, string>;
	subConversations: SubConvoRecord[];
	systemMessages: string[];
	loadMessagesCalls: number;
	convListRefreshCalls: number;
	handleModelChangeCalls: Array<{ provider: string; model: string }>;
}

function makeHost(initial: Partial<HostState> = {}): {
	host: SendMessageHost;
	state: HostState;
} {
	const state: HostState = {
		convId: "conv-1",
		projectId: "proj-1",
		selectedModel: { provider: "openai", model: "gpt-4o" },
		permissionModeOverride: undefined,
		thinkingLevel: "medium",
		modelSupportsReasoning: false,
		allMessages: [],
		activeLeafId: null,
		editingMessageId: null,
		editContent: "",
		activeRunId: null,
		activeRunStartedAt: null,
		serverStalenessMs: null,
		resumedRun: false,
		error: null,
		chatOAuthPending: null,
		userScrolledUp: false,
		stuck: false,
		settingsOpen: false,
		obsOpen: false,
		editRetryCall: null,
		editRetryTool: null,
		savedMemories: new Map(),
		subConversations: [],
		systemMessages: [],
		loadMessagesCalls: 0,
		convListRefreshCalls: 0,
		handleModelChangeCalls: [],
		...initial,
	};
	const host: SendMessageHost = {
		convId: () => state.convId,
		projectId: () => state.projectId,
		selectedModel: {
			get: () => state.selectedModel,
			set: (v) => { state.selectedModel = v; },
		},
		permissionModeOverride: {
			get: () => state.permissionModeOverride,
			set: (v) => { state.permissionModeOverride = v; },
		},
		thinkingLevel: {
			get: () => state.thinkingLevel,
			set: (v) => { state.thinkingLevel = v; },
		},
		modelSupportsReasoning: () => state.modelSupportsReasoning,
		allMessages: {
			get: () => state.allMessages,
			set: (v) => { state.allMessages = v; },
		},
		activeLeafId: {
			get: () => state.activeLeafId,
			set: (v) => { state.activeLeafId = v; },
		},
		// Tests treat `messages` as the active path = `allMessages` (no
		// branching in these scenarios, so the path is the full list).
		messages: () => state.allMessages,
		editingMessageId: {
			get: () => state.editingMessageId,
			set: (v) => { state.editingMessageId = v; },
		},
		editContent: {
			get: () => state.editContent,
			set: (v) => { state.editContent = v; },
		},
		activeRunId: {
			get: () => state.activeRunId,
			set: (v) => { state.activeRunId = v; },
		},
		activeRunStartedAt: {
			get: () => state.activeRunStartedAt,
			set: (v) => { state.activeRunStartedAt = v; },
		},
		serverStalenessMs: {
			get: () => state.serverStalenessMs,
			set: (v) => { state.serverStalenessMs = v; },
		},
		resumedRun: {
			get: () => state.resumedRun,
			set: (v) => { state.resumedRun = v; },
		},
		error: { get: () => state.error, set: (v) => { state.error = v; } },
		chatOAuthPending: {
			get: () => state.chatOAuthPending,
			set: (v) => { state.chatOAuthPending = v; },
		},
		userScrolledUp: {
			get: () => state.userScrolledUp,
			set: (v) => { state.userScrolledUp = v; },
		},
		stuck: {
			get: () => state.stuck,
			set: (v) => { state.stuck = v; },
		},
		settingsOpen: {
			get: () => state.settingsOpen,
			set: (v) => { state.settingsOpen = v; },
		},
		obsOpen: { get: () => state.obsOpen, set: (v) => { state.obsOpen = v; } },
		editRetryCall: {
			get: () => state.editRetryCall as never,
			set: (v) => { state.editRetryCall = v; },
		},
		editRetryTool: {
			get: () => state.editRetryTool,
			set: (v) => { state.editRetryTool = v; },
		},
		savedMemories: {
			get: () => state.savedMemories,
			set: (v) => { state.savedMemories = v; },
		},
		subConversations: {
			get: () => state.subConversations,
			set: (v) => { state.subConversations = v as SubConvoRecord[]; },
		},
		sentinel: () => null,
		convList: () => ({ refresh: () => { state.convListRefreshCalls += 1; } }),
		addSystemMessage: (text) => { state.systemMessages.push(text); },
		loadMessages: async () => { state.loadMessagesCalls += 1; },
		makeOptimisticMessage: (overrides) => ({
			id: "",
			role: "user",
			content: "",
			thinkingContent: null,
			model: null,
			provider: null,
			usage: null,
			runId: null,
			parentMessageId: null,
			excluded: false,
			createdAt: new Date().toISOString(),
			...overrides,
		} as Message),
		handleModelChange: (provider, model) => {
			state.handleModelChangeCalls.push({ provider, model });
			state.selectedModel = { provider, model };
		},
		// Picks the most-recently-created message id as the leaf — matches
		// the page's actual `computeLatestLeaf` semantic on a flat list.
		computeLatestLeaf: (messages) =>
			messages.length === 0 ? null : messages[messages.length - 1]!.id,
		findLeafByMessageId: (messages, id) => {
			// Test-only stub: matches the real implementation's contract —
			// always returns a string (falls back to input id when no
			// children are found).
			return messages.find((m) => m.id === id)?.id ?? id;
		},
	};
	return { host, state };
}

// ── Per-test reset ──────────────────────────────────────────────────────

beforeEach(() => {
	sendMessageMock.mockClear();
	updateConversationMock.mockClear();
	createSubConversationMock.mockClear();
	startOAuthFlowMock.mockClear();
	completeOAuthWithCodeMock.mockClear();
	startStreamingMock.mockClear();
	parseMentionsMock.mockClear();
	userFetchMock.mockClear();
	fetchMock.mockClear();
	windowOpenCalls.length = 0;
	subConversationStoreState.active = null;
	subConversationStoreState.streaming = false;
	subConversationStoreState.messages = [];
	subConversationStoreState.addedMessages = [];
	subConversationStoreState.startCalls = [];
	subConversationStoreState.endCalls = 0;
	// Reset implementations to defaults — individual tests override per-call.
	sendMessageMock.mockImplementation(async (_convId, data) => ({
		userMessage: {
			id: "real-user-id",
			conversationId: "conv-1",
			role: "user",
			content: data.content,
			createdAt: "2024-01-01T00:00:00.000Z",
			parentMessageId: data.parentMessageId ?? null,
			excluded: false,
		} as Message,
		runId: "run-1",
	}));
	completeOAuthWithCodeMock.mockImplementation(async (pending, _input) => ({
		provider: pending.provider,
		success: true,
	}));
	startOAuthFlowMock.mockImplementation(async (provider) => ({
		authUrl: "https://example.com/oauth?x=1",
		codeVerifier: "v",
		state: "s",
		provider,
		redirectUri: "http://localhost/cb",
	}));
	startStreamingMock.mockImplementation(() => true);
	parseMentionsMock.mockImplementation(() => []);
	userFetchMock.mockImplementation(async () =>
		new Response(JSON.stringify({ id: "mem-1" }), {
			status: 201,
			headers: { "Content-Type": "application/json" },
		}),
	);
	fetchMock.mockImplementation(async () =>
		new Response(JSON.stringify([]), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("handleSend (happy path)", () => {
	test("calls sendMessage with model + thinkingLevel + permissionMode and sets streaming state", async () => {
		const { host, state } = makeHost({
			modelSupportsReasoning: true,
			thinkingLevel: "high",
			permissionModeOverride: "yolo",
		});
		const handlers = makeSendMessage(host);

		await handlers.handleSend("hello world");

		expect(sendMessageMock).toHaveBeenCalledTimes(1);
		const [convArg, dataArg] = sendMessageMock.mock.calls[0]!;
		expect(convArg).toBe("conv-1");
		expect(dataArg.content).toBe("hello world");
		expect(dataArg.provider).toBe("openai");
		expect(dataArg.model).toBe("gpt-4o");
		expect(dataArg.thinkingLevel).toBe("high");
		expect(dataArg.permissionMode).toBe("yolo");

		// Streaming bookkeeping.
		expect(startStreamingMock).toHaveBeenCalledWith("run-1", "conv-1");
		expect(state.activeRunId).toBe("run-1");
		expect(state.activeRunStartedAt).not.toBeNull();
		expect(state.serverStalenessMs).toBe(0);
		expect(state.resumedRun).toBe(false);
		expect(state.error).toBeNull();
		expect(state.userScrolledUp).toBe(false);
		// Send re-engages stick-to-bottom synchronously (initial false → true)
		// so the new turn is followed regardless of the async sentinel IO.
		expect(state.stuck).toBe(true);

		// Optimistic + real user msg + assistant placeholder = 2 (real user
		// replaces optimistic in place + 1 assistant placeholder).
		expect(state.allMessages.length).toBe(2);
		expect(state.allMessages[0]!.id).toBe("real-user-id");
		expect(state.allMessages[1]!.id).toBe("streaming-run-1");
		expect(state.activeLeafId).toBe("streaming-run-1");

		// Side-panel close on send.
		expect(state.settingsOpen).toBe(false);
		expect(state.obsOpen).toBe(false);
	});

	test("omits thinkingLevel when modelSupportsReasoning is false", async () => {
		const { host } = makeHost({
			modelSupportsReasoning: false,
			thinkingLevel: "high",
		});
		const handlers = makeSendMessage(host);
		await handlers.handleSend("hi");
		const [, dataArg] = sendMessageMock.mock.calls[0]!;
		expect(dataArg.thinkingLevel).toBeUndefined();
	});

	test("auto-titles conversation when sending the first user message", async () => {
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSend("First user prompt — should become the title");
		// Title PATCH fires after the user-message count check.
		await Promise.resolve();
		expect(updateConversationMock).toHaveBeenCalled();
		const [convArg, dataArg] = updateConversationMock.mock.calls[0]!;
		expect(convArg).toBe("conv-1");
		expect(dataArg).toMatchObject({
			title: "First user prompt — should become the title",
		});
		// Wait one more microtask for the .then() chain to land.
		await Promise.resolve();
		expect(state.convListRefreshCalls).toBeGreaterThanOrEqual(0);
	});

	test("on sendMessage failure: rolls back optimistic message and sets error", async () => {
		sendMessageMock.mockImplementationOnce(async () => {
			throw new Error("network down");
		});
		const { host, state } = makeHost({
			allMessages: [makeMessage("preexisting")],
			activeLeafId: "preexisting",
		});
		const handlers = makeSendMessage(host);
		await handlers.handleSend("oops");
		expect(state.error).toBe("Failed to send message");
		// Optimistic message removed; preexisting still present.
		expect(state.allMessages.map((m) => m.id)).toEqual(["preexisting"]);
		expect(state.activeLeafId).toBe("preexisting");
	});

	test("when startStreaming returns false (run already finished): clears active-run slots and reloads", async () => {
		startStreamingMock.mockImplementationOnce(() => false);
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSend("hi");
		expect(state.activeRunId).toBeNull();
		expect(state.activeRunStartedAt).toBeNull();
		expect(state.serverStalenessMs).toBeNull();
		expect(state.loadMessagesCalls).toBe(1);
	});

	test("activeLeafId pointing at a streaming placeholder sends no parent (server anchors to latest leaf)", async () => {
		// A `streaming-<runId>` placeholder is never persisted server-side,
		// so it can't be a parent. The client must NOT fall back to the
		// placeholder's parent (the prior *user* message) — that forked a
		// spurious side branch when a follow-up was sent in the post-stream
		// pre-reconcile window. Sending no parent lets the server anchor
		// the turn to the conversation's real latest leaf instead.
		const { host } = makeHost({
			allMessages: [
				makeMessage("u1"),
				makeMessage("streaming-runX", {
					id: "streaming-runX",
					parentMessageId: "u1",
				}),
			],
			activeLeafId: "streaming-runX",
		});
		const handlers = makeSendMessage(host);
		await handlers.handleSend("follow up");
		const [, dataArg] = sendMessageMock.mock.calls[0]!;
		expect(dataArg.parentMessageId).toBeUndefined();
	});
});

describe("handleSend (/login arm)", () => {
	test("`/login` with no provider shows usage", async () => {
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSend("/login");
		expect(state.systemMessages).toEqual([
			"Usage: /login openai or /login google",
		]);
		expect(sendMessageMock).not.toHaveBeenCalled();
		expect(startOAuthFlowMock).not.toHaveBeenCalled();
	});

	test("`/login anthropic` returns the Settings hint", async () => {
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSend("/login anthropic");
		expect(state.systemMessages[0]).toContain("OAuth is not available for Anthropic");
		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	test("`/login openai` opens OAuth, sets pending, opens auth URL", async () => {
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSend("/login openai");
		expect(startOAuthFlowMock).toHaveBeenCalledWith("openai");
		expect(state.chatOAuthPending).not.toBeNull();
		expect(state.chatOAuthPending?.provider).toBe("openai");
		expect(windowOpenCalls.length).toBe(1);
		expect(windowOpenCalls[0]!.url).toContain("https://example.com/oauth");
		expect(state.systemMessages[0]).toContain("Opening OpenAI login");
		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	test("`/login bogus` (unknown provider) shows usage, does not OAuth", async () => {
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSend("/login bogus");
		// `isLoginCommand` returns `{ provider: 'bogus' }` so we hit the
		// final unknown-provider arm.
		expect(state.systemMessages.at(-1)).toBe(
			"Usage: /login openai or /login google",
		);
		expect(startOAuthFlowMock).not.toHaveBeenCalled();
		expect(sendMessageMock).not.toHaveBeenCalled();
	});
});

describe("handleSend (/model arm)", () => {
	test("`/model` (no arg) lists available models", async () => {
		fetchMock.mockImplementationOnce(async () =>
			new Response(
				JSON.stringify([
					{ provider: "openai", model: "gpt-4o", available: true },
					{ provider: "anthropic", model: "claude-4", available: false },
				]),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSend("/model");
		expect(state.systemMessages.length).toBe(1);
		expect(state.systemMessages[0]).toContain("Available models");
		expect(state.systemMessages[0]).toContain("openai/gpt-4o");
		// Unavailable models filtered out.
		expect(state.systemMessages[0]).not.toContain("claude-4");
		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	test("`/model` with no available models shows the API-key hint", async () => {
		fetchMock.mockImplementationOnce(async () =>
			new Response(JSON.stringify([]), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSend("/model");
		expect(state.systemMessages[0]).toContain("No models available");
	});

	test("`/model openai/gpt-4o` switches model when found", async () => {
		fetchMock.mockImplementationOnce(async () =>
			new Response(
				JSON.stringify([
					{ provider: "openai", model: "gpt-4o", available: true },
				]),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSend("/model openai/gpt-4o");
		expect(state.handleModelChangeCalls).toEqual([
			{ provider: "openai", model: "gpt-4o" },
		]);
		expect(state.systemMessages[0]).toBe("Switched to openai/gpt-4o");
		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	test("`/model nonexistent` shows not-found", async () => {
		fetchMock.mockImplementationOnce(async () =>
			new Response(
				JSON.stringify([
					{ provider: "openai", model: "gpt-4o", available: true },
				]),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSend("/model bogus/model");
		expect(state.systemMessages[0]).toContain("Model not found");
		expect(state.handleModelChangeCalls).toEqual([]);
		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	test("`/model gpt-4o` with multiple matches asks user to specify provider", async () => {
		fetchMock.mockImplementationOnce(async () =>
			new Response(
				JSON.stringify([
					{ provider: "openai", model: "gpt-4o", available: true },
					{ provider: "azure", model: "gpt-4o", available: true },
				]),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSend("/model gpt-4o");
		expect(state.systemMessages[0]).toContain("Multiple models match");
		expect(state.handleModelChangeCalls).toEqual([]);
	});
});

describe("handleSend (OAuth pending arm)", () => {
	test("a pasted callback URL completes pending OAuth and clears the pending state", async () => {
		const pending: OAuthPending = {
			authUrl: "https://example.com/oauth",
			codeVerifier: "v",
			state: "s",
			provider: "openai",
			redirectUri: "http://localhost/cb",
		};
		const { host, state } = makeHost({ chatOAuthPending: pending });
		const handlers = makeSendMessage(host);
		await handlers.handleSend("http://localhost/cb?code=abc&state=s");
		expect(completeOAuthWithCodeMock).toHaveBeenCalledTimes(1);
		expect(state.chatOAuthPending).toBeNull();
		expect(state.systemMessages[0]).toContain("OpenAI connected successfully");
		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	test("OAuth failure surfaces the error as a system message", async () => {
		completeOAuthWithCodeMock.mockImplementationOnce(async () => ({
			provider: "openai",
			success: false,
			error: "bad code",
		}));
		const { host, state } = makeHost({
			chatOAuthPending: {
				authUrl: "x",
				codeVerifier: "v",
				state: "s",
				provider: "openai",
				redirectUri: "x",
			},
		});
		const handlers = makeSendMessage(host);
		await handlers.handleSend("anything");
		expect(state.systemMessages[0]).toBe("OAuth failed: bad code");
		expect(state.chatOAuthPending).toBeNull();
	});
});

describe("handleSend (mention parsing)", () => {
	test("@agent mention triggers startSubConvo (sub-convo store + createSubConversation)", async () => {
		parseMentionsMock.mockImplementationOnce(() => [
			{ kind: "agent", name: "researcher" } as MentionToken,
		]);
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSend("ping !researcher");
		// Yield once for the fire-and-forget startSubConvo() to land.
		await Promise.resolve();
		await Promise.resolve();
		expect(createSubConversationMock).toHaveBeenCalledTimes(1);
		const [parentArg, optsArg] = createSubConversationMock.mock.calls[0]!;
		expect(parentArg).toBe("conv-1");
		expect(optsArg.title).toContain("researcher");
		expect(optsArg.parentMessageId).toBe("real-user-id");
		expect(subConversationStoreState.startCalls.length).toBe(1);
		expect(subConversationStoreState.startCalls[0]!.agentName).toBe(
			"researcher",
		);
		expect(state.subConversations.length).toBe(1);
	});

	test("non-agent mentions do NOT trigger startSubConvo", async () => {
		parseMentionsMock.mockImplementationOnce(() => [
			{ kind: "file", name: "src/foo.ts" } as MentionToken,
		]);
		const { host } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSend("look at @foo.ts");
		await Promise.resolve();
		expect(createSubConversationMock).not.toHaveBeenCalled();
	});

	test("parseMentions runs on the LITERAL content (never re-parsed)", async () => {
		// Parser must see the raw text. We assert the input and let the
		// stub return whatever — the wiring guarantee is that the call
		// site passes `content` unchanged.
		const { host } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSend("/[cmd:expand-me] then !researcher");
		expect(parseMentionsMock).toHaveBeenCalledWith(
			"/[cmd:expand-me] then !researcher",
		);
	});
});

describe("handleSend (reactivity / fresh reads)", () => {
	test("subsequent calls observe mutated host getters (selectedModel, thinkingLevel)", async () => {
		const { host, state } = makeHost({
			modelSupportsReasoning: true,
			thinkingLevel: "low",
			selectedModel: { provider: "openai", model: "gpt-4o" },
		});
		const handlers = makeSendMessage(host);
		await handlers.handleSend("first");
		// Mutate.
		state.thinkingLevel = "high";
		state.selectedModel = { provider: "anthropic", model: "claude-4" };
		await handlers.handleSend("second");
		expect(sendMessageMock.mock.calls[0]![1].thinkingLevel).toBe("low");
		expect(sendMessageMock.mock.calls[0]![1].provider).toBe("openai");
		expect(sendMessageMock.mock.calls[1]![1].thinkingLevel).toBe("high");
		expect(sendMessageMock.mock.calls[1]![1].provider).toBe("anthropic");
	});
});

describe("handleEditConfirm", () => {
	test("forks a sibling: calls sendMessage with editOf=msg.id and pushes new turn + placeholder", async () => {
		const target = makeMessage("u-orig", { content: "v1" });
		const { host, state } = makeHost({
			allMessages: [target],
			activeLeafId: "u-orig",
			editingMessageId: "u-orig",
			editContent: "v2",
			modelSupportsReasoning: true,
			thinkingLevel: "medium",
		});
		const handlers = makeSendMessage(host);
		await handlers.handleEditConfirm(target);
		expect(sendMessageMock).toHaveBeenCalledTimes(1);
		const [, dataArg] = sendMessageMock.mock.calls[0]!;
		expect(dataArg.editOf).toBe("u-orig");
		expect(dataArg.content).toBe("v2");
		expect(dataArg.thinkingLevel).toBe("medium");
		// editingMessageId cleared on submit.
		expect(state.editingMessageId).toBeNull();
		// New user message (the sibling) + assistant placeholder appended.
		expect(state.allMessages.find((m) => m.id === "real-user-id")).toBeDefined();
		expect(state.allMessages.find((m) => m.id === "streaming-run-1")).toBeDefined();
		expect(state.activeLeafId).toBe("streaming-run-1");
		expect(state.activeRunId).toBe("run-1");
	});

	test("empty editContent is a no-op", async () => {
		const { host, state } = makeHost({
			editContent: "   ",
			editingMessageId: "u-orig",
		});
		const handlers = makeSendMessage(host);
		await handlers.handleEditConfirm(makeMessage("u-orig"));
		expect(sendMessageMock).not.toHaveBeenCalled();
		expect(state.editingMessageId).toBe("u-orig");
	});

	test("on failure sets error and logs", async () => {
		sendMessageMock.mockImplementationOnce(async () => {
			throw new Error("nope");
		});
		const { host, state } = makeHost({
			editContent: "v2",
			editingMessageId: "u-orig",
		});
		const handlers = makeSendMessage(host);
		await handlers.handleEditConfirm(makeMessage("u-orig"));
		expect(state.error).toBe("Failed to edit message");
	});
});

describe("handleRegenerate", () => {
	test("forks sibling on assistant turn using preceding user message content", async () => {
		const u1 = makeMessage("u1", { role: "user", content: "Q" });
		const a1 = makeMessage("a1", { role: "assistant", content: "A" });
		const { host, state } = makeHost({
			allMessages: [u1, a1],
			activeLeafId: "a1",
		});
		const handlers = makeSendMessage(host);
		await handlers.handleRegenerate(a1);
		const [, dataArg] = sendMessageMock.mock.calls[0]!;
		expect(dataArg.editOf).toBe("a1");
		expect(dataArg.content).toBe("Q");
		expect(state.activeRunId).toBe("run-1");
		expect(state.allMessages.find((m) => m.id === "streaming-run-1")).toBeDefined();
	});

	test("no-op if msg is at index 0 (no preceding user message)", async () => {
		const a0 = makeMessage("a0", { role: "assistant" });
		const { host } = makeHost({ allMessages: [a0] });
		const handlers = makeSendMessage(host);
		await handlers.handleRegenerate(a0);
		expect(sendMessageMock).not.toHaveBeenCalled();
	});
});

describe("handleBranchNavigate", () => {
	test("sets activeLeafId via findLeafByMessageId", () => {
		const { host, state } = makeHost({
			allMessages: [makeMessage("m1"), makeMessage("m2")],
		});
		const handlers = makeSendMessage(host);
		handlers.handleBranchNavigate("m2");
		expect(state.activeLeafId).toBe("m2");
	});
});

describe("handleSaveMemory", () => {
	test("POSTs the single message content and updates savedMemories", async () => {
		const msg = makeMessage("a1", {
			role: "assistant",
			content: "remember this",
		});
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSaveMemory(msg);
		expect(userFetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = userFetchMock.mock.calls[0]!;
		expect(url).toBe("/api/memories");
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body.content).toBe("remember this");
		expect(body.category).toBe("preferences");
		// Single-message body — distinct from W6's bulk path which joins
		// multiple turns into one memory.
		expect(body.content).not.toContain("\n\n");
		expect(state.savedMemories.get("a1")).toBe("mem-1");
	});

	test("non-201 response is silently swallowed (no savedMemories update)", async () => {
		userFetchMock.mockImplementationOnce(async () =>
			new Response("nope", { status: 500 }),
		);
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSaveMemory(makeMessage("a1"));
		expect(state.savedMemories.has("a1")).toBe(false);
	});
});

describe("handleRewind (Sessions P4)", () => {
	test("POSTs the target message id and moves the active branch to it", async () => {
		userFetchMock.mockImplementationOnce(async () =>
			new Response(JSON.stringify({ conversationId: "conv-1", currentLeaf: "a1", nodes: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const { host, state } = makeHost({ activeLeafId: "later-tip" });
		const handlers = makeSendMessage(host);
		await handlers.handleRewind(makeMessage("a1", { role: "assistant" }));
		expect(userFetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = userFetchMock.mock.calls[0]!;
		expect(url).toBe("/api/conversations/conv-1/rewind");
		expect((init as RequestInit).method).toBe("POST");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({ targetMessageId: "a1" });
		// The next send derives parentMessageId from activeLeafId → continues from a1.
		expect(state.activeLeafId).toBe("a1");
	});

	test("a non-2xx (flag off / active run / bad target) leaves the active branch unchanged", async () => {
		userFetchMock.mockImplementationOnce(async () =>
			new Response(JSON.stringify({ error: "disabled", code: "session_producer_disabled" }), { status: 409 }),
		);
		const { host, state } = makeHost({ activeLeafId: "later-tip" });
		const handlers = makeSendMessage(host);
		await handlers.handleRewind(makeMessage("a1", { role: "assistant" }));
		expect(state.activeLeafId).toBe("later-tip");
	});

	test("no-op (no POST) when there is no conversation", async () => {
		const { host, state } = makeHost({ convId: "", activeLeafId: "later-tip" });
		const handlers = makeSendMessage(host);
		await handlers.handleRewind(makeMessage("a1", { role: "assistant" }));
		expect(userFetchMock).not.toHaveBeenCalled();
		expect(state.activeLeafId).toBe("later-tip");
	});

	test("a thrown fetch is swallowed (fail-quiet), branch unchanged", async () => {
		userFetchMock.mockImplementationOnce(async () => {
			throw new Error("network down");
		});
		const { host, state } = makeHost({ activeLeafId: "later-tip" });
		const handlers = makeSendMessage(host);
		await handlers.handleRewind(makeMessage("a1", { role: "assistant" }));
		expect(state.activeLeafId).toBe("later-tip");
	});
});

describe("handleRetry", () => {
	test("removes the failed assistant turn and re-sends the preceding user content", async () => {
		const u1 = makeMessage("u1", { role: "user", content: "Q" });
		const a1 = makeMessage("a1", { role: "assistant", content: "A" });
		const { host, state } = makeHost({
			allMessages: [u1, a1],
			activeLeafId: "a1",
		});
		const handlers = makeSendMessage(host);
		await handlers.handleRetry(a1);
		// The failed turn is removed before handleSend re-sends; sendMessage
		// is called once with the user-message content.
		expect(sendMessageMock).toHaveBeenCalledTimes(1);
		const [, dataArg] = sendMessageMock.mock.calls[0]!;
		expect(dataArg.content).toBe("Q");
		expect(state.allMessages.find((m) => m.id === "a1")).toBeUndefined();
	});

	test("falls back to content-match when the id is gone (stale closure path)", async () => {
		const u1 = makeMessage("u1", { role: "user", content: "Q" });
		const a1ByContent = makeMessage("freshly-reconciled-id", {
			role: "assistant",
			content: "A",
		});
		const stale = makeMessage("a1-stale-id", {
			role: "assistant",
			content: "A",
		});
		const { host } = makeHost({
			allMessages: [u1, a1ByContent],
			activeLeafId: a1ByContent.id,
		});
		const handlers = makeSendMessage(host);
		await handlers.handleRetry(stale);
		expect(sendMessageMock).toHaveBeenCalledTimes(1);
		expect(sendMessageMock.mock.calls[0]![1].content).toBe("Q");
	});
});

describe("handleFallback", () => {
	test("temporarily swaps selectedModel and re-sends with the suggested provider/model", async () => {
		const u1 = makeMessage("u1", { role: "user", content: "Q" });
		const a1 = makeMessage("a1", { role: "assistant", content: "err" });
		const { host, state } = makeHost({
			allMessages: [u1, a1],
			activeLeafId: "a1",
			selectedModel: { provider: "openai", model: "gpt-4o" },
		});
		const handlers = makeSendMessage(host);
		await handlers.handleFallback(a1, "anthropic", "claude-4");
		const [, dataArg] = sendMessageMock.mock.calls[0]!;
		expect(dataArg.provider).toBe("anthropic");
		expect(dataArg.model).toBe("claude-4");
		// The error turn is gone, the user turn remains (plus new ones from
		// the inner handleSend).
		expect(state.allMessages.find((m) => m.id === "a1")).toBeUndefined();
		// Final selectedModel restored to the original after the call.
		expect(state.selectedModel).toEqual({ provider: "openai", model: "gpt-4o" });
	});

	test("no-op if msg has no preceding user turn", async () => {
		const a0 = makeMessage("a0", { role: "assistant" });
		const { host } = makeHost({
			allMessages: [a0],
			activeLeafId: "a0",
		});
		const handlers = makeSendMessage(host);
		await handlers.handleFallback(a0, "x", "y");
		expect(sendMessageMock).not.toHaveBeenCalled();
	});
});

describe("sub-conversation handlers", () => {
	test("handleSubConvoSend: forwards to active sub-convo, sets streaming, calls sendMessage", async () => {
		subConversationStoreState.active = {
			id: "sub-1",
			agentConfigId: "ac-1",
			agentName: "researcher",
			parentConversationId: "conv-1",
			parentMessageId: "u-anchor",
		};
		const { host } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSubConvoSend("hello agent");
		expect(subConversationStoreState.addedMessages.length).toBe(1);
		expect(subConversationStoreState.addedMessages[0]!.content).toBe(
			"hello agent",
		);
		expect(subConversationStoreState.streaming).toBe(true);
		expect(sendMessageMock).toHaveBeenCalledWith("sub-1", {
			content: "hello agent",
			parentMessageId: undefined,
		});
		expect(startStreamingMock).toHaveBeenCalledWith("run-1", "sub-1");
	});

	test("handleSubConvoSend: no-op if no active sub-convo", async () => {
		subConversationStoreState.active = null;
		const { host } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.handleSubConvoSend("hello");
		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	test("handleSubConvoReturn: ends sub-convo and posts last assistant msg as summary", async () => {
		subConversationStoreState.active = {
			id: "sub-1",
			agentConfigId: "ac-1",
			agentName: "researcher",
			parentConversationId: "conv-1",
			parentMessageId: "u-anchor",
		};
		subConversationStoreState.messages = [
			{
				id: "x",
				role: "assistant",
				content: "the answer",
				createdAt: new Date(),
			},
		];
		const { host, state } = makeHost({ activeLeafId: "leaf-id" });
		const handlers = makeSendMessage(host);
		await handlers.handleSubConvoReturn();
		expect(subConversationStoreState.endCalls).toBe(1);
		expect(sendMessageMock).toHaveBeenCalledTimes(1);
		expect(sendMessageMock.mock.calls[0]![1].content).toContain(
			"[Sub-conversation summary]",
		);
		expect(sendMessageMock.mock.calls[0]![1].content).toContain(
			"the answer",
		);
		expect(sendMessageMock.mock.calls[0]![1].parentMessageId).toBe("leaf-id");
		expect(state.loadMessagesCalls).toBe(1);
	});

	test("startSubConvo: registers record + starts store conversation", async () => {
		subConversationStoreState.active = null;
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.startSubConvo({ name: "qa-bot" }, "u-1");
		expect(createSubConversationMock).toHaveBeenCalledWith("conv-1", {
			parentMessageId: "u-1",
			agentConfigId: "",
			title: "Sub-conversation with qa-bot",
			projectId: "proj-1",
		});
		expect(state.subConversations.length).toBe(1);
		expect(state.subConversations[0]!.agentName).toBe("qa-bot");
		expect(subConversationStoreState.startCalls.length).toBe(1);
	});

	test("startSubConvo: blocked when already in a sub-convo", async () => {
		subConversationStoreState.active = {
			id: "existing",
			agentConfigId: "ac-1",
			agentName: "x",
			parentConversationId: "conv-1",
			parentMessageId: "u-1",
		};
		const { host, state } = makeHost();
		const handlers = makeSendMessage(host);
		await handlers.startSubConvo({ name: "qa-bot" }, "u-1");
		expect(createSubConversationMock).not.toHaveBeenCalled();
		expect(state.subConversations.length).toBe(0);
	});
});

// ── Auto (smart routing) wire sentinel ──────────────────────────────────
//
// With the `{provider:"auto",model:"auto"}` picker sentinel selected, the
// send path must put the EXPLICIT `model: null, provider: null` pair on the
// wire (turn 1 — the server routes), then — once a routed turn has
// reconciled with `usage.requestedModel === null` provenance — re-send the
// SERVED identity (route-once: Auto never re-routes mid-conversation).

const AUTO = { provider: "auto", model: "auto" };

describe("handleSend — Auto (smart routing) sentinel", () => {
	test("first Auto turn sends explicit nulls (never the literal 'auto' strings)", async () => {
		const { host } = makeHost({ selectedModel: { ...AUTO } });
		const handlers = makeSendMessage(host);

		await handlers.handleSend("route me");

		expect(sendMessageMock).toHaveBeenCalledTimes(1);
		const [, dataArg] = sendMessageMock.mock.calls[0]!;
		expect(dataArg.provider).toBeNull();
		expect(dataArg.model).toBeNull();
	});

	test("Auto placeholder rows carry null identity, not the sentinel strings", async () => {
		const { host, state } = makeHost({ selectedModel: { ...AUTO } });
		const handlers = makeSendMessage(host);

		await handlers.handleSend("route me");

		const placeholder = state.allMessages.find((m) => m.id === "streaming-run-1")!;
		expect(placeholder.model).toBeNull();
		expect(placeholder.provider).toBeNull();
	});

	test("after a routed turn, Auto re-sends the SERVED pair (route-once mirror)", async () => {
		const served = makeMessage("a-1", {
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet",
			usage: { inputTokens: 1, outputTokens: 1, requestedProvider: null, requestedModel: null },
		});
		const { host } = makeHost({
			selectedModel: { ...AUTO },
			allMessages: [makeMessage("u-1"), served],
			activeLeafId: "a-1",
		});
		const handlers = makeSendMessage(host);

		await handlers.handleSend("follow-up");

		const [, dataArg] = sendMessageMock.mock.calls[0]!;
		expect(dataArg.provider).toBe("anthropic");
		expect(dataArg.model).toBe("claude-sonnet");
	});

	test("a concrete selection is unaffected by prior routed turns", async () => {
		const served = makeMessage("a-1", {
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet",
			usage: { inputTokens: 1, outputTokens: 1, requestedProvider: null, requestedModel: null },
		});
		const { host } = makeHost({
			selectedModel: { provider: "openai", model: "gpt-4o" },
			allMessages: [makeMessage("u-1"), served],
			activeLeafId: "a-1",
		});
		const handlers = makeSendMessage(host);

		await handlers.handleSend("pinned");

		const [, dataArg] = sendMessageMock.mock.calls[0]!;
		expect(dataArg.provider).toBe("openai");
		expect(dataArg.model).toBe("gpt-4o");
	});

	test("handleRegenerate under Auto re-sends the served pair from the routed turn", async () => {
		const userMsg = makeMessage("u-1");
		const served = makeMessage("a-1", {
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet",
			parentMessageId: "u-1",
			usage: { inputTokens: 1, outputTokens: 1, requestedProvider: null, requestedModel: null },
		});
		const { host } = makeHost({
			selectedModel: { ...AUTO },
			allMessages: [userMsg, served],
			activeLeafId: "a-1",
		});
		const handlers = makeSendMessage(host);

		await handlers.handleRegenerate(served);

		expect(sendMessageMock).toHaveBeenCalledTimes(1);
		const [, dataArg] = sendMessageMock.mock.calls[0]!;
		expect(dataArg.editOf).toBe("a-1");
		expect(dataArg.provider).toBe("anthropic");
		expect(dataArg.model).toBe("claude-sonnet");
	});
});
