import { test, expect, describe } from "bun:test";
import {
	patchAssistantContentFromStream,
	recordSnapshot,
	clearSnapshot,
	snapshotToMaps,
	type StreamSnapshot,
} from "../reconcile-stream.js";
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

describe("patchAssistantContentFromStream", () => {
	test("1. runId === null → returns same array reference", () => {
		const messages = [msg({ id: "m1", content: "" })];
		const result = patchAssistantContentFromStream(messages, null, { "run-1": "text" }, {});
		expect(result).toBe(messages);
	});

	test("2. runId === '' → returns same array reference", () => {
		const messages = [msg({ id: "m1", content: "" })];
		const result = patchAssistantContentFromStream(messages, "", { "": "text" }, {});
		expect(result).toBe(messages);
	});

	test("3. no matching message (runId not in any message) → returns same array reference", () => {
		const messages = [msg({ id: "m1", content: "", runId: "run-OTHER" })];
		const result = patchAssistantContentFromStream(messages, "run-1", { "run-1": "text" }, {});
		expect(result).toBe(messages);
	});

	test("4. matching assistant has non-empty content → not patched, returns same array", () => {
		const messages = [msg({ id: "m1", content: "already set", runId: "run-1" })];
		const result = patchAssistantContentFromStream(messages, "run-1", { "run-1": "streaming" }, {});
		expect(result).toBe(messages);
	});

	test("5. matching assistant has empty content AND streaming cache has text → content patched", () => {
		const messages = [msg({ id: "m1", content: "", runId: "run-1" })];
		const result = patchAssistantContentFromStream(messages, "run-1", { "run-1": "hello" }, {});
		expect(result).not.toBe(messages);
		expect(result[0]!.content).toBe("hello");
	});

	test("6. matching assistant has empty content but streaming cache is also empty → not patched", () => {
		const messages = [msg({ id: "m1", content: "", runId: "run-1" })];
		const result = patchAssistantContentFromStream(messages, "run-1", { "run-1": "" }, {});
		expect(result).toBe(messages);
	});

	test("7. matching message is role === 'user' → not patched", () => {
		const messages = [msg({ id: "m1", role: "user", content: "", runId: "run-1" })];
		const result = patchAssistantContentFromStream(messages, "run-1", { "run-1": "text" }, {});
		expect(result).toBe(messages);
	});

	test("8. earlier message empty, LAST has content → no patch (last is server-of-truth)", () => {
		// Multi-turn run: message 1 is an empty intermediate (memory-fetch /
		// tool-only turn), message 2 is the actual response. Under the new
		// last-only semantics we MUST NOT copy m2's content into m1.
		const intermediate = msg({ id: "m1", content: "", runId: "run-1" });
		const final = msg({ id: "m2", content: "the answer", runId: "run-1" });
		const messages = [intermediate, final];
		const result = patchAssistantContentFromStream(messages, "run-1", { "run-1": "streamed" }, {});
		expect(result).toBe(messages);
		expect(result[0]).toBe(intermediate);
		expect(result[0]!.content).toBe("");
		expect(result[1]).toBe(final);
		expect(result[1]!.content).toBe("the answer");
	});

	test("8b. multiple assistant messages, both empty content, snapshot has text → only LAST patched", () => {
		const intermediate = msg({ id: "m1", content: "", runId: "run-1" });
		const last = msg({ id: "m2", content: "", runId: "run-1" });
		const messages = [intermediate, last];
		const result = patchAssistantContentFromStream(messages, "run-1", { "run-1": "streamed" }, {});
		expect(result).not.toBe(messages);
		expect(result[0]).toBe(intermediate);
		expect(result[0]!.content).toBe("");
		expect(result[1]!.content).toBe("streamed");
	});

	test("8c. three assistant messages, MIDDLE empty, last populated → no patch", () => {
		// Only the last assistant row is the candidate; if it has content the
		// helper leaves the array untouched even when an earlier row is empty.
		const first = msg({ id: "m1", content: "first", runId: "run-1" });
		const middle = msg({ id: "m2", content: "", runId: "run-1" });
		const last = msg({ id: "m3", content: "final", runId: "run-1" });
		const messages = [first, middle, last];
		const result = patchAssistantContentFromStream(messages, "run-1", { "run-1": "streamed" }, {});
		expect(result).toBe(messages);
	});

	test("9. thinkingContent is empty AND streamingThinking has text → patched", () => {
		const messages = [msg({ id: "m1", content: "full", thinkingContent: null, runId: "run-1" })];
		const result = patchAssistantContentFromStream(messages, "run-1", {}, { "run-1": "thoughts" });
		expect(result).not.toBe(messages);
		expect(result[0]!.thinkingContent).toBe("thoughts");
		expect(result[0]!.content).toBe("full");
	});

	test("10. thinkingContent is already set → not patched", () => {
		const messages = [msg({ id: "m1", content: "", thinkingContent: "already thinking", runId: "run-1" })];
		const result = patchAssistantContentFromStream(messages, "run-1", { "run-1": "text" }, { "run-1": "new thoughts" });
		expect(result).not.toBe(messages);
		expect(result[0]!.thinkingContent).toBe("already thinking");
		expect(result[0]!.content).toBe("text");
	});

	test("11. both content AND thinkingContent need patching → both patched in a single new object", () => {
		const messages = [msg({ id: "m1", content: "", thinkingContent: null, runId: "run-1" })];
		const result = patchAssistantContentFromStream(messages, "run-1", { "run-1": "answer" }, { "run-1": "reasoning" });
		expect(result).not.toBe(messages);
		expect(result[0]!.content).toBe("answer");
		expect(result[0]!.thinkingContent).toBe("reasoning");
	});

	test("12. whitespace-only content ('   ') treated as empty", () => {
		const messages = [msg({ id: "m1", content: "   ", runId: "run-1" })];
		const result = patchAssistantContentFromStream(messages, "run-1", { "run-1": "real text" }, {});
		expect(result).not.toBe(messages);
		expect(result[0]!.content).toBe("real text");
	});

	test("13. returned array preserves order of unrelated messages", () => {
		const user = msg({ id: "u1", role: "user", content: "hi", runId: null });
		const asst = msg({ id: "a1", content: "", runId: "run-1" });
		const unrelated = msg({ id: "a2", content: "other", runId: "run-999" });
		const messages = [user, asst, unrelated];
		const result = patchAssistantContentFromStream(messages, "run-1", { "run-1": "patched" }, {});
		expect(result[0]).toBe(user);
		expect(result[1]!.content).toBe("patched");
		expect(result[2]).toBe(unrelated);
	});

	test("14. patched messages are new objects; unpatched keep original reference", () => {
		const toKeep = msg({ id: "m1", content: "fine", runId: "run-1" });
		const toPatch = msg({ id: "m2", content: "", runId: "run-1" });
		const messages = [toKeep, toPatch];
		const result = patchAssistantContentFromStream(messages, "run-1", { "run-1": "new" }, {});
		expect(result[0]).toBe(toKeep);
		expect(result[1]).not.toBe(toPatch);
		expect(result[1]!.content).toBe("new");
	});
});

