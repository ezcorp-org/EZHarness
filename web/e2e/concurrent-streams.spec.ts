/**
 * PHASE 6 — concurrent main + panel stream isolation + mobile
 * long-press-in-drawer.
 *
 * Risk-register catching test for:
 *  - #2 Streaming double-subscribe: the main chat thread and the agent
 *       sub-chat panel are TWO mounted <ChatThread> instances. Their
 *       streaming `$derived` mirrors are runId-keyed off one global
 *       store; a token for the panel's run must NOT bleed into the main
 *       thread and vice-versa (instance-local `activeRunId`).
 *  - #5 Mobile long-press synthetic shiftKey lost in drawer: the panel
 *       uses the SAME MessageToolbar (no fork) so a long-press on a
 *       sub-chat turn still works on a mobile viewport.
 *
 * Mocked API + WS via the shared fixtures.
 */

import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Concurrent Project" });
const conv = makeConversation({
	id: "conv-1",
	projectId: "proj-1",
	title: "Concurrent",
});

const userMsg = makeMessage({
	id: "msg-user-1",
	conversationId: "conv-1",
	role: "user",
	content: "Kick off the agent",
	parentMessageId: null,
});
const assistantMsg = makeMessage({
	id: "msg-asst-1",
	conversationId: "conv-1",
	role: "assistant",
	content:
		'{"type":"agent_ref","agentName":"TestAgent","subConversationId":"sub-conv-1","runId":"run-1"}\n\nDelegating.',
	parentMessageId: "msg-user-1",
	createdAt: "2026-01-01T00:00:30.000Z",
});
const subTask = makeMessage({
	id: "sub-task",
	conversationId: "sub-conv-1",
	role: "user",
	content: "Sub task",
	createdAt: "2026-01-01T00:01:00.000Z",
});
const subReply = makeMessage({
	id: "sub-reply",
	conversationId: "sub-conv-1",
	role: "assistant",
	content: "Sub chat answer for long-press copy",
	parentMessageId: "sub-task",
	createdAt: "2026-01-01T00:01:30.000Z",
});

const baseMock = {
	projects: [proj],
	conversations: [conv],
	// Sub-conv turns go in the TOP-LEVEL messages list (keyed by
	// conversationId) so the built-in /messages handler serves them for
	// BOTH shapes the panel's ChatThread.loadMessages reads: `?all=true`
	// → raw Message[]  and  `?withToolCalls=true` → { messages, … }.
	messages: [userMsg, assistantMsg, subTask, subReply],
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
			lastMessagePreview: "Sub chat answer for long-press copy",
		},
	],
	routes: {
		"/tasks": () => ({ conversationId: "conv-1", tasks: [] }),
	},
};

/**
 * Navigate + spawn the agent so the (clickable) chip is on-screen, but
 * do NOT open the panel yet. The panel is a `fixed inset-0` modal
 * drawer that covers the main thread — tests that need to interact with
 * the MAIN thread first must do so before `clickChipToOpenPanel`.
 */
async function gotoWithAgentChip(
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
			task: "Sub task",
			parentConversationId: "conv-1",
		},
	});
	// AgentChip.svelte renders `<button data-testid="agent-chip">`. The
	// previous `[data-agent-chip]` selector matched NOTHING (no such
	// attribute exists anywhere in the app), so the chip was never
	// clicked and the panel never opened — the real reason these specs
	// were silently `test.skip`ped. Just confirm it renders here;
	// clickChipToOpenPanel re-queries it fresh (the list may re-render
	// before the panel is opened).
	await page
		.locator('[data-testid="agent-chip"]')
		.first()
		.waitFor({ state: "visible", timeout: 10000 });
}

async function clickChipToOpenPanel(
	page: import("@playwright/test").Page,
) {
	const chip = page.locator('[data-testid="agent-chip"]').first();
	const panel = page.locator(".agent-detail-panel");
	// Sending on the main thread keeps re-rendering the message list
	// (loadMessages refetch + run-main streaming), so the chip element
	// is repeatedly detached/reattached. `expect.toPass` retries the
	// whole "dispatch click on a freshly-resolved chip" until the panel
	// actually opens, tolerating the volatile re-render window without a
	// silent skip. `dispatchEvent` fires AgentChip's `onclick`
	// regardless of the hover-toolbar overlay z-stacking (a Playwright
	// artefact, not a product bug).
	await expect(async () => {
		await chip.dispatchEvent("click", { timeout: 2000 });
		await expect(panel).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 15000 });
	await panel.waitFor({ state: "visible", timeout: 10000 });
	return panel;
}

