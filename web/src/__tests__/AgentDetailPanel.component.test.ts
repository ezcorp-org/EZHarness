/**
 * PHASE 5 — AgentDetailPanel now embeds <ChatThread variant="panel">.
 *
 * Pins the Phase-5 contract (tasks/chatthread-parity.md §5): the panel
 * keeps ONLY its own chrome (agent header / status / task) and delegates
 * the entire feed + composer to the shared <ChatThread variant="panel">
 * — full main-chat parity (toolbar, branch nav, live streaming), NO 5s
 * poll timer, and `persistModel` wired to `updateConversation` so a
 * model pick lands on the sub-conv row.
 *
 * Replaces the pre-Phase-5 `agent-detail-panel-model-picker.component`
 * suite, which pinned the now-deleted DetailMessage feed +
 * standalone ModelSelector + PanelChatInput. The model-picker behaviour
 * it covered (seed from last model, persist to row, send body carries
 * the pair) is now ChatThread's load + persistModel + send-message
 * factory path, covered by `ChatThread.component.test.ts`.
 *
 * vitest + jsdom + @testing-library/svelte.
 */

import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";

const { updateConversationMock } = vi.hoisted(() => ({
	updateConversationMock: vi.fn(async (id: string) => ({ id })),
}));

vi.mock("$app/state", () => ({
	page: {
		params: { id: "proj-1", convId: "conv-1" },
		url: new URL("http://localhost/project/proj-1/chat/conv-1"),
	},
}));
vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("$app/environment", () => ({
	browser: true,
	dev: false,
	building: false,
	version: "test",
}));
vi.mock("$lib/api.js", () => ({
	updateConversation: updateConversationMock,
	fetchAllMessages: vi.fn(async () => []),
	sendMessage: vi.fn(),
	createSubConversation: vi.fn(),
	cloneTurns: vi.fn(),
	setMessageExcluded: vi.fn(),
	patchMessageContent: vi.fn(),
	fetchModes: vi.fn(async () => []),
	createConversation: vi.fn(),
}));
vi.mock("$lib/oauth.js", () => ({
	listenForOAuthResult: vi.fn(() => () => {}),
	startOAuthFlow: vi.fn(),
	completeOAuthWithCode: vi.fn(),
	isLoginCommand: () => null,
}));
vi.mock("$lib/commands.js", () => ({ isModelCommand: () => null }));
vi.mock("$lib/mention-logic.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/mention-logic.js")>();
	return { ...actual };
});
vi.mock("$lib/sub-conversation-store.svelte.js", () => ({
	subConversationStore: {
		get activeSubConversation() {
			return null;
		},
		get isInSubConversation() {
			return false;
		},
		get activeSubConversationId() {
			return null;
		},
		get subConvoMessages() {
			return [];
		},
		startSubConversation: vi.fn(),
		endSubConversation: vi.fn(() => []),
		addMessage: vi.fn(),
		setStreaming: vi.fn(),
	},
}));

const { backgroundFetchSpy } = vi.hoisted(() => ({
	backgroundFetchSpy: vi.fn(
		async (_key?: string, _url?: string): Promise<Response | null> =>
			null,
	),
}));
vi.mock("$lib/utils/fetch-policy.js", () => ({
	userFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
	backgroundFetch: backgroundFetchSpy,
	invalidate: vi.fn(),
}));

import AgentDetailPanel from "../lib/components/AgentDetailPanel.svelte";
import type { AgentCallState } from "$lib/stores.svelte.js";
import { __resetCapabilityCacheForTests } from "$lib/chat/attachment-client";
import { makeCapabilitiesFetch } from "./stubs/model-capabilities";

function makeAgent(o: Partial<AgentCallState> = {}): AgentCallState {
	return {
		runId: "run-1",
		agentRunId: "run-1",
		agentName: "researcher",
		agentConfigId: "cfg-1",
		subConversationId: "sub-1",
		status: "complete",
		task: "Investigate the bug",
		...o,
	} as AgentCallState;
}

