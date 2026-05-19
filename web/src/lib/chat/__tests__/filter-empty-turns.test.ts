import { test, expect, describe } from "bun:test";
import {
	filterEmptyAssistantTurns,
	shouldHideEmptyAssistantTurn,
	type EmptyTurnFilterDeps,
} from "../filter-empty-turns.js";
import type { Message } from "$lib/api.js";

function msg(overrides: Partial<Message> & Pick<Message, "id">): Message {
	return {
		conversationId: "conv-1",
		role: "assistant",
		content: "",
		thinkingContent: null,
		model: null,
		provider: null,
		usage: null,
		runId: "run-1",
		parentMessageId: null,
		excluded: false,
		createdAt: "2025-01-01T00:00:00.000Z",
		...overrides,
	};
}

// Default deps for tests that aren't exercising dedup. `isMemoryCardVisible:
// () => true` mirrors the pre-iteration-5 behaviour: ALL rows with
// `memoriesUsed` show their card. Tests that drive the deduped-blank path
// pass `() => false` (or a Set lookup) explicitly.
const NO_HYDRATION: EmptyTurnFilterDeps = {
	hasHistoricalToolCalls: () => false,
	hasHistoricalAgentCalls: () => false,
	isMemoryCardVisible: () => true,
};

describe("shouldHideEmptyAssistantTurn", () => {
	test("empty assistant with no tools / memories / thinking / agents → hidden", () => {
		expect(shouldHideEmptyAssistantTurn(msg({ id: "m1" }), NO_HYDRATION)).toBe(true);
	});

	test("whitespace-only content → hidden", () => {
		expect(shouldHideEmptyAssistantTurn(msg({ id: "m1", content: "   \n\t" }), NO_HYDRATION)).toBe(true);
	});

	test("non-empty content → shown", () => {
		expect(shouldHideEmptyAssistantTurn(msg({ id: "m1", content: "hello" }), NO_HYDRATION)).toBe(false);
	});

	test("empty content but thinkingContent set → shown", () => {
		expect(
			shouldHideEmptyAssistantTurn(
				msg({ id: "m1", thinkingContent: "reasoning…" }),
				NO_HYDRATION,
			),
		).toBe(false);
	});

	test("empty content + memoriesUsed + memory card visible → shown", () => {
		expect(
			shouldHideEmptyAssistantTurn(
				msg({
					id: "m1",
					memoriesUsed: [
						{ id: "mem-1", content: "Today is Tuesday.", category: "general" },
					],
				}),
				NO_HYDRATION,
			),
		).toBe(false);
	});

	test("empty content + memoriesUsed but card DEDUPED (visible=false) + no other signals → hidden", () => {
		// User-reported case: the dedup pass at +page.svelte:555-572 hides
		// the MemoriesCard on a row whose memory-id set matches the previous
		// assistant turn's. Without the dep, the row would still pass the
		// "has memories" check and render as a blank bubble.
		const dedupedDeps: EmptyTurnFilterDeps = {
			hasHistoricalToolCalls: () => false,
			hasHistoricalAgentCalls: () => false,
			isMemoryCardVisible: () => false,
		};
		expect(
			shouldHideEmptyAssistantTurn(
				msg({
					id: "m1",
					memoriesUsed: [
						{ id: "mem-1", content: "Today is Tuesday.", category: "general" },
					],
				}),
				dedupedDeps,
			),
		).toBe(true);
	});

	test("memoriesUsed deduped BUT message has non-empty content → shown (content wins)", () => {
		const dedupedDeps: EmptyTurnFilterDeps = {
			hasHistoricalToolCalls: () => false,
			hasHistoricalAgentCalls: () => false,
			isMemoryCardVisible: () => false,
		};
		expect(
			shouldHideEmptyAssistantTurn(
				msg({
					id: "m1",
					content: "actual reply",
					memoriesUsed: [
						{ id: "mem-1", content: "Today is Tuesday.", category: "general" },
					],
				}),
				dedupedDeps,
			),
		).toBe(false);
	});

	test("memoriesUsed deduped BUT message has hydrated tool calls → shown (tools win)", () => {
		const deps: EmptyTurnFilterDeps = {
			hasHistoricalToolCalls: (id) => id === "m1",
			hasHistoricalAgentCalls: () => false,
			isMemoryCardVisible: () => false,
		};
		expect(
			shouldHideEmptyAssistantTurn(
				msg({
					id: "m1",
					memoriesUsed: [
						{ id: "mem-1", content: "fact", category: "general" },
					],
				}),
				deps,
			),
		).toBe(false);
	});

	test("empty content but historical tool calls hydrated → shown", () => {
		const deps: EmptyTurnFilterDeps = {
			hasHistoricalToolCalls: (id) => id === "m1",
			hasHistoricalAgentCalls: () => false,
			isMemoryCardVisible: () => true,
		};
		expect(shouldHideEmptyAssistantTurn(msg({ id: "m1" }), deps)).toBe(false);
	});

	test("empty content but historical agent calls hydrated → shown", () => {
		const deps: EmptyTurnFilterDeps = {
			hasHistoricalToolCalls: () => false,
			hasHistoricalAgentCalls: (id) => id === "m1",
			isMemoryCardVisible: () => true,
		};
		expect(shouldHideEmptyAssistantTurn(msg({ id: "m1" }), deps)).toBe(false);
	});

	test("user message with empty content → never hidden", () => {
		expect(
			shouldHideEmptyAssistantTurn(msg({ id: "u1", role: "user", content: "" }), NO_HYDRATION),
		).toBe(false);
	});

	test("streaming placeholder (id starts with 'streaming-') → never hidden", () => {
		expect(
			shouldHideEmptyAssistantTurn(
				msg({ id: "streaming-run-1", role: "assistant", content: "" }),
				NO_HYDRATION,
			),
		).toBe(false);
	});

	test("memoriesUsed empty array → still hidden (length-zero is not 'has memories')", () => {
		expect(
			shouldHideEmptyAssistantTurn(msg({ id: "m1", memoriesUsed: [] }), NO_HYDRATION),
		).toBe(true);
	});
});

