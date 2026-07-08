import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * WS0 — prompt-cache meter pill.
 *
 * An assistant turn whose persisted `usage` carries the cache meter
 * (`cacheReadTokens` / `cacheWriteTokens` / `cacheHitRate`) renders a small
 * "N% cached · <tokens>" pill in the message footer. A turn with no cache
 * activity renders no pill (silent, not a noisy "0% cached").
 *
 * Frontend-visual change → `@evidence`-tagged so the visual gate captures a
 * screenshot of the rendered pill.
 */

async function installFakeEventSource(page: import("@playwright/test").Page) {
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
}

test("cache meter pill renders hit-rate + cached tokens for a cached turn @evidence", async ({ page, mockApi }, testInfo) => {
	await installFakeEventSource(page);

	const proj = makeProject({ id: "p1" });
	const conv = makeConversation({ id: "A", projectId: "p1", title: "Cache Meter" });
	const messages = [
		makeMessage({ id: "u1", conversationId: "A", role: "user", content: "explain caching", parentMessageId: null }),
		makeMessage({
			id: "a1",
			conversationId: "A",
			role: "assistant",
			content: "cached answer",
			model: "claude",
			provider: "anthropic",
			parentMessageId: "u1",
			// input 200 + cacheRead 800 = 1000 prompt tokens; 80% served from cache.
			usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 800, cacheWriteTokens: 0, cacheHitRate: 0.8 },
		}),
		// A second assistant turn with NO cache activity — must NOT show a pill.
		makeMessage({
			id: "a2",
			conversationId: "A",
			role: "assistant",
			content: "uncached answer",
			model: "claude",
			provider: "anthropic",
			parentMessageId: "a1",
			usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: 0 },
		}),
	];

	await mockApi({ projects: [proj], conversations: [conv], messages });
	await page.route("**/api/conversations/*/active-run", (route) =>
		route.fulfill({ json: { runId: "r-done", status: "completed" } }),
	);

	await page.goto(`/project/p1/chat/A`, { waitUntil: "networkidle" });

	await expect(page.getByText("cached answer")).toBeVisible({ timeout: 5000 });

	// The cached turn shows exactly one pill with the rounded hit-rate + tokens.
	const pill = page.getByTestId("cache-stats-pill");
	await expect(pill).toHaveCount(1);
	await expect(pill).toBeVisible();
	await expect(pill).toContainText("80% cached");
	await expect(pill).toContainText("800");

	await captureEvidence(page, testInfo, "cache-stats-pill");
});