beforeEach(() => {
	updateConversationMock.mockClear();
	backgroundFetchSpy.mockClear();
	// attachment-client memoises capability promises per (provider,
	// model); flush so each render re-hits the stubbed
	// /api/models/capabilities and never reuses a stale/undefined body.
	__resetCapabilityCacheForTests();
	type AnyCtor = { new (...a: unknown[]): unknown };
	const g = globalThis as unknown as {
		IntersectionObserver?: AnyCtor;
		ResizeObserver?: AnyCtor;
		fetch?: typeof fetch;
	};
	if (typeof g.IntersectionObserver === "undefined") {
		g.IntersectionObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as AnyCtor;
	}
	if (typeof g.ResizeObserver === "undefined") {
		g.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as AnyCtor;
	}
	if (!Element.prototype.scrollIntoView) {
		Element.prototype.scrollIntoView = () => {};
	}
	// URL-aware: the embedded real ChatThread → ChatInput → ModelSelector
	// loads `/api/models` on mount and `/api/models/capabilities` per
	// pick. The shared stub returns a WELL-FORMED capabilities body
	// (with `kinds`) so ChatInput's attachmentsSupported derived can't
	// crash in teardown (fix-loop #5), plus two available models so the
	// persist test can drive a genuine pick.
	const capsFetch = makeCapabilitiesFetch([
		{
			provider: "anthropic",
			model: "claude-opus-4",
			displayName: "Claude Opus 4",
			available: true,
			tier: "flagship",
		},
		{
			provider: "openai",
			model: "gpt-5",
			displayName: "GPT-5",
			available: true,
			tier: "flagship",
		},
	]);
	g.fetch = vi.fn(
		async (input: RequestInfo | URL) =>
			capsFetch(input) ??
			new Response(JSON.stringify({ tools: [], value: false }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	) as unknown as typeof fetch;
});

describe("AgentDetailPanel embeds <ChatThread variant=panel>", () => {
	test("renders exactly one ChatThread, in the panel variant", () => {
		const { container } = render(AgentDetailPanel, {
			agent: makeAgent(),
			open: true,
			onclose: vi.fn(),
		});
		const threads = container.querySelectorAll(
			'[data-testid="chat-thread"]',
		);
		expect(threads.length).toBe(1);
		expect(threads[0]!.getAttribute("data-variant")).toBe("panel");
	});

	test("keeps its own agent header (name + task), not a bespoke feed", () => {
		const { getByText } = render(AgentDetailPanel, {
			agent: makeAgent({ agentName: "researcher", task: "Find it" }),
			open: true,
			onclose: vi.fn(),
		});
		expect(getByText("@researcher")).toBeInTheDocument();
		expect(getByText("Find it")).toBeInTheDocument();
	});

	test("status badge reflects the agent run state", () => {
		const { getByText, rerender } = render(AgentDetailPanel, {
			agent: makeAgent({ status: "complete" }),
			open: true,
			onclose: vi.fn(),
		});
		expect(getByText("Complete")).toBeInTheDocument();
		rerender({
			agent: makeAgent({ status: "error" }),
			open: true,
			onclose: vi.fn(),
		});
		expect(getByText("Failed")).toBeInTheDocument();
	});

	test("header Close button invokes onclose", async () => {
		const onclose = vi.fn();
		const { getAllByLabelText } = render(AgentDetailPanel, {
			agent: makeAgent(),
			open: true,
			onclose,
		});
		// The panel header owns the (single) Close affordance — ChatThread
		// renders no header of its own when none is passed.
		const closeBtns = getAllByLabelText("Close");
		await fireEvent.click(closeBtns[0]!);
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	test("no 5s poll timer — backgroundFetch is NOT called on a poll interval", () => {
		vi.useFakeTimers();
		try {
			render(AgentDetailPanel, {
				agent: makeAgent({ status: "running" }),
				open: true,
				onclose: vi.fn(),
			});
			const callsBefore = backgroundFetchSpy.mock.calls.length;
			// Pre-Phase-5 a running agent polled every 5s. Advance well
			// past several intervals — there must be NO interval-driven
			// burst of message refetches.
			vi.advanceTimersByTime(30_000);
			const pollCalls = backgroundFetchSpy.mock.calls
				.slice(callsBefore)
				.filter(([, url]) =>
					String(url).includes("agent-detail:"),
				);
			expect(pollCalls.length).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("model persistence: a real model pick PUTs { provider, model } to the SUB-CONV row", async () => {
		// CONTRACT (regression-pinned): AgentDetailPanel injects
		// persistModel=(p,m)=>updateConversation(subConvId,{provider,model})
		// into the embedded REAL ChatThread. Previously this was asserted
		// NOWHERE — the old test only checked the not-called case and
		// deferred the real path to ChatThread.component.test.ts (which
		// ALSO only checked not-called: a circular non-coverage).
		//
		// This drives a genuine model pick through the live DOM
		// (panel → ChatThread → ChatInput → ModelSelector) and asserts
		// the write lands on the SUB-conv row with the right shape — no
		// main-conv leak, no stub.
		const { container } = render(AgentDetailPanel, {
			agent: makeAgent({ subConversationId: "sub-99" }),
			open: true,
			onclose: vi.fn(),
		});

		// Before any model change → no persistence (the panel must not
		// write on mount).
		expect(updateConversationMock).not.toHaveBeenCalled();

		// Open the embedded composer's model selector (loaded from the
		// mocked /api/models).
		const selector = await vi.waitFor(() => {
			const el = container.querySelector(
				'[data-testid="model-selector"]',
			);
			if (!el) throw new Error("model-selector not mounted yet");
			return el as HTMLElement;
		});
		await fireEvent.click(selector.querySelector("button")!);

		// Pick "Claude Opus 4" — the real selectModel → onselect →
		// ChatThread.handleModelChange → injected persistModel.
		const option = await vi.waitFor(() => {
			const opt = Array.from(
				selector.querySelectorAll('[role="option"]'),
			).find((b) => b.textContent?.includes("Claude Opus 4"));
			if (!opt) throw new Error("Claude Opus 4 option not rendered");
			return opt as HTMLElement;
		});
		await fireEvent.click(option);

		await vi.waitFor(() =>
			expect(updateConversationMock).toHaveBeenCalledWith("sub-99", {
				provider: "anthropic",
				model: "claude-opus-4",
			}),
		);
	});

	test("does not render when there is no sub-conversation id", () => {
		const { container } = render(AgentDetailPanel, {
			agent: makeAgent({ subConversationId: "" }),
			open: true,
			onclose: vi.fn(),
		});
		// Header still shows, but no ChatThread (guarded on subConvId).
		expect(
			container.querySelectorAll('[data-testid="chat-thread"]').length,
		).toBe(0);
	});
});
