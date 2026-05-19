/**
 * Regression coverage for the "ghost skeleton paints over the thinking card"
 * bug.
 *
 * Root cause: ChatThread.handleTurnSaved unconditionally spawned a fresh
 * empty `streaming-${runId}` placeholder + re-pointed the active leaf for
 * EVERY saved turn — including the terminal one. After `run:turn_text_reset`
 * blanked the runId buffers, that empty placeholder satisfied the skeleton
 * condition in ChatMessage.svelte and painted over the thinking card until
 * `run:complete` reconciled from the DB. The persisted row also lacked
 * `thinkingContent` (the event never carried it), so even the settled row
 * flickered text→thinking.
 *
 * Fix: `run:turn_saved` now carries `thinkingContent` + `final`. On the
 * terminal turn the client makes the persisted row (now with thinking) the
 * active leaf and creates NO placeholder.
 *
 * These mirror the store `run:turn_saved` case (stores.svelte.ts:812-826)
 * and `ChatThread.handleTurnSaved` (953-1022). Mirror pattern matches the
 * precedent in stores-agent-complete-routing.test.ts — the real code uses
 * Svelte 5 runes / component scope and can't be imported directly; the real
 * integrated path is exercised by web/e2e/thinking-blocks.spec.ts.
 */
import { describe, test, expect, beforeEach } from "bun:test";

// ── window.dispatchEvent stub ──────────────────────────────────────

interface Dispatched { type: string; detail: any }
let dispatched: Dispatched[] = [];

function setupWindowStub() {
	(globalThis as unknown as { window: typeof globalThis }).window = globalThis;
	(globalThis as { dispatchEvent?: (e: Event) => void }).dispatchEvent = (e: Event) => {
		const ce = e as CustomEvent;
		dispatched.push({ type: e.type, detail: ce.detail });
		return true;
	};
}

// ── Mirror: stores.svelte.ts run:turn_saved case (812-826) ─────────

interface TurnSavedEvent {
	type: "run:turn_saved";
	data: {
		runId: string; conversationId: string; messageId: string;
		parentMessageId: string | null; content: string;
		thinkingContent?: string; final: boolean;
	};
}

function handleStoreTurnSaved(event: TurnSavedEvent): void {
	const { runId, conversationId, messageId, parentMessageId, content, thinkingContent, final } = event.data;
	if (typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent("ez:turn_saved", {
			detail: { runId, conversationId, messageId, parentMessageId, content, thinkingContent, final },
		}));
	}
}

describe("stores: run:turn_saved → ez:turn_saved forwards thinkingContent + final", () => {
	beforeEach(() => { dispatched = []; setupWindowStub(); });

	test("forwards thinkingContent and final:true (terminal turn)", () => {
		handleStoreTurnSaved({
			type: "run:turn_saved",
			data: {
				runId: "run-1", conversationId: "c1", messageId: "m1",
				parentMessageId: null, content: "the answer",
				thinkingContent: "let me reason", final: true,
			},
		});
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]!.type).toBe("ez:turn_saved");
		expect(dispatched[0]!.detail.thinkingContent).toBe("let me reason");
		expect(dispatched[0]!.detail.final).toBe(true);
		expect(dispatched[0]!.detail.content).toBe("the answer");
	});

	test("forwards final:false and undefined thinkingContent (tool turn, no thinking)", () => {
		handleStoreTurnSaved({
			type: "run:turn_saved",
			data: {
				runId: "run-1", conversationId: "c1", messageId: "m1",
				parentMessageId: "m0", content: "", final: false,
			},
		});
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]!.detail.final).toBe(false);
		expect(dispatched[0]!.detail.thinkingContent).toBeUndefined();
	});
});

// ── Mirror: ChatThread.handleTurnSaved (953-1022) ──────────────────

interface Msg {
	id: string; role: string; content: string;
	thinkingContent: string | null; runId: string | null;
	parentMessageId: string | null;
}

function makeOptimisticMessage(o: Partial<Msg> & { id: string }): Msg {
	return {
		id: o.id, role: o.role ?? "user", content: o.content ?? "",
		thinkingContent: o.thinkingContent ?? null, runId: o.runId ?? null,
		parentMessageId: o.parentMessageId ?? null,
	};
}

/** Drives the non-extension branch of handleTurnSaved over a mutable state. */
function runHandleTurnSaved(
	state: { allMessages: Msg[]; activeLeafId: string | null },
	activeRunId: string,
	detail: {
		runId: string; conversationId: string; messageId: string;
		parentMessageId: string | null; content: string;
		thinkingContent?: string; final: boolean;
	},
	conversationId = "c1",
): void {
	const { runId, conversationId: evtConvId, messageId, parentMessageId, content, thinkingContent, final } = detail;
	if (evtConvId !== conversationId) return;
	if (runId !== activeRunId) return;

	const realMsg = makeOptimisticMessage({
		id: messageId,
		role: "assistant",
		content,
		thinkingContent: thinkingContent ?? null,
		runId,
		parentMessageId,
	});
	state.allMessages = state.allMessages.filter((m) => m.id !== `streaming-${runId}`);
	state.allMessages = [...state.allMessages, realMsg];

	if (final === true) {
		state.activeLeafId = messageId;
		return;
	}

	const nextPlaceholder = makeOptimisticMessage({
		id: `streaming-${runId}`,
		role: "assistant",
		runId,
		parentMessageId: messageId,
	});
	state.allMessages = [...state.allMessages, nextPlaceholder];
	state.activeLeafId = nextPlaceholder.id;
}