describe("recordSnapshot", () => {
	test("null runId → returns same reference", () => {
		const snap: StreamSnapshot = {};
		expect(recordSnapshot(snap, null, "text", "thinking")).toBe(snap);
	});

	test("both inputs undefined (cache cleared) → returns same reference", () => {
		const snap: StreamSnapshot = { "run-1": { content: "x", thinking: "" } };
		expect(recordSnapshot(snap, "run-1", undefined, undefined)).toBe(snap);
	});

	test("populates entry on first observation", () => {
		const snap: StreamSnapshot = {};
		const next = recordSnapshot(snap, "run-1", "hello", "thoughts");
		expect(next).not.toBe(snap);
		expect(next["run-1"]).toEqual({ content: "hello", thinking: "thoughts" });
	});

	test("undefined fields fall back to previous snapshot values (preserves text after stopStreaming)", () => {
		const snap: StreamSnapshot = { "run-1": { content: "kept", thinking: "kept-t" } };
		// Simulate the moment AFTER stopStreaming: cache values are undefined,
		// but recordSnapshot is also called with undefineds — fast path returns
		// same ref. The retention property is exercised below: when only ONE
		// of the two values goes undefined, the other still merges.
		const next = recordSnapshot(snap, "run-1", "newer", undefined);
		expect(next["run-1"]).toEqual({ content: "newer", thinking: "kept-t" });
	});

	test("identical update → returns same reference", () => {
		const snap: StreamSnapshot = { "run-1": { content: "same", thinking: "same-t" } };
		const next = recordSnapshot(snap, "run-1", "same", "same-t");
		expect(next).toBe(snap);
	});

	test("treats empty-string text as observation when no prior snapshot", () => {
		const snap: StreamSnapshot = {};
		const next = recordSnapshot(snap, "run-1", "", undefined);
		expect(next).not.toBe(snap);
		expect(next["run-1"]).toEqual({ content: "", thinking: "" });
	});

	test("does NOT clobber prev.content when streamingText is '' (run:turn_text_reset between turns)", () => {
		// run:turn_text_reset sets streamingMessages[runId] = "" between
		// multi-turn runs. Without this fix, `??` would propagate the empty
		// string and we'd lose the previous turn's accumulated text.
		const snap: StreamSnapshot = { "run-1": { content: "abc", thinking: "" } };
		const next = recordSnapshot(snap, "run-1", "", undefined);
		expect(next).toBe(snap);
		expect(next["run-1"]).toEqual({ content: "abc", thinking: "" });
	});

	test("does NOT clobber prev.thinking when streamingThinking is ''", () => {
		const snap: StreamSnapshot = { "run-1": { content: "x", thinking: "kept" } };
		const next = recordSnapshot(snap, "run-1", undefined, "");
		expect(next).toBe(snap);
		expect(next["run-1"]).toEqual({ content: "x", thinking: "kept" });
	});

	test("non-empty streamingText replaces prev.content", () => {
		const snap: StreamSnapshot = { "run-1": { content: "abc", thinking: "" } };
		const next = recordSnapshot(snap, "run-1", "def", undefined);
		expect(next).not.toBe(snap);
		expect(next["run-1"]).toEqual({ content: "def", thinking: "" });
	});

	test("non-empty streamingThinking replaces prev.thinking", () => {
		const snap: StreamSnapshot = { "run-1": { content: "abc", thinking: "old" } };
		const next = recordSnapshot(snap, "run-1", undefined, "new");
		expect(next).not.toBe(snap);
		expect(next["run-1"]).toEqual({ content: "abc", thinking: "new" });
	});
});

