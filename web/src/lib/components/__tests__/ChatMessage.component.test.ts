/**
 * DOM tests for ChatMessage.svelte — guards the iter-4 fix that suppresses
 * the empty `<div class="markdown-body">` wrapper when an assistant turn has
 * nothing textual to render.
 *
 * The bug: a multi-turn run can persist an assistant row with `content=""`
 * and `memoriesUsed` populated. `ChatMessage` previously always mounted
 * `<MarkdownRenderer content="">` which emits an empty `<div class="markdown-body">`
 * — a visible blank wrapper next to the MemoriesCard. The fix wraps the
 * inner markdown wrapper in a content-presence guard while keeping the
 * outer `mdContainer` bind for the toolbar's "copy as rich HTML" feature.
 */

import { render } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import ChatMessage from "../ChatMessage.svelte";
import type { Message } from "$lib/api.js";
import type { ToolCallState, ContentBlock } from "$lib/stores.svelte.js";

beforeEach(() => {
	// Some sub-components fire fetches on mount; stub so jsdom doesn't surface
	// unhandled rejections.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
	);
});

function makeMessage(overrides: Partial<Message> = {}): Message {
	return {
		id: "msg-1",
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
		createdAt: "2026-04-30T00:00:00.000Z",
		...overrides,
	};
}

describe("ChatMessage — empty-content suppression", () => {
	test("assistant with content='' + memoriesUsed → MemoriesCard renders, no .markdown-body", () => {
		const { container, getByText } = render(ChatMessage, {
			message: makeMessage({ content: "" }),
			memoriesUsed: [
				{ id: "mem-1", content: "Today is Tuesday.", category: "preferences" },
			],
		});

		// MemoriesCard mounted (it renders the literal "Memories" label).
		expect(getByText("Memories")).toBeInTheDocument();

		// No empty .markdown-body wrapper. This is the load-bearing assertion
		// for the bug fix.
		expect(container.querySelector(".markdown-body")).toBeNull();
	});

	test("assistant with non-empty content → .markdown-body renders with the text", () => {
		const { container } = render(ChatMessage, {
			message: makeMessage({ content: "Hello world" }),
		});

		const markdown = container.querySelector(".markdown-body");
		expect(markdown).not.toBeNull();
		expect(markdown?.textContent).toContain("Hello world");
	});

	test("assistant with content='' + toolCalls (no contentBlocks) → tool card renders, no .markdown-body", () => {
		const toolCall: ToolCallState = {
			id: "tc-1",
			toolName: "fs__read",
			status: "complete",
			input: { path: "a.md" },
			output: "ok",
			startedAt: 0,
			duration: 5,
			extensionId: "fs",
		};
		const { container } = render(ChatMessage, {
			message: makeMessage({ content: "" }),
			toolCalls: [toolCall],
		});

		// No empty markdown wrapper.
		expect(container.querySelector(".markdown-body")).toBeNull();
		// The fallback branch's tool-call section IS mounted (id starts with
		// `tool-call-` per the template).
		expect(container.querySelector("[id^='tool-call-']")).not.toBeNull();
	});

	test("streaming with streamingText='hi' → .markdown-body IS mounted (live render target)", () => {
		const { container } = render(ChatMessage, {
			message: makeMessage({ content: "" }),
			streamingText: "hi",
		});

		const markdown = container.querySelector(".markdown-body");
		expect(markdown).not.toBeNull();
	});

	test("streaming with streamingText='' (initial pre-token state) → SkeletonLoader renders, no .markdown-body yet", () => {
		// Pre-fix and post-fix the same: when streaming starts and no content
		// has arrived, the upstream branch at ChatMessage.svelte:309 renders a
		// SkeletonLoader instead of MarkdownRenderer. Once the first token lands
		// (covered by the previous test) `displayContent` becomes truthy and
		// the markdown-body mounts.
		const { container } = render(ChatMessage, {
			message: makeMessage({ content: "" }),
			streamingText: "",
		});

		expect(container.querySelector(".markdown-body")).toBeNull();
	});

	test("contentBlocks with empty text block → that text block does NOT render .markdown-body", () => {
		// Mirrors the contentBlocks branch fix at ChatMessage.svelte text block.
		const blocks: ContentBlock[] = [
			{ type: "text", content: "" },
		];
		const { container } = render(ChatMessage, {
			message: makeMessage({ content: "" }),
			contentBlocks: blocks,
		});

		expect(container.querySelector(".markdown-body")).toBeNull();
	});

	test("contentBlocks with non-empty text block → .markdown-body renders with the block's content", () => {
		const blocks: ContentBlock[] = [
			{ type: "text", content: "block text" },
		];
		const { container } = render(ChatMessage, {
			message: makeMessage({ content: "" }),
			contentBlocks: blocks,
		});

		const markdown = container.querySelector(".markdown-body");
		expect(markdown).not.toBeNull();
		expect(markdown?.textContent).toContain("block text");
	});

	test("user message with empty content does not render .markdown-body (user messages take a different render path)", () => {
		// Sanity check — the iter-3 filter never hides user messages, but the
		// component should also not emit a phantom markdown-body for an empty
		// user message (user messages use segment-based rendering, not markdown).
		const { container } = render(ChatMessage, {
			message: makeMessage({ role: "user", content: "" }),
		});
		expect(container.querySelector(".markdown-body")).toBeNull();
	});
});

describe("ChatMessage — topic pills overlay (WS4)", () => {
	const topics = [
		{ id: "t1", label: "Auth flow", typeId: "feature", messageIds: ["msg-1"] },
	];

	test("assistant row renders TopicPills and clicking fires onextracttopic", async () => {
		const onextracttopic = vi.fn();
		const { getByTestId } = render(ChatMessage, {
			message: makeMessage({ role: "assistant", content: "Hello" }),
			topics,
			onextracttopic,
		});
		const pill = getByTestId("topic-pill-t1");
		expect(pill).toHaveTextContent("Auth flow");
		const { fireEvent } = await import("@testing-library/svelte");
		await fireEvent.click(pill);
		expect(onextracttopic).toHaveBeenCalledWith("t1");
	});

	test("user row renders TopicPills for anchored topics", () => {
		const { getByTestId } = render(ChatMessage, {
			message: makeMessage({ role: "user", content: "Question" }),
			topics,
			onextracttopic: vi.fn(),
		});
		expect(getByTestId("topic-pill-t1")).toBeInTheDocument();
	});

	test("select mode suppresses the pills overlay", () => {
		const { queryByTestId } = render(ChatMessage, {
			message: makeMessage({ role: "assistant", content: "Hello" }),
			topics,
			onextracttopic: vi.fn(),
			selectable: true,
		});
		expect(queryByTestId("topic-pill-t1")).toBeNull();
	});
});