describe("ChatThread.handleTurnSaved — terminal vs continuing turn", () => {
	let state: { allMessages: Msg[]; activeLeafId: string | null };

	beforeEach(() => {
		// Mid-stream: one placeholder is the active leaf.
		const ph = makeOptimisticMessage({ id: "streaming-run-1", role: "assistant", runId: "run-1" });
		state = { allMessages: [ph], activeLeafId: "streaming-run-1" };
	});

	test("final=true: persisted row carries thinkingContent, NO new placeholder, leaf = real message", () => {
		runHandleTurnSaved(state, "run-1", {
			runId: "run-1", conversationId: "c1", messageId: "m1",
			parentMessageId: null, content: "answer",
			thinkingContent: "reasoning", final: true,
		});

		// Old placeholder removed; exactly one row; it is the persisted message.
		expect(state.allMessages.map((m) => m.id)).toEqual(["m1"]);
		const saved = state.allMessages[0]!;
		expect(saved.thinkingContent).toBe("reasoning");
		expect(saved.content).toBe("answer");
		// No spurious empty streaming placeholder → skeleton can't reappear.
		expect(state.allMessages.some((m) => m.id.startsWith("streaming-"))).toBe(false);
		// Active leaf is the settled message, not a placeholder.
		expect(state.activeLeafId).toBe("m1");
	});

	test("final=false: persisted row + a fresh placeholder for the next turn", () => {
		runHandleTurnSaved(state, "run-1", {
			runId: "run-1", conversationId: "c1", messageId: "m1",
			parentMessageId: null, content: "", thinkingContent: "inspecting", final: false,
		});

		expect(state.allMessages.map((m) => m.id)).toEqual(["m1", "streaming-run-1"]);
		expect(state.allMessages[0]!.thinkingContent).toBe("inspecting");
		const ph = state.allMessages[1]!;
		expect(ph.parentMessageId).toBe("m1");
		expect(state.activeLeafId).toBe("streaming-run-1");
	});

	test("final=true with no thinking (plain answer): persisted row, thinkingContent null, no placeholder", () => {
		runHandleTurnSaved(state, "run-1", {
			runId: "run-1", conversationId: "c1", messageId: "m1",
			parentMessageId: null, content: "hi", final: true,
		});

		expect(state.allMessages.map((m) => m.id)).toEqual(["m1"]);
		expect(state.allMessages[0]!.thinkingContent).toBeNull();
		expect(state.allMessages.some((m) => m.id.startsWith("streaming-"))).toBe(false);
		expect(state.activeLeafId).toBe("m1");
	});

	test("multi-turn: tool turn (final=false) then synthesis (final=true) settles on one final row", () => {
		// Turn 1 — tool call, not final.
		runHandleTurnSaved(state, "run-1", {
			runId: "run-1", conversationId: "c1", messageId: "m1",
			parentMessageId: null, content: "", thinkingContent: "t1", final: false,
		});
		expect(state.allMessages.map((m) => m.id)).toEqual(["m1", "streaming-run-1"]);
		expect(state.activeLeafId).toBe("streaming-run-1");

		// Turn 2 — synthesis, final. The fresh placeholder is consumed.
		runHandleTurnSaved(state, "run-1", {
			runId: "run-1", conversationId: "c1", messageId: "m2",
			parentMessageId: "m1", content: "done", thinkingContent: "t2", final: true,
		});
		expect(state.allMessages.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(state.allMessages.some((m) => m.id.startsWith("streaming-"))).toBe(false);
		expect(state.allMessages[1]!.thinkingContent).toBe("t2");
		expect(state.activeLeafId).toBe("m2");
	});

	test("ignores events for a different run / conversation", () => {
		runHandleTurnSaved(state, "run-1", {
			runId: "run-2", conversationId: "c1", messageId: "mX",
			parentMessageId: null, content: "x", final: true,
		});
		runHandleTurnSaved(state, "run-1", {
			runId: "run-1", conversationId: "other", messageId: "mY",
			parentMessageId: null, content: "y", final: true,
		});
		// Untouched: still the original placeholder.
		expect(state.allMessages.map((m) => m.id)).toEqual(["streaming-run-1"]);
		expect(state.activeLeafId).toBe("streaming-run-1");
	});
});