describe("clearSnapshot", () => {
	test("null runId → same reference", () => {
		const snap: StreamSnapshot = { "run-1": { content: "x", thinking: "" } };
		expect(clearSnapshot(snap, null)).toBe(snap);
	});

	test("absent key → same reference", () => {
		const snap: StreamSnapshot = { "run-1": { content: "x", thinking: "" } };
		expect(clearSnapshot(snap, "run-OTHER")).toBe(snap);
	});

	test("present key → drops only that entry", () => {
		const snap: StreamSnapshot = {
			"run-1": { content: "a", thinking: "" },
			"run-2": { content: "b", thinking: "" },
		};
		const next = clearSnapshot(snap, "run-1");
		expect(next).not.toBe(snap);
		expect(next["run-1"]).toBeUndefined();
		expect(next["run-2"]).toEqual({ content: "b", thinking: "" });
	});
});

describe("snapshotToMaps", () => {
	test("null runId → empty maps", () => {
		expect(snapshotToMaps({}, null)).toEqual({ contentMap: {}, thinkingMap: {} });
	});

	test("absent runId → empty maps", () => {
		expect(snapshotToMaps({}, "run-1")).toEqual({ contentMap: {}, thinkingMap: {} });
	});

	test("present entry → keys only present fields", () => {
		const snap: StreamSnapshot = { "run-1": { content: "answer", thinking: "" } };
		const { contentMap, thinkingMap } = snapshotToMaps(snap, "run-1");
		expect(contentMap).toEqual({ "run-1": "answer" });
		expect(thinkingMap).toEqual({});
	});

	test("entry with both fields populated → both keyed", () => {
		const snap: StreamSnapshot = { "run-1": { content: "a", thinking: "t" } };
		const { contentMap, thinkingMap } = snapshotToMaps(snap, "run-1");
		expect(contentMap).toEqual({ "run-1": "a" });
		expect(thinkingMap).toEqual({ "run-1": "t" });
	});
});
