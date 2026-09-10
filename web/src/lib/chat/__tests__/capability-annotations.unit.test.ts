import { describe, expect, test } from "vitest";
import type { Message } from "$lib/api.js";
import { appendCapabilityAnnotations } from "../capability-annotations.ts";

function message(
	id: string,
	role: string,
	createdAt: string,
): Message {
	return {
		id,
		conversationId: "conversation-1",
		role,
		content: "",
		thinkingContent: null,
		model: null,
		provider: null,
		usage: null,
		runId: null,
		parentMessageId: null,
		excluded: false,
		createdAt,
	};
}

describe("appendCapabilityAnnotations", () => {
	test("keeps the selected branch order, includes root annotations, and deduplicates ids", () => {
		const root = message("root", "user", "2026-01-03T00:00:00.000Z");
		const leaf = message("leaf", "assistant", "2026-01-01T00:00:00.000Z");
		const alreadyInBranch = message("cap-branch", "capability-event", "2026-01-02T00:00:00.000Z");
		const globalCapability = message("cap-global", "capability-event", "2026-01-04T00:00:00.000Z");
		const duplicateCapability = message("cap-global", "capability-event", "2026-01-05T00:00:00.000Z");
		const otherBranchMessage = message("other-leaf", "assistant", "2026-01-06T00:00:00.000Z");

		const result = appendCapabilityAnnotations(
			[root, alreadyInBranch, leaf],
			[root, globalCapability, otherBranchMessage, duplicateCapability, alreadyInBranch, leaf],
		);

		expect(result.map((row) => row.id)).toEqual([
			"root",
			"cap-branch",
			"leaf",
			"cap-global",
		]);
	});
});
