/**
 * Contract guard for issue #99.
 *
 * Root cause of #99: two e2e specs seeded a `propose_*` result
 * (`{ draftId, openUrl, title, summary }`) as an assistant message's
 * `content` and expected the Ez panel to render an `EzToolResultCard`
 * from it. That contract never existed — `ChatMessage` only sniffs
 * `content` for the `ez-action-result` role's `{card:{title,body,variant}}`
 * shape (`parseEzActionResult`). The real `ez-propose` card path is a
 * persisted tool call (`cardType: "ez-propose"`) routed through
 * `ToolCardRouter` → `parseProposeCardResult`, which reads `toolCall.output`
 * — never `message.content`.
 *
 * This test pins that a plain assistant message whose `content` happens to
 * be propose-shaped JSON renders as ordinary markdown text, never a card —
 * so a future refactor can't silently reintroduce content-sniffing for
 * propose results (which would also be a false-positive risk whenever an
 * assistant legitimately echoes JSON back to the user).
 */
import { render } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import ChatMessage from "../ChatMessage.svelte";
import type { Message } from "$lib/api.js";

beforeEach(() => {
	// Some sub-components fire fetches on mount; stub so jsdom doesn't surface
	// unhandled rejections.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
	);
});

function makeAssistantMessage(content: string): Message {
	return {
		id: "msg-propose-1",
		conversationId: "conv-1",
		role: "assistant",
		content,
		thinkingContent: null,
		model: null,
		provider: null,
		usage: null,
		runId: "run-1",
		parentMessageId: null,
		excluded: false,
		createdAt: "2026-07-12T00:00:00.000Z",
	};
}

describe("ChatMessage — propose-result JSON as plain content is never sniffed for a card (#99)", () => {
	test("propose-shaped JSON in `content` (no toolCalls) renders as markdown text, not ez-tool-result-card", () => {
		const proposeResult = JSON.stringify({
			draftId: "d-1",
			openUrl: "/new-project?prefill=d-1",
			title: "Open new project form",
			summary: "Ez prepared a project draft.",
		});
		const { container, queryByTestId } = render(ChatMessage, {
			message: makeAssistantMessage(proposeResult),
		});

		// No content→card path for propose results — EzToolResultCard only
		// mounts via ToolCardRouter for a persisted tool call.
		expect(queryByTestId("ez-tool-result-card")).toBeNull();
		const markdown = container.querySelector(".markdown-body");
		expect(markdown).not.toBeNull();
		expect(markdown?.textContent).toContain("openUrl");
		expect(markdown?.textContent).toContain("d-1");
	});
});
