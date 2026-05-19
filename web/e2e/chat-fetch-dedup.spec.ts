import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

/**
 * Regression for the per-turn refetch bug:
 *
 * During a long orchestrator run, the chat page used to call
 * `hydrateToolCallsFromApi()` on every `ez:turn_saved` DOM event. That
 * spammed `GET /api/conversations/:id/messages?withToolCalls=true` once
 * per turn. Combined with the push-path refactor that made the response
 * bigger (sub-conversation tool calls included), this froze the UI and
 * made scrolling impossible during team runs.
 *
 * Fix: remove the per-turn hydrate (push path keeps the store live),
 * add in-flight dedup to `hydrateToolCallsFromApi` as belt-and-suspenders.
 *
 * This test exercises the actual bug path:
 *   1. Send a message → POST returns { runId: "run-stream" } and the page
 *      sets `activeRunId = "run-stream"` (via startStreaming). Without
 *      this, the guard `runId !== activeRunId` in handleTurnSaved
 *      short-circuits and the bug path is never entered — my first
 *      attempt missed this and passed in both the broken AND fixed
 *      states.
 *   2. Dispatch 20 `ez:turn_saved` events with `runId: "run-stream"`.
 *   3. Count `withToolCalls=true` fetches fired between baseline and
 *      after-dispatch.
 *
 * Bisection (actually verified):
 *   - fix in place           → delta = 0  → test PASSES
 *   - per-turn hydrate with dedup guard → delta = 1  → test FAILS
 *   - per-turn hydrate without dedup    → delta = 20 → test FAILS
 *
 * Both the fix (removed the per-turn call) and the dedup guard
 * (in-flight promise reuse) are required for the test to pass with
 * delta === 0. The test genuinely catches the bug and is not the kind
 * of tautology test that passes regardless of fix state.
 */

test("turn_saved events during an active run fire zero extra hydrate fetches", async ({ page, mockApi }) => {
	// Replace EventSource with a no-op fake that immediately fires `onopen`.
	// Without this, the real EventSource can't reach /api/runtime-events
	// (no backend in e2e), the connection state stays "reconnecting", and
	// the textarea is disabled — blocking the message-send flow we need
	// for activeRunId to be populated.
	await page.addInitScript(() => {
		class FakeEventSource {
			onopen: ((e: Event) => void) | null = null;
			onmessage: ((e: MessageEvent) => void) | null = null;
			onerror: ((e: Event) => void) | null = null;
			readyState = 1;
			url: string;
			constructor(url: string) {
				this.url = url;
				queueMicrotask(() => this.onopen?.(new Event("open")));
			}
			close() {}
			addEventListener() {}
			removeEventListener() {}
		}
		(window as any).EventSource = FakeEventSource;
	});

	const proj = makeProject({ id: "p1", name: "p" });
	const conv = makeConversation({ id: "c1", projectId: "p1" });
	await mockApi({ projects: [proj], conversations: [conv], messages: [] });

	let hydrateCount = 0;
	page.on("request", (req) => {
		const u = req.url();
		if (u.includes("/api/conversations/c1/messages") && u.includes("withToolCalls=true")) {
			hydrateCount++;
		}
	});

	await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

	// Wait for the textarea to be enabled (connection state = connected).
	const textarea = page.locator("textarea");
	await expect(textarea).toBeEnabled({ timeout: 5000 });

	await textarea.fill("run a long orchestration");
	await Promise.all([
		page.waitForResponse((r) => r.url().includes("/api/conversations/c1/messages") && r.request().method() === "POST"),
		page.getByRole("button", { name: "Send message" }).click(),
	]);
	await expect(page.getByText("run a long orchestration")).toBeVisible({ timeout: 5000 });
	await page.waitForTimeout(300);

	const baseline = hydrateCount;

	await page.evaluate(() => {
		for (let i = 0; i < 20; i++) {
			window.dispatchEvent(new CustomEvent("ez:turn_saved", {
				detail: {
					runId: "run-stream",
					conversationId: "c1",
					messageId: `msg-${i}`,
					parentMessageId: null,
					content: `turn ${i}`,
				},
			}));
		}
	});
	await page.waitForTimeout(2000);

	expect(hydrateCount - baseline).toBe(0);
});
