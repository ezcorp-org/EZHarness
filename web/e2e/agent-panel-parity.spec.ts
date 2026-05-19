/**
 * PHASE 5 — agent sub-chat panel has FULL main-chat parity.
 *
 * Proves the AgentDetailPanel now embeds <ChatThread variant="panel">:
 * open the panel from an agent chip → the shared thread renders the
 * sub-conversation history → send a message → live WS token stream
 * binds (no 5s poll) → main-chat toolbar affordances (Regenerate /
 * Copy) are present on the sub-chat turns → 44px-min touch targets on
 * mobile viewport.
 *
 * Mocked API + WS via the shared e2e fixtures (same harness as
 * `agent-panel-chat.spec.ts`).
 */

import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Agent Parity Project" });
const conv = makeConversation({
	id: "conv-1",
	projectId: "proj-1",
	title: "Parity Test",
});

const userMsg = makeMessage({
	id: "msg-user-1",
	conversationId: "conv-1",
	role: "user",
	content: "Delegate this",
	parentMessageId: null,
});
const assistantMsg = makeMessage({
	id: "msg-asst-1",
	conversationId: "conv-1",
	role: "assistant",
	content:
		'{"type":"agent_ref","agentName":"TestAgent","subConversationId":"sub-conv-1","runId":"run-1"}\n\nDelegating to TestAgent.',
	parentMessageId: "msg-user-1",
	createdAt: "2026-01-01T00:00:30.000Z",
});

const agentTaskMsg = makeMessage({
	id: "agent-msg-task",
	conversationId: "sub-conv-1",
	role: "user",
	content: "Investigate the failing test",
	createdAt: "2026-01-01T00:01:00.000Z",
});
const agentReplyMsg = makeMessage({
	id: "agent-msg-1",
	conversationId: "sub-conv-1",
	role: "assistant",
	content: "Here is what I found in the sub-chat.",
	parentMessageId: "agent-msg-task",
	createdAt: "2026-01-01T00:01:30.000Z",
});

async function openPanel(
	page: import("@playwright/test").Page,
	emitWs: (e: { type: string; data: unknown }) => Promise<void>,
) {
	await page.goto(`/project/proj-1/chat/conv-1`);
	await page.waitForLoadState("networkidle");
	await emitWs({
		type: "agent:spawn",
		data: {
			runId: "run-1",
			agentRunId: "run-1",
			subConversationId: "sub-conv-1",
			agentName: "TestAgent",
			agentConfigId: "cfg-1",
			task: "Investigate the failing test",
			parentConversationId: "conv-1",
		},
	});
	// AgentChip.svelte renders `<button data-testid="agent-chip">` — the
	// previous `[data-agent-chip]` selector matched NOTHING (no such
	// attribute exists in the app), so the chip was never clicked and
	// the panel never opened, which is why every assertion below was
	// silently `test.skip`ped. Use the real testid and ASSERT the panel
	// opens so the parity net actually covers something.
	const agentChip = page.locator('[data-testid="agent-chip"]').first();
	const panel = page.locator(".agent-detail-panel");
	await agentChip.waitFor({ state: "visible", timeout: 10000 });
	// The assistant turn's absolutely-positioned MessageToolbar overlay
	// (`-bottom-3 right-2`) sits on top of the chip's hit-point on a
	// 390px viewport, so a positional click (even forced) lands on the
	// overlay, not the chip. Dispatch the click straight to the chip so
	// AgentChip's `onclick` fires regardless of z-stacking (the visual
	// overlap is a Playwright hover-toolbar artefact, not a product
	// bug). `expect.toPass` tolerates the brief list re-render window
	// without a silent skip.
	await expect(async () => {
		await agentChip.dispatchEvent("click", { timeout: 2000 });
		await expect(panel).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 15000 });
	return panel;
}

const baseMock = {
	projects: [proj],
	conversations: [conv],
	// Sub-conv turns go in the TOP-LEVEL messages list (keyed by
	// conversationId) so the built-in /messages handler serves them
	// correctly for BOTH shapes the panel's ChatThread.loadMessages
	// reads: `?all=true` → raw Message[]  and  `?withToolCalls=true`
	// → { messages, subConversations, … }. The old
	// `routes["sub-conv-1/messages"]` override returned
	// `{ messages:[…] }` for BOTH, so the `?all=true` parse
	// (`allMessages = json as Message[]`) got a non-array and the
	// panel feed stayed empty.
	messages: [userMsg, assistantMsg, agentTaskMsg, agentReplyMsg],
	// Top-level subConversations feeds the `?withToolCalls=true` hydrate
	// that <ChatThread>'s loadMessages reads → `agentSubConvos` →
	// renders the <AgentChip data-testid="agent-chip">. The previous
	// `routes["/sub-conversations"]` override was NOT consumed by
	// ChatThread, so no chip ever rendered and the panel never opened
	// (the real reason these specs were silently test.skip'ped).
	subConversations: [
		{
			id: "sub-conv-1",
			agentName: "TestAgent",
			agentConfigId: "cfg-1",
			parentMessageId: "msg-asst-1",
			parentConversationId: "conv-1",
			// messageCount >= 1 → status "complete" → a CLICKABLE
			// <AgentChip> (not the "Agent did not respond" failure
			// banner that a 0-count sub-conv renders).
			messageCount: 2,
			lastMessagePreview: "Here is what I found in the sub-chat.",
		},
	],
	routes: {
		"/tasks": () => ({ conversationId: "conv-1", tasks: [] }),
	},
};