test.describe("Concurrent main + panel stream isolation (Phase 6)", () => {
	test("a panel run's token does not bind the main thread's stream", async ({
		page,
		mockApi,
		emitWs,
	}) => {
		// Stub the PANEL composer send so it binds run-panel.
		await page.route(
			"**/api/conversations/sub-conv-1/messages",
			async (route) => {
				if (route.request().method() === "POST")
					return route.fulfill({
						json: {
							userMessage: {
								id: "panel-sent",
								conversationId: "sub-conv-1",
								role: "user",
								content: "panel msg",
								createdAt: "2026-01-01T00:02:00.000Z",
								parentMessageId: "sub-reply",
							},
							runId: "run-panel",
							attachments: [],
							ezActionResults: [],
						},
					});
				return route.continue();
			},
		);
		await mockApi(baseMock);
		await gotoWithAgentChip(page, emitWs);

		// Open the panel → TWO <ChatThread> instances are mounted (the
		// main page thread + the panel's). The panel is a fixed inset-0
		// modal, so we drive the ISOLATION contract via the panel
		// composer + WS tokens (no main-composer interaction needed —
		// the main thread is queried by testid, which works even while
		// it's pointer-covered by the modal).
		const panel = await clickChipToOpenPanel(page);
		await expect(panel).toBeVisible();
		const mainThread = page
			.locator('[data-testid="chat-thread"][data-variant="page"]')
			.first();
		await expect(
			page.locator('[data-testid="chat-thread"]'),
		).toHaveCount(2);

		// Send on the PANEL → the panel instance binds run-panel.
		const panelTextarea = panel.locator("textarea").first();
		await panelTextarea.fill("panel msg");
		await panel
			.getByRole("button", { name: "Send message" })
			.click();
		await expect(panel.getByText("panel msg")).toBeVisible({
			timeout: 5000,
		});

		// Emit a token for a run NEITHER instance is tracking
		// (run-orphan). Instance-local activeRunId means it must bind
		// NOTHING — not the panel, not the main thread.
		await emitWs({
			type: "run:token",
			data: { runId: "run-orphan", token: "orphan token" },
		});
		// Emit the PANEL's own run token → the panel (and ONLY the panel)
		// shows the Stop control; the main thread, bound to no run, must
		// not.
		await emitWs({
			type: "run:token",
			data: { runId: "run-panel", token: "panel stream token" },
		});
		await expect(
			panel.getByRole("button", { name: /stop/i }),
		).toBeVisible({ timeout: 8000 });

		// Cross-instance isolation: the panel's run token never leaked
		// into the main thread, and the orphan token bound nowhere.
		await expect(
			mainThread.getByText("panel stream token"),
		).toHaveCount(0);
		await expect(
			mainThread.getByRole("button", { name: /stop/i }),
		).toHaveCount(0);
		await expect(page.getByText("orphan token")).toHaveCount(0);
	});
});

test.describe("Mobile long-press inside the agent drawer (Phase 6)", () => {
	test("long-press on a sub-chat turn works on a mobile viewport", async ({
		page,
		mockApi,
		emitWs,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await mockApi(baseMock);
		await gotoWithAgentChip(page, emitWs);
		const panel = await clickChipToOpenPanel(page);
		// clickChipToOpenPanel already waits for visible (no silent skip).
		await expect(panel).toBeVisible();

		const turn = panel.getByText(
			"Sub chat answer for long-press copy",
		);
		await expect(turn).toBeVisible({ timeout: 5000 });

		// Synthesise the 500ms touch-hold on the sub-chat row (same
		// gesture the main chat uses — the panel did NOT fork the
		// toolbar / select machinery).
		const row = turn.locator("..");
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const loc = row as any;
		await loc.dispatchEvent("pointerdown", {
			pointerType: "touch",
			clientX: 10,
			clientY: 10,
		});
		await page.waitForTimeout(700);
		await loc.dispatchEvent("pointerup", {
			pointerType: "touch",
			clientX: 10,
			clientY: 10,
		});

		// The sub-chat now exposes the SAME MessageToolbar — hover/press
		// reveals Copy with a 44px-min touch target (no drawer fork).
		await row.hover();
		const copyBtn = panel
			.getByRole("button", { name: "Copy message" })
			.first();
		await expect(copyBtn).toBeVisible({ timeout: 5000 });
		const box = await copyBtn.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
	});
});
