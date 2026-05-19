import { test, expect, describe } from "bun:test";
import { buildActiveAgentHref } from "$lib/active-agents-href.js";

describe("buildActiveAgentHref", () => {
	test("top-level agent (no parent) → links to its own chat", () => {
		expect(
			buildActiveAgentHref({
				conversationId: "conv-1",
				parentConversationId: null,
				projectId: "proj-1",
			}),
		).toBe("/project/proj-1/chat/conv-1");
	});

	test("sub-agent → links to parent chat with ?agent=<subConvId>", () => {
		expect(
			buildActiveAgentHref({
				conversationId: "sub-1",
				parentConversationId: "parent-1",
				projectId: "proj-1",
			}),
		).toBe("/project/proj-1/chat/parent-1?agent=sub-1");
	});

	test("top-level agent with no projectId → falls back to /project/global/…", () => {
		expect(
			buildActiveAgentHref({
				conversationId: "conv-9",
				parentConversationId: null,
				projectId: null,
			}),
		).toBe("/project/global/chat/conv-9");
	});

	test("sub-agent with no projectId → global segment + ?agent= preserved", () => {
		expect(
			buildActiveAgentHref({
				conversationId: "sub-9",
				parentConversationId: "parent-9",
				projectId: null,
			}),
		).toBe("/project/global/chat/parent-9?agent=sub-9");
	});

	test("encodes sub-conversation id with URL-unsafe characters", () => {
		// Defensive: IDs shouldn't normally contain these, but the helper must
		// not produce a URL that would silently swallow them (e.g. `&` or `#`).
		const href = buildActiveAgentHref({
			conversationId: "a&b#c d",
			parentConversationId: "parent-1",
			projectId: "proj-1",
		});
		expect(href).toBe("/project/proj-1/chat/parent-1?agent=a%26b%23c%20d");
	});

	test("does NOT append ?agent= when there is no parent, even for exotic ids", () => {
		const href = buildActiveAgentHref({
			conversationId: "weird id",
			parentConversationId: null,
			projectId: "proj-1",
		});
		expect(href).toBe("/project/proj-1/chat/weird id");
		expect(href).not.toContain("?agent=");
	});
});