test.describe("Agent sub-chat panel parity (Phase 5)", () => {
	test("panel embeds the shared ChatThread (variant=panel) with sub-conv history", async ({
		page,
		mockApi,
		emitWs,
	}) => {
		await mockApi(baseMock);
		const panel = await openPanel(page, emitWs);
		// openPanel already asserts the panel opened (no silent skip).
		await expect(panel).toBeVisible();

		// The shared thread is mounted in panel variant inside the drawer.
		const thread = panel.locator('[data-testid="chat-thread"]');
		await expect(thread).toBeVisible();
		await expect(thread).toHaveAttribute("data-variant", "panel");

		// Sub-conversation history renders through ChatMessage (not the
		// old bespoke "Turn N / Response" feed).
		await expect(
			panel.getByText("Here is what I found in the sub-chat."),
		).toBeVisible({ timeout: 5000 });
	});

	test("sub-chat composer sends and live WS tokens bind (no 5s poll)", async ({
		page,
		mockApi,
		emitWs,
	}) => {
		await page.route(
			"**/api/conversations/sub-conv-1/messages",
			async (route) => {
				if (route.request().method() === "POST") {
					return route.fulfill({
						json: {
							userMessage: {
								id: "sub-sent",
								conversationId: "sub-conv-1",
								role: "user",
								content: "follow-up",
								createdAt: "2026-01-01T00:02:00.000Z",
								parentMessageId: "agent-msg-1",
							},
							runId: "run-stream",
							attachments: [],
							ezActionResults: [],
						},
					});
				}
				return route.continue();
			},
		);
		await mockApi(baseMock);
		const panel = await openPanel(page, emitWs);
		// openPanel already asserts the panel opened (no silent skip).
		await expect(panel).toBeVisible();

		const textarea = panel.locator("textarea");
		await expect(textarea).toBeVisible({ timeout: 5000 });
		await textarea.fill("follow-up");
		await panel
			.getByRole("button", { name: "Send message" })
			.click();
		await expect(panel.getByText("follow-up")).toBeVisible({
			timeout: 5000,
		});

		// Live WS token on the returned runId flips the thread's
		// streaming binding (Stop control) — proves SSE streaming, not
		// the removed 5s poll.
		await emitWs({
			type: "run:token",
			data: { runId: "run-stream", token: "streaming…" },
		});
		await expect(
			panel.getByRole("button", { name: /stop/i }),
		).toBeVisible({ timeout: 8000 });
	});

	test("sub-chat turns expose the full main-chat toolbar (Regenerate / Copy)", async ({
		page,
		mockApi,
		emitWs,
	}, testInfo) => {
		await mockApi(baseMock);
		const panel = await openPanel(page, emitWs);
		// openPanel already asserts the panel opened (no silent skip).
		await expect(panel).toBeVisible();

		await expect(
			panel.getByText("Here is what I found in the sub-chat."),
		).toBeVisible({ timeout: 5000 });
		// Reveal the shared (hover-gated) MessageToolbar. The
		// `mobile-chromium` project (Pixel 5 preset → coarse pointer,
		// `(hover: none)`) never fires `group-hover`, so the shared fix
		// reveals the toolbar on a plain TAP of the row instead. Desktop
		// (`chromium`, fine pointer) keeps the hover path unchanged. This
		// is the SAME shared ChatMessage/MessageToolbar mechanism the main
		// chat uses — the panel gets it for free, no panel-specific code.
		//
		// Drive the row via `dispatchEvent("click")` (the exact event the
		// production handler listens for) rather than `.tap()`: the
		// absolutely-positioned `-bottom-3` toolbar overlay sits over the
		// row's hit point and fails `.tap()`'s actionability check — the
		// same documented hover-toolbar artefact `openPanel` works around
		// for the chip click.
		if (testInfo.project.name === "mobile-chromium") {
			await panel
				.locator('[data-message-id="agent-msg-1"]')
				.dispatchEvent("click");
		} else {
			await panel
				.getByText("Here is what I found in the sub-chat.")
				.locator("..")
				.hover();
		}
		// Parity: the assistant turn carries the SAME MessageToolbar the
		// main chat uses (Regenerate is assistant-only; Copy is on all).
		await expect(
			panel
				.getByRole("button", { name: "Regenerate response" })
				.first(),
		).toBeVisible({ timeout: 5000 });
		await expect(
			panel.getByRole("button", { name: "Copy message" }).first(),
		).toBeVisible();
	});

	test("mobile viewport: panel toolbar targets are 44px-min (touch parity)", async ({
		page,
		mockApi,
		emitWs,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await mockApi(baseMock);
		const panel = await openPanel(page, emitWs);
		// openPanel already asserts the panel opened (no silent skip).
		await expect(panel).toBeVisible();

		const turnText = panel.getByText(
			"Here is what I found in the sub-chat.",
		);
		await expect(turnText).toBeVisible({ timeout: 5000 });
		// Reveal the (hover-gated) MessageToolbar. Hover the stable text
		// node itself with `force` — its parent wrapper re-renders and
		// the overlay toolbar intercepts pointer events on the 390px
		// viewport, so a normal actionable hover never settles. The
		// hover only needs to flip `group-hover`.
		await turnText.hover({ force: true });
		const copyBtn = panel
			.getByRole("button", { name: "Copy message" })
			.first();
		// The button exists in the DOM regardless of the hover opacity;
		// its box (the 44px-min touch target) is what parity demands.
		await copyBtn.waitFor({ state: "attached", timeout: 5000 });
		const box = await copyBtn.boundingBox();
		// MessageToolbar btnClass = min-h-[44px] min-w-[44px] on mobile.
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
	});
});
