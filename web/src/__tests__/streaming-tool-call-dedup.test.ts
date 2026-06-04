/**
 * Regression test for the "question shows twice" bug.
 *
 * `ask_user_question` holds the run open (paused on the user). While the
 * gate is open the card is pushed into `store.streamingToolCalls[runId]`
 * from two paths: the live SSE `tool:start` handler AND the resume /
 * active-run path (which re-injects open `pendingAskUser` gates from the
 * in-memory registry). The resume path deduped by id, but the live
 * `tool:start` handler blind-appended — so on a WS reconnect (resume
 * injects first, live event arrives second) the same tool call landed in
 * the list twice and the question card rendered twice.
 *
 * `appendStreamingToolCall` makes the live path's dedup symmetric. These
 * tests pin that invariant.
 */

import { test, expect, describe } from "bun:test";
import { appendStreamingToolCall } from "../lib/chat/streaming-tool-calls.js";

interface Card {
	id?: string;
	toolName: string;
	status: string;
}

describe("appendStreamingToolCall", () => {
	test("appends a genuinely new card (added=true)", () => {
		const existing: Card[] = [];
		const { calls, added } = appendStreamingToolCall(existing, {
			id: "call_1",
			toolName: "ask-user__ask_user_question",
			status: "running",
		});
		expect(added).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.id).toBe("call_1");
	});

	test("the ask_user reconnect race: resume injects, live tool:start with same id is a no-op", () => {
		// 1. Resume/active-run injects the pending ask_user gate.
		const afterResume = appendStreamingToolCall([] as Card[], {
			id: "call_ask",
			toolName: "ask-user__ask_user_question",
			status: "running",
		});
		expect(afterResume.added).toBe(true);

		// 2. The live SSE tool:start arrives for the SAME tool call id.
		const afterLive = appendStreamingToolCall(afterResume.calls, {
			id: "call_ask",
			toolName: "ask-user__ask_user_question",
			status: "running",
		});

		// No second card — the question renders exactly once.
		expect(afterLive.added).toBe(false);
		expect(afterLive.calls).toHaveLength(1);
		// List returned unchanged (caller skips the paired tool_ref push).
		expect(afterLive.calls).toBe(afterResume.calls);
	});

	test("reverse order (live first, resume second) is also deduped", () => {
		const afterLive = appendStreamingToolCall([] as Card[], {
			id: "call_ask",
			toolName: "ask-user__ask_user_question",
			status: "running",
		});
		const afterResume = appendStreamingToolCall(afterLive.calls, {
			id: "call_ask",
			toolName: "ask-user__ask_user_question",
			status: "running",
		});
		expect(afterResume.added).toBe(false);
		expect(afterResume.calls).toHaveLength(1);
	});

	test("distinct ids both append (no false dedup across different tool calls)", () => {
		const a = appendStreamingToolCall([] as Card[], { id: "call_1", toolName: "edit_file", status: "running" });
		const b = appendStreamingToolCall(a.calls, { id: "call_2", toolName: "edit_file", status: "running" });
		expect(b.added).toBe(true);
		expect(b.calls).toHaveLength(2);
	});

	test("entries without an id are always appended (can't dedup)", () => {
		const a = appendStreamingToolCall([] as Card[], { toolName: "x", status: "running" });
		const b = appendStreamingToolCall(a.calls, { toolName: "x", status: "running" });
		expect(a.added).toBe(true);
		expect(b.added).toBe(true);
		expect(b.calls).toHaveLength(2);
	});
});