describe("filterEmptyAssistantTurns", () => {
	test("nothing to remove → returns same reference", () => {
		const messages = [
			msg({ id: "u1", role: "user", content: "hi" }),
			msg({ id: "a1", content: "answer" }),
		];
		const result = filterEmptyAssistantTurns(messages, NO_HYDRATION);
		expect(result).toBe(messages);
	});

	test("real-world multi-turn case: empty intermediate hidden, populated final shown", () => {
		// Mirrors the production data shape from the bug report:
		// Turn 1 (assistant, runId=X) — empty content, memoriesUsed populated.
		// Turn 2 (assistant, runId=X) — actual response.
		const user = msg({ id: "u1", role: "user", content: "what day is it?" });
		const intermediateNoHydration = msg({
			id: "a1",
			content: "",
			parentMessageId: "u1",
		});
		const final = msg({
			id: "a2",
			content: "Today is Tuesday.",
			parentMessageId: "a1",
		});
		const result = filterEmptyAssistantTurns(
			[user, intermediateNoHydration, final],
			NO_HYDRATION,
		);
		expect(result.length).toBe(2);
		expect(result[0]!.id).toBe("u1");
		expect(result[1]!.id).toBe("a2");
	});

	test("intermediate WITH memories is shown even before tool-call hydration", () => {
		const user = msg({ id: "u1", role: "user", content: "?" });
		const intermediate = msg({
			id: "a1",
			content: "",
			memoriesUsed: [{ id: "mem-1", content: "fact", category: "general" }],
		});
		const final = msg({ id: "a2", content: "answer", parentMessageId: "a1" });
		const result = filterEmptyAssistantTurns([user, intermediate, final], NO_HYDRATION);
		expect(result.length).toBe(3);
	});

	test("intermediate becomes visible after tool-call hydration completes", () => {
		const messages = [
			msg({ id: "u1", role: "user", content: "?" }),
			msg({ id: "a1", content: "" }),
			msg({ id: "a2", content: "answer" }),
		];
		// Before hydration — intermediate hidden.
		expect(filterEmptyAssistantTurns(messages, NO_HYDRATION).length).toBe(2);
		// After hydration — store now reports tool calls for "a1".
		const hydrated: EmptyTurnFilterDeps = {
			hasHistoricalToolCalls: (id) => id === "a1",
			hasHistoricalAgentCalls: () => false,
			isMemoryCardVisible: () => true,
		};
		expect(filterEmptyAssistantTurns(messages, hydrated).length).toBe(3);
	});

	test("dedup-hidden blank intermediate: memoriesUsed present but card on earlier turn → row dropped", () => {
		// Simulates the page's `memoryCardVisibleMessageIds` having only "a1"
		// in it (the first turn with this memory set). "a2" carries the same
		// memoriesUsed but the dedup pass skipped it. Without other signals,
		// "a2" is the deduped-blank case the user reported.
		const memSet = [{ id: "mem-1", content: "fact", category: "general" }];
		const messages = [
			msg({ id: "u1", role: "user", content: "?" }),
			msg({ id: "a1", content: "", memoriesUsed: memSet }),
			msg({ id: "a2", content: "", memoriesUsed: memSet }),
			msg({ id: "a3", content: "final answer", memoriesUsed: memSet }),
		];
		const visibleSet = new Set(["a1"]);
		const deps: EmptyTurnFilterDeps = {
			hasHistoricalToolCalls: () => false,
			hasHistoricalAgentCalls: () => false,
			isMemoryCardVisible: (id) => visibleSet.has(id),
		};
		const result = filterEmptyAssistantTurns(messages, deps);
		// Expect: u1 (user) + a1 (visible memory card) + a3 (has content) = 3.
		// a2 dropped because: empty content, deduped memory card, no tools/agents.
		expect(result.map((m) => m.id)).toEqual(["u1", "a1", "a3"]);
	});

	test("does NOT filter user messages even when content empty", () => {
		const messages = [
			msg({ id: "u1", role: "user", content: "" }),
			msg({ id: "a1", content: "answer" }),
		];
		const result = filterEmptyAssistantTurns(messages, NO_HYDRATION);
		expect(result.length).toBe(2);
		expect(result[0]!.id).toBe("u1");
	});

	test("streaming placeholder always rendered", () => {
		const messages = [
			msg({ id: "u1", role: "user", content: "hi" }),
			msg({ id: "streaming-run-1", content: "" }),
		];
		const result = filterEmptyAssistantTurns(messages, NO_HYDRATION);
		expect(result.length).toBe(2);
		expect(result[1]!.id).toBe("streaming-run-1");
	});
});
