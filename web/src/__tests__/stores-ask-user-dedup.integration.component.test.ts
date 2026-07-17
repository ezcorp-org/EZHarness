/**
 * INTEGRATION test for the "question shows twice" bug.
 *
 * Drives the REAL `stores.svelte.ts` `tool:start` switch handler (not a
 * copy, not the extracted helper in isolation) by mocking the WS client and
 * capturing its subscriber, then dispatching events at it under vitest —
 * the same harness as `stores-tool-error-status.integration.component.test.ts`.
 *
 * What it proves end-to-end: the production tool:start handler dedups the
 * streaming tool-call list by id, so a tool call that the resume /
 * active-run path already injected (an open `ask_user_question` gate,
 * re-hydrated from the in-memory registry) is NOT appended a second time
 * when the live SSE `tool:start` arrives — the exact WS-reconnect race that
 * rendered the question card twice.
 *
 * This is the wiring guard the unit test on `appendStreamingToolCall`
 * can't give: a future edit that reverts the handler to a blind append
 * would pass the unit test but FAIL here (length 2, two cards).
 */

import { describe, test, expect, beforeEach, vi } from "vitest";

let capturedSubscriber: ((evt: { type: string; data: unknown }) => void) | null = null;

vi.mock("$lib/ws", () => ({
	createWSClient: () => ({
		subscribe: (fn: (evt: { type: string; data: unknown }) => void) => {
			capturedSubscriber = fn;
			return () => {};
		},
		close: () => {},
		manualRetry: () => {},
	}),
}));

vi.mock("$lib/api", () => ({
	fetchAgents: () => Promise.resolve([]),
	fetchRuns: () => Promise.resolve([]),
	fetchProjects: () => Promise.resolve([]),
	fetchSettings: () => Promise.resolve({}),
	fetchAgentConfigs: () => Promise.resolve([]),
	fetchWorkflows: () => Promise.resolve([]),
}));

import {
	initStores,
	startStreaming,
	stopStreaming,
	getStreamingToolCalls,
	store,
} from "$lib/stores.svelte";

function emit(type: string, data: unknown) {
	if (!capturedSubscriber) throw new Error("subscriber not captured — initStores not called?");
	capturedSubscriber({ type, data });
}

describe("stores.svelte.ts — ask_user streaming-card dedup (real handler)", () => {
	beforeEach(() => {
		capturedSubscriber = null;
		initStores();
		for (const runId of Object.keys(store.streamingRunToConversation)) {
			stopStreaming(runId);
		}
	});

	test("resume-injected ask_user gate + live tool:start (same id) → exactly ONE card", () => {
		const runId = "run-ask-1";
		const convId = "conv-ask-1";
		startStreaming(runId, convId);

		// 1. The resume / active-run path (stream-resume.svelte.ts) injects the
		//    open ask_user gate into streamingToolCalls BEFORE the live event —
		//    it has to, because the tool_calls DB row isn't written until the
		//    user answers. Mirror that direct injection here.
		store.streamingToolCalls = {
			...store.streamingToolCalls,
			[runId]: [
				{
					id: "call_ask",
					toolName: "ask-user__ask_user_question",
					status: "running",
					input: { question: "What filesystem path should I use?" },
					startedAt: 1,
					cardType: "ask-user-question",
				},
			],
		};

		// 2. The live SSE tool:start for the SAME tool call arrives (reconnect
		//    race). The real handler must dedup by id, not blind-append.
		emit("tool:start", {
			conversationId: convId,
			toolName: "ask-user__ask_user_question",
			input: { question: "What filesystem path should I use?" },
			timestamp: 2,
			invocationId: "call_ask",
			cardType: "ask-user-question",
		});

		const calls = getStreamingToolCalls(runId);
		// The regression: blind-append produced length 2 → two question cards.
		expect(calls).toHaveLength(1);
		expect(calls[0]!.id).toBe("call_ask");
	});

	test("duplicate live tool:start with the same id is also deduped", () => {
		const runId = "run-ask-2";
		const convId = "conv-ask-2";
		startStreaming(runId, convId);

		const evt = {
			conversationId: convId,
			toolName: "ask-user__ask_user_question",
			input: { question: "Pick one" },
			timestamp: 1,
			invocationId: "call_dup",
			cardType: "ask-user-question",
		};
		emit("tool:start", evt);
		emit("tool:start", { ...evt, timestamp: 2 });

		expect(getStreamingToolCalls(runId)).toHaveLength(1);
	});

	test("no over-dedup: two distinct tool calls still both render", () => {
		const runId = "run-ask-3";
		const convId = "conv-ask-3";
		startStreaming(runId, convId);

		emit("tool:start", {
			conversationId: convId,
			toolName: "ask-user__ask_user_question",
			input: { question: "Q1" },
			timestamp: 1,
			invocationId: "call_a",
			cardType: "ask-user-question",
		});
		emit("tool:start", {
			conversationId: convId,
			toolName: "propose_create_project",
			input: { name: "ezTest", path: "./ezTest" },
			timestamp: 2,
			invocationId: "call_b",
			cardType: "ez-propose",
		});

		const calls = getStreamingToolCalls(runId);
		expect(calls).toHaveLength(2);
		expect(calls.map((c) => c.id).sort()).toEqual(["call_a", "call_b"]);
	});
});
