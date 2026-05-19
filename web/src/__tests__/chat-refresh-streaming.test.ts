import { test, expect, describe, beforeEach } from "bun:test";

/**
 * Tests for the chat page refresh-during-streaming bug.
 *
 * Bug: On refresh while LLM is streaming, a WS reconnect $effect could call
 * checkActiveRun() before loadMessages() resolved, creating a streaming
 * placeholder on an empty allMessages array. This caused all previous messages
 * to disappear until the stream completed.
 *
 * Fix: Added `initialLoadDone` guard so the WS reconnect $effect only fires
 * after the initial loadMessages+checkActiveRun sequence completes.
 *
 * Since the page component uses Svelte 5 runes, we replicate the critical
 * logic in plain JS to test the algorithms.
 */

// --- Replicated types and logic from +page.svelte ---

interface Message {
	id: string;
	conversationId: string;
	role: "user" | "assistant" | "system";
	content: string;
	model: string | null;
	provider: string | null;
	usage: null;
	runId: string | null;
	parentMessageId: string | null;
	createdAt: string;
}

function computeLatestLeaf(msgs: Message[]): string | null {
	if (msgs.length === 0) return null;
	const parentIds = new Set(msgs.map((m) => m.parentMessageId).filter(Boolean));
	const leaves = msgs.filter((m) => !parentIds.has(m.id));
	if (leaves.length === 0) return msgs[msgs.length - 1]?.id ?? null;
	return leaves.reduce((latest, m) =>
		m.createdAt.localeCompare(latest.createdAt) > 0 ? m : latest,
	).id;
}

function deriveMessages(allMessages: Message[], activeLeafId: string | null): Message[] {
	if (!activeLeafId) return [];
	const msgMap = new Map(allMessages.map((m) => [m.id, m]));
	const path: Message[] = [];
	let current = msgMap.get(activeLeafId);
	const visited = new Set<string>();
	while (current && !visited.has(current.id)) {
		visited.add(current.id);
		path.unshift(current);
		current = current.parentMessageId ? msgMap.get(current.parentMessageId) : undefined;
	}
	return path;
}

