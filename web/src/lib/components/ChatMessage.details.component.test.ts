/**
 * ChatMessage detail surfaces: system notices, the inline-tool tooltip on a
 * prompt's extension chip, the knowledge-base sources popover, and the
 * failed sub-agent rollup.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ChatMessage from "./ChatMessage.svelte";
import type { Message } from "$lib/api.js";
import type { AgentCallState } from "$lib/stores.svelte.js";

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function message(overrides: Partial<Message>): Message {
	return {
		id: "msg-1",
		conversationId: "conv-1",
		role: "assistant",
		content: "Done.",
		thinkingContent: null,
		model: null,
		provider: null,
		usage: null,
		runId: null,
		parentMessageId: null,
		excluded: false,
		createdAt: "2026-05-04T00:00:00.000Z",
		...overrides,
	} as Message;
}

function agent(agentName: string, status: AgentCallState["status"]): AgentCallState {
	return { subConversationId: `sub-${agentName}`, agentName, agentConfigId: `cfg-${agentName}`, task: "t", status, startedAt: 0 };
}

describe("ChatMessage details", () => {
	test("a system message renders as a centred notice", () => {
		const { getByText } = render(ChatMessage, {
			message: message({ role: "system", content: "Model switched to claude" }),
		});
		expect(getByText("Model switched to claude")).toHaveClass("italic");
	});

	test("hovering a prompt's extension chip lists the tool calls it made", async () => {
		const { container, findByText } = render(ChatMessage, {
			message: message({ role: "user", content: "Use ![ext:search] please" }),
			inlineToolCalls: [
				{ extensionName: "search", toolName: "web_search", input: { q: "cats", limit: 3 } },
				{ extensionName: "other", toolName: "ignored", input: {} },
				{ extensionName: "search", toolName: "fetch_page", input: {} },
			],
		});
		await fireEvent.mouseEnter(container.querySelector('[data-mention-name="search"]')!);
		const tip = await findByText(/Tool: web_search/);
		expect(tip.textContent).toBe("Tool: web_search\nq: cats\nlimit: 3\n\nTool: fetch_page");
	});

	test("the sources button toggles the knowledge-base chunks used", async () => {
		const { getByRole, queryByText, getByText } = render(ChatMessage, {
			message: message({}),
			kbSourcesUsed: [
				{ id: "k1", filename: "guide.md", chunkIndex: 2 },
				{ id: "k2", filename: "faq.md", chunkIndex: 0 },
			],
		});
		const button = getByRole("button", { name: "Sources used" });
		expect(button).toHaveAttribute("title", "2 sources used");
		expect(queryByText("Knowledge Base")).toBeNull();

		await fireEvent.click(button);
		expect(getByText("Knowledge Base")).toBeInTheDocument();
		expect(getByText("guide.md")).toHaveTextContent("guide.md [chunk 2]");

		await fireEvent.click(button);
		expect(queryByText("Knowledge Base")).toBeNull();
	});

	test("failed sub-agents roll up into one strip that opens observability", async () => {
		const onopenobservability = vi.fn();
		const one = render(ChatMessage, {
			message: message({}),
			agentCalls: [agent("Fixer", "error"), agent("Writer", "complete")],
			onopenobservability,
		});
		await fireEvent.click(one.getByText('Agent "Fixer" failed'));
		expect(onopenobservability).toHaveBeenCalledTimes(1);
		one.unmount();

		const two = render(ChatMessage, {
			message: message({}),
			agentCalls: [agent("Fixer", "error"), agent("Writer", "error")],
		});
		expect(two.getByText("2 sub-agents failed")).toBeInTheDocument();
	});
});
