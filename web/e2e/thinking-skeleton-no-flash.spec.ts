/**
 * Regression: the "ghost skeleton paints over the thinking card" bug.
 *
 * Before the fix, ChatThread.handleTurnSaved spawned a fresh empty
 * `streaming-${runId}` placeholder + re-pointed the active leaf for EVERY
 * saved turn — including the terminal one. `run:turn_text_reset` then blanked
 * the runId buffers, so that empty placeholder satisfied the skeleton
 * condition in ChatMessage.svelte and the SkeletonLoader (`.skeleton-line`)
 * painted over the just-rendered thinking card until `run:complete`
 * reconciled from the DB.
 *
 * The fix makes `run:turn_saved` carry `thinkingContent` + `final`; on the
 * terminal turn the client makes the persisted row (now with the thinking
 * card) the active leaf and creates NO placeholder — so the skeleton can
 * never reappear after thinking has shown.
 *
 * Transport note: runtime events flow over SSE on `/api/runtime-events` via
 * EventSource. We use the same `installFakeTransports` + `__pushSse` pattern
 * as chat-blank-turn-race.spec.ts (the authoritative SSE streaming harness) —
 * the WS-only `emitWs` helper would not deliver these events.
 */

import { test, expect, type Page } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

async function installFakeTransports(page: Page) {
	await page.addInitScript(() => {
		const esInstances: Array<{ url: string; instance: any }> = [];
		class FakeEventSource {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSED = 2;
			readyState = 1;
			url: string;
			onopen: ((e: Event) => void) | null = null;
			onmessage: ((e: MessageEvent) => void) | null = null;
			onerror: ((e: Event) => void) | null = null;
			constructor(url: string) {
				this.url = url;
				esInstances.push({ url, instance: this });
				queueMicrotask(() => {
					this.readyState = 1;
					this.onopen?.(new Event("open"));
				});
			}
			addEventListener() {}
			removeEventListener() {}
			close() { this.readyState = 2; }
		}
		(window as any).EventSource = FakeEventSource;
		(window as any).__fakeEventSources = esInstances;
		(window as any).__pushSse = (evt: { type: string; data: unknown }) => {
			const list = (window as any).__fakeEventSources as Array<{
				instance: { onmessage: ((e: MessageEvent) => void) | null };
			}>;
			for (const { instance } of list) {
				instance.onmessage?.(new MessageEvent("message", { data: JSON.stringify(evt) }));
			}
		};
		const fakeWs = {
			readyState: 1, send() {}, close() {},
			addEventListener() {}, removeEventListener() {},
		};
		(window as any).WebSocket = function () { return fakeWs; };
		(window as any).WebSocket.CONNECTING = 0;
		(window as any).WebSocket.OPEN = 1;
		(window as any).WebSocket.CLOSING = 2;
		(window as any).WebSocket.CLOSED = 3;
	});
}

async function pushSse(page: Page, event: { type: string; data: unknown }) {
	await page.evaluate((evt) => { (window as any).__pushSse?.(evt); }, event);
}

test.describe("Thinking card survives terminal-turn save (no ghost skeleton)", () => {
	const proj = makeProject({ id: "proj-ghost", name: "Ghost Project" });
	const conv = makeConversation({ id: "conv-ghost", projectId: "proj-ghost", title: "Ghost Chat" });

	const THINK = "Let me reason through this carefully.";
	const ANSWER = "Quantum computing uses qubits.";

	test("single-turn thinking stream: thinking card stays, skeleton never reappears through run:complete", async ({ page }) => {
		await installFakeTransports(page);
		await setupApiMocks(page, { projects: [proj], conversations: [conv], messages: [] });

		// GET /messages: empty on the first two loads (initial list + tool
		// hydrate) so the assistant row isn't shown as history pre-stream;
		// populated WITH thinkingContent afterwards so the run:complete
		// reconcile keeps the thinking card.
		let getCount = 0;
		const persisted = [
			makeMessage({ id: "m-user", conversationId: "conv-ghost", role: "user", content: "Explain quantum computing", runId: null }),
			makeMessage({
				id: "m-assistant", conversationId: "conv-ghost", role: "assistant",
				content: ANSWER, thinkingContent: THINK, runId: "run-stream", parentMessageId: "m-user",
			}),
		];
		await page.route("**/api/conversations/conv-ghost/messages*", async (route) => {
			const req = route.request();
			if (req.method() !== "GET") return route.fallback();
			const url = new URL(req.url());
			getCount++;
			const ready = getCount > 2;
			if (url.searchParams.get("withToolCalls") === "true") {
				return route.fulfill({
					json: {
						messages: ready ? persisted.map((m) => ({ ...m, toolCalls: [] })) : [],
						subConversations: [],
					},
				});
			}
			return route.fulfill({ json: ready ? persisted : [] });
		});

		await page.goto(`/project/proj-ghost/chat/conv-ghost`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible({ timeout: 5000 });

		await page.addStyleTag({ content: ".ez-button { display: none !important; }" });
		await page.locator("textarea").fill("Explain quantum computing");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("Explain quantum computing")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({ timeout: 8000 });

		// Thinking streams → thinking card appears.
		await pushSse(page, { type: "run:token", data: { runId: "run-stream", token: THINK, kind: "thinking" } });
		const thinkingCard = page.locator("button").filter({ hasText: "Thinking" });
		await expect(thinkingCard).toBeVisible({ timeout: 5000 });

		// Text streams.
		await pushSse(page, { type: "run:token", data: { runId: "run-stream", token: ANSWER, kind: "text" } });
		await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 5000 });

		// Terminal turn saved (no tool calls → final:true), carrying thinking.
		await pushSse(page, {
			type: "run:turn_saved",
			data: {
				runId: "run-stream", conversationId: "conv-ghost", messageId: "m-assistant",
				parentMessageId: "m-user", content: ANSWER, thinkingContent: THINK, final: true,
			},
		});

		// THE REGRESSION: between turn_saved and run:complete the pre-fix code
		// showed a spurious empty placeholder → ghost skeleton over the
		// thinking card. Post-fix: no placeholder, no skeleton, card stays.
		await expect(thinkingCard).toBeVisible();
		await expect(page.getByText(ANSWER)).toBeVisible();
		await expect(page.locator(".skeleton-line")).toHaveCount(0);

		// Reset still fires after turn_saved (harmless now) — assert the
		// skeleton STILL doesn't appear once the runId buffers are blanked.
		await pushSse(page, { type: "run:turn_text_reset", data: { runId: "run-stream" } });
		await expect(page.locator(".skeleton-line")).toHaveCount(0);
		await expect(thinkingCard).toBeVisible();

		// Complete the run → reconcile fetches the persisted row (with
		// thinkingContent). Thinking card + text remain; no skeleton.
		await pushSse(page, {
			type: "run:complete",
			data: {
				run: {
					id: "run-stream", agentName: "test", status: "success",
					startedAt: "2026-01-01T00:00:00.000Z", logs: [],
					result: { success: true, output: ANSWER },
				},
			},
		});
		await page.waitForTimeout(500);

		await expect(thinkingCard).toBeVisible();
		await expect(page.getByText(ANSWER)).toBeVisible();
		await expect(page.locator(".skeleton-line")).toHaveCount(0);
	});
});