function makeMessage(overrides: Partial<Message> & { id: string }): Message {
	return {
		conversationId: "conv-1",
		role: "user",
		content: "hello",
		model: null,
		provider: null,
		usage: null,
		runId: null,
		parentMessageId: null,
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

function makeStreamingPlaceholder(runId: string, parentId: string | null): Message {
	return makeMessage({
		id: `streaming-${runId}`,
		role: "assistant",
		content: "",
		runId,
		parentMessageId: parentId,
	});
}

// --- State simulation ---

interface PageState {
	allMessages: Message[];
	activeLeafId: string | null;
	activeRunId: string | null;
	checkingActiveRun: boolean;
	initialLoadDone: boolean;
	wasConnected: boolean;
	streamingMessages: Record<string, string>;
}

function makePageState(): PageState {
	return {
		allMessages: [],
		activeLeafId: null,
		activeRunId: null,
		checkingActiveRun: false,
		initialLoadDone: false,
		wasConnected: false,
		streamingMessages: {},
	};
}

/** Simulates loadMessages resolving */
function simulateLoadMessages(state: PageState, dbMessages: Message[]) {
	state.allMessages = dbMessages;
	state.activeLeafId = computeLatestLeaf(dbMessages);
}

/** Simulates checkActiveRun finding an active run */
function simulateCheckActiveRun(state: PageState, runId: string) {
	state.streamingMessages[runId] = "";
	state.activeRunId = runId;
	const lastMsg = state.allMessages[state.allMessages.length - 1];
	const placeholder = makeStreamingPlaceholder(runId, lastMsg?.id ?? null);
	state.allMessages = [...state.allMessages, placeholder];
	state.activeLeafId = placeholder.id;
	state.checkingActiveRun = false;
}

/** Should the WS reconnect $effect fire? (with the fix) */
function shouldWsReconnectFire(state: PageState, connected: boolean): boolean {
	return connected && !state.wasConnected && !state.activeRunId && state.initialLoadDone;
}

/** Should the WS reconnect $effect fire? (without the fix — old behavior) */
function shouldWsReconnectFireOld(state: PageState, connected: boolean): boolean {
	return connected && !state.wasConnected && !state.activeRunId;
}

// --- Test data ---

const dbMessages: Message[] = [
	makeMessage({ id: "msg-1", role: "user", content: "Hello", parentMessageId: null, createdAt: "2026-01-01T00:00:00Z" }),
	makeMessage({ id: "msg-2", role: "assistant", content: "Hi there!", parentMessageId: "msg-1", createdAt: "2026-01-01T00:00:01Z" }),
	makeMessage({ id: "msg-3", role: "user", content: "How are you?", parentMessageId: "msg-2", createdAt: "2026-01-01T00:00:02Z" }),
];

// --- Tests ---

describe("chat page: refresh during streaming", () => {
	let state: PageState;

	beforeEach(() => {
		state = makePageState();
	});

	describe("initialLoadDone guard prevents premature WS reconnect", () => {
		test("WS reconnect does NOT fire before initial load completes", () => {
			// Simulate: page mounts, checkingActiveRun=true, loadMessages started
			state.checkingActiveRun = true;
			state.initialLoadDone = false;

			// WS connects before loadMessages resolves
			const shouldFire = shouldWsReconnectFire(state, true);
			expect(shouldFire).toBe(false);
		});

		test("WS reconnect DOES fire after initial load completes", () => {
			// Initial load finished, no active run
			state.initialLoadDone = true;
			state.activeRunId = null;

			const shouldFire = shouldWsReconnectFire(state, true);
			expect(shouldFire).toBe(true);
		});

		test("WS reconnect does NOT fire if activeRunId is already set", () => {
			state.initialLoadDone = true;
			state.activeRunId = "run-1";

			const shouldFire = shouldWsReconnectFire(state, true);
			expect(shouldFire).toBe(false);
		});

		test("old behavior (without fix) would fire during initial load", () => {
			state.checkingActiveRun = true;
			state.initialLoadDone = false;

			const shouldFire = shouldWsReconnectFireOld(state, true);
			expect(shouldFire).toBe(true); // This was the bug!
		});
	});

	describe("race condition: WS connects before loadMessages resolves", () => {
		test("BUG SCENARIO (fixed): premature checkActiveRun on empty allMessages", () => {
			// 1. Page mounts, allMessages is empty
			state.checkingActiveRun = true;
			state.initialLoadDone = false;
			expect(state.allMessages).toEqual([]);

			// 2. WS connects — with the fix, should NOT trigger checkActiveRun
			expect(shouldWsReconnectFire(state, true)).toBe(false);

			// 3. Without the fix, checkActiveRun would run on empty allMessages
			// Simulate what would happen:
			simulateCheckActiveRun(state, "run-1");
			// Placeholder has no parent (allMessages was empty)
			const placeholder = state.allMessages[0];
			expect(placeholder?.parentMessageId).toBeNull();
			// messages derived would only contain the placeholder
			const msgs = deriveMessages(state.allMessages, state.activeLeafId);
			expect(msgs).toHaveLength(1);
			expect(msgs[0]!.id).toBe("streaming-run-1");
			// All real messages are missing!
		});

		test("CORRECT FLOW: loadMessages first, then checkActiveRun", () => {
			// 1. Page mounts
			state.checkingActiveRun = true;
			state.initialLoadDone = false;

			// 2. loadMessages resolves
			simulateLoadMessages(state, dbMessages);
			expect(deriveMessages(state.allMessages, state.activeLeafId)).toHaveLength(3);

			// 3. checkActiveRun runs (from .then())
			simulateCheckActiveRun(state, "run-1");
			state.initialLoadDone = true;

			// All messages are visible, plus the streaming placeholder
			const msgs = deriveMessages(state.allMessages, state.activeLeafId);
			expect(msgs).toHaveLength(4); // 3 DB msgs + 1 placeholder
			expect(msgs[0]!.id).toBe("msg-1");
			expect(msgs[1]!.id).toBe("msg-2");
			expect(msgs[2]!.id).toBe("msg-3");
			expect(msgs[3]!.id).toBe("streaming-run-1");
		});
	});

	describe("normal refresh scenarios", () => {
		test("refresh with no active run: all messages render", () => {
			simulateLoadMessages(state, dbMessages);
			state.checkingActiveRun = false;
			state.initialLoadDone = true;

			const msgs = deriveMessages(state.allMessages, state.activeLeafId);
			expect(msgs).toHaveLength(3);
			expect(msgs.map(m => m.id)).toEqual(["msg-1", "msg-2", "msg-3"]);
		});

		test("refresh with active run: placeholder appended correctly", () => {
			simulateLoadMessages(state, dbMessages);
			simulateCheckActiveRun(state, "run-42");
			state.initialLoadDone = true;

			const msgs = deriveMessages(state.allMessages, state.activeLeafId);
			expect(msgs).toHaveLength(4);
			// Placeholder's parent is the last DB message
			const placeholder = msgs[3]!;
			expect(placeholder.id).toBe("streaming-run-42");
			expect(placeholder.parentMessageId).toBe("msg-3");
		});

		test("WS reconnect after initial load works correctly", () => {
			// Initial load completes
			simulateLoadMessages(state, dbMessages);
			state.checkingActiveRun = false;
			state.initialLoadDone = true;

			// WS disconnects and reconnects
			state.wasConnected = true;
			state.wasConnected = false; // disconnected

			// Reconnect fires
			const shouldFire = shouldWsReconnectFire(state, true);
			expect(shouldFire).toBe(true);

			// checkActiveRun runs with populated allMessages
			simulateCheckActiveRun(state, "run-99");
			const msgs = deriveMessages(state.allMessages, state.activeLeafId);
			expect(msgs).toHaveLength(4);
			expect(msgs[0]!.id).toBe("msg-1"); // Previous messages preserved
		});
	});
});

describe("ChatMessage displayContent: empty streaming text", () => {
	test("empty streamingText falls through to message.content with ||", () => {
		// The fix: use || instead of ?? so empty string falls through
		const streamingText = "";
		const messageContent = "Hello from the DB";

		const displayContentFixed = streamingText || messageContent;
		expect(displayContentFixed).toBe("Hello from the DB");
	});

	test("null/undefined streamingText falls through to message.content", () => {
		const messageContent = "Hello from the DB";

		const undefinedText: string | undefined = undefined;
		const nullText: string | null = null;
		expect(undefinedText || messageContent).toBe("Hello from the DB");
		expect(nullText || messageContent).toBe("Hello from the DB");
	});

	test("non-empty streamingText is used over message.content", () => {
		const streamingText = "Streaming response...";
		const messageContent = "";

		const displayContent = streamingText || messageContent;
		expect(displayContent).toBe("Streaming response...");
	});

	test("BUG: ?? would keep empty string over real content", () => {
		const streamingText = "";
		const messageContent = "Real saved content";

		const displayContentBuggy = streamingText ?? messageContent;
		expect(displayContentBuggy).toBe(""); // Bug! Empty string hides real content
	});
});

describe("computeLatestLeaf", () => {
	test("returns null for empty array", () => {
		expect(computeLatestLeaf([])).toBeNull();
	});

	test("returns the leaf node (no children)", () => {
		const msgs = [
			makeMessage({ id: "a", parentMessageId: null, createdAt: "2026-01-01T00:00:00Z" }),
			makeMessage({ id: "b", parentMessageId: "a", createdAt: "2026-01-01T00:00:01Z" }),
		];
		expect(computeLatestLeaf(msgs)).toBe("b");
	});

	test("returns latest leaf when multiple branches exist", () => {
		const msgs = [
			makeMessage({ id: "a", parentMessageId: null, createdAt: "2026-01-01T00:00:00Z" }),
			makeMessage({ id: "b", parentMessageId: "a", createdAt: "2026-01-01T00:00:01Z" }),
			makeMessage({ id: "c", parentMessageId: "a", createdAt: "2026-01-01T00:00:02Z" }),
		];
		// Both b and c are leaves, c is newer
		expect(computeLatestLeaf(msgs)).toBe("c");
	});
});

describe("deriveMessages: path walk from leaf to root", () => {
	test("returns empty array when activeLeafId is null", () => {
		expect(deriveMessages(dbMessages, null)).toEqual([]);
	});

	test("walks from leaf to root correctly", () => {
		const msgs = deriveMessages(dbMessages, "msg-3");
		expect(msgs.map(m => m.id)).toEqual(["msg-1", "msg-2", "msg-3"]);
	});

	test("returns single message for root-only leaf", () => {
		const msgs = deriveMessages(dbMessages, "msg-1");
		expect(msgs.map(m => m.id)).toEqual(["msg-1"]);
	});

	test("returns empty when activeLeafId not in allMessages", () => {
		const msgs = deriveMessages(dbMessages, "nonexistent");
		expect(msgs).toEqual([]);
	});

	test("streaming placeholder connects to existing message chain", () => {
		const placeholder = makeStreamingPlaceholder("run-1", "msg-3");
		const allMsgs = [...dbMessages, placeholder];
		const msgs = deriveMessages(allMsgs, placeholder.id);
		expect(msgs.map(m => m.id)).toEqual(["msg-1", "msg-2", "msg-3", "streaming-run-1"]);
	});

	test("orphaned placeholder (no parent) shows only itself", () => {
		const placeholder = makeStreamingPlaceholder("run-1", null);
		const allMsgs = [...dbMessages, placeholder];
		const msgs = deriveMessages(allMsgs, placeholder.id);
		// Only the placeholder, not the DB messages (they're on a different chain)
		expect(msgs.map(m => m.id)).toEqual(["streaming-run-1"]);
	});
});

// --- Tool call persistence tests ---

// Replicate getHistoricalToolCalls conversion from +page.svelte
interface InlineToolCall {
	id: string;
	extensionName: string;
	toolName: string;
	input: Record<string, unknown>;
	status: 'pending' | 'running' | 'complete' | 'error';
	output?: string;
	error?: string;
	retryCount: number;
	startedAt?: number;
	duration?: number;
	conversationId: string;
	messageId?: string;
}

interface ToolCallState {
	toolName: string;
	status: 'running' | 'complete' | 'error';
	input?: unknown;
	output?: unknown;
	error?: string;
	startedAt: number;
	duration?: number;
	extensionId?: string;
}

function getHistoricalToolCalls(calls: InlineToolCall[]): ToolCallState[] {
	if (calls.length === 0) return [];
	return calls.map((c, i) => ({
		toolName: c.toolName,
		status: c.status === 'complete' ? 'complete' as const
			: c.status === 'error' ? 'error' as const
			: 'running' as const,
		input: c.input,
		output: c.output,
		error: c.error,
		startedAt: c.startedAt ?? i,
		duration: c.duration,
		extensionId: c.extensionName,
	}));
}

describe("tool call persistence after streaming ends", () => {
	test("streaming tool calls are cleared on stopStreaming", () => {
		const streamingToolCalls: Record<string, ToolCallState[]> = {
			"run-1": [
				{ toolName: "readFile", status: "complete", startedAt: 1000, duration: 500, extensionId: "builtin" },
				{ toolName: "editFile", status: "running", startedAt: 2000, extensionId: "builtin" },
			],
		};
		// Simulate stopStreaming — removes the entry
		const { "run-1": _, ...rest } = streamingToolCalls;
		expect(rest).toEqual({});
		expect(rest["run-1"]).toBeUndefined();
	});

	test("getHistoricalToolCalls converts InlineToolCalls to ToolCallState", () => {
		const inlineCalls: InlineToolCall[] = [
			{
				id: "tc-1", extensionName: "builtin", toolName: "readFile",
				input: { path: "README.md" }, status: "complete",
				output: "# Hello", retryCount: 0, duration: 500,
				conversationId: "conv-1", messageId: "msg-4",
			},
			{
				id: "tc-2", extensionName: "builtin", toolName: "editFile",
				input: { path: "README.md", new_string: "# Updated" }, status: "complete",
				output: "File updated", retryCount: 0, duration: 300,
				conversationId: "conv-1", messageId: "msg-4",
			},
		];

		const result = getHistoricalToolCalls(inlineCalls);
		expect(result).toHaveLength(2);
		expect(result[0]!.toolName).toBe("readFile");
		expect(result[0]!.status).toBe("complete");
		expect(result[0]!.output).toBe("# Hello");
		expect(result[0]!.extensionId).toBe("builtin");
		expect(result[1]!.toolName).toBe("editFile");
		expect(result[1]!.status).toBe("complete");
	});

	test("getHistoricalToolCalls maps error status correctly", () => {
		const inlineCalls: InlineToolCall[] = [
			{
				id: "tc-1", extensionName: "builtin", toolName: "readFile",
				input: { path: "missing.txt" }, status: "error",
				error: "File not found", retryCount: 1, duration: 100,
				conversationId: "conv-1", messageId: "msg-4",
			},
		];

		const result = getHistoricalToolCalls(inlineCalls);
		expect(result[0]!.status).toBe("error");
		expect(result[0]!.error).toBe("File not found");
	});

	test("getHistoricalToolCalls maps pending/running to running", () => {
		const pendingCall: InlineToolCall[] = [{
			id: "tc-1", extensionName: "ext", toolName: "tool",
			input: {}, status: "pending", retryCount: 0,
			conversationId: "conv-1", messageId: "msg-1",
		}];
		const runningCall: InlineToolCall[] = [{
			id: "tc-2", extensionName: "ext", toolName: "tool",
			input: {}, status: "running", retryCount: 0, startedAt: 5000,
			conversationId: "conv-1", messageId: "msg-1",
		}];

		expect(getHistoricalToolCalls(pendingCall)[0]!.status).toBe("running");
		expect(getHistoricalToolCalls(runningCall)[0]!.status).toBe("running");
		expect(getHistoricalToolCalls(runningCall)[0]!.startedAt).toBe(5000);
	});

	test("getHistoricalToolCalls returns empty for no calls", () => {
		expect(getHistoricalToolCalls([])).toEqual([]);
	});

	test("getHistoricalToolCalls uses index as startedAt fallback to avoid key collisions", () => {
		const calls: InlineToolCall[] = [
			{ id: "tc-1", extensionName: "builtin", toolName: "readFile", input: {}, status: "complete", retryCount: 0, conversationId: "c", messageId: "m" },
			{ id: "tc-2", extensionName: "builtin", toolName: "readFile", input: {}, status: "complete", retryCount: 0, conversationId: "c", messageId: "m" },
		];
		const result = getHistoricalToolCalls(calls);
		// Keys are toolName + startedAt, should be different
		const key0 = result[0]!.toolName + result[0]!.startedAt;
		const key1 = result[1]!.toolName + result[1]!.startedAt;
		expect(key0).not.toBe(key1);
	});

	test("BUG: msgToolCalls was undefined for non-streaming messages", () => {
		// Before the fix: isStreamingMsg = false -> msgToolCalls = undefined
		const activeRunId = null;
		const isStreaming = false;
		const msg = makeMessage({ id: "msg-4", role: "assistant", runId: "run-1" });

		const isStreamingMsg = msg.runId === activeRunId && isStreaming;
		expect(isStreamingMsg).toBe(false);

		// Old behavior: undefined for non-streaming
		const oldMsgToolCalls = isStreamingMsg ? [] : undefined;
		expect(oldMsgToolCalls).toBeUndefined();

		// New behavior: historical tool calls used as fallback
		const historicalCalls: InlineToolCall[] = [
			{ id: "tc-1", extensionName: "builtin", toolName: "readFile", input: { path: "f.txt" }, status: "complete", output: "content", retryCount: 0, duration: 200, conversationId: "c", messageId: "msg-4" },
		];
		const historicalTools = !isStreamingMsg && msg.role === 'assistant' ? getHistoricalToolCalls(historicalCalls) : undefined;
		const streamingTools: ReturnType<typeof getHistoricalToolCalls> | undefined = undefined;
		const newMsgToolCalls = streamingTools ?? (historicalTools && historicalTools.length > 0 ? historicalTools : undefined);
		expect(newMsgToolCalls).toBeDefined();
		expect(newMsgToolCalls).toHaveLength(1);
		expect(newMsgToolCalls![0]!.toolName).toBe("readFile");
	});
});

describe("integration: full refresh-during-streaming lifecycle", () => {
	test("complete lifecycle with fix applied", () => {
		const state = makePageState();

		// Step 1: Page mounts
		state.checkingActiveRun = true;
		state.initialLoadDone = false;

		// Step 2: WS connects early — guard prevents duplicate checkActiveRun
		expect(shouldWsReconnectFire(state, true)).toBe(false);

		// Step 3: loadMessages resolves
		simulateLoadMessages(state, dbMessages);
		let msgs = deriveMessages(state.allMessages, state.activeLeafId);
		expect(msgs).toHaveLength(3);

		// Step 4: checkActiveRun from .then() runs
		simulateCheckActiveRun(state, "run-1");
		state.initialLoadDone = true;
		msgs = deriveMessages(state.allMessages, state.activeLeafId);
		expect(msgs).toHaveLength(4);

		// Step 5: Tokens arrive
		state.streamingMessages["run-1"] = "Hello ";
		state.streamingMessages["run-1"] += "world!";

		// Step 6: Stream completes — reconcileAfterStream reloads
		state.activeRunId = null;
		const freshMessages = [
			...dbMessages,
			makeMessage({ id: "msg-4", role: "assistant", content: "Hello world!", parentMessageId: "msg-3", runId: "run-1", createdAt: "2026-01-01T00:00:03Z" }),
		];
		state.allMessages = freshMessages;
		// activeLeafId "streaming-run-1" no longer exists, recompute
		if (!freshMessages.find(m => m.id === state.activeLeafId)) {
			state.activeLeafId = computeLatestLeaf(freshMessages);
		}

		msgs = deriveMessages(state.allMessages, state.activeLeafId);
		expect(msgs).toHaveLength(4);
		expect(msgs[3]!.content).toBe("Hello world!");
	});
});
