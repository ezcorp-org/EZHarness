import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * WS0 — prompt-cache meter pill.
 *
 * An assistant turn whose persisted `usage` carries the cache meter
 * (`cacheReadTokens` / `cacheWriteTokens` / `cacheHitRate`) renders a small
 * "N% cached · <tokens>" pill in the message footer. A turn with no cache
 * activity renders no pill (silent, not a noisy "0% cached"). A turn whose
 * writes include a 1h-retention subset (`cacheWrite1hTokens`) appends a
 * "· <tokens> @1h (2×)" premium segment — Anthropic bills 1h cache writes at
 * 2× the base input rate, and the tooltip explains that.
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
			content: "reply from a cached turn",
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
			content: "reply with fresh input only",
			model: "claude",
			provider: "anthropic",
			parentMessageId: "a1",
			usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: 0 },
		}),
		// A third turn whose cache writes include a 1h-retention subset —
		// must append the "@1h (2×)" premium segment to its pill.
		makeMessage({
			id: "a3",
			conversationId: "A",
			role: "assistant",
			content: "reply with a 1h cache write premium",
			model: "claude",
			provider: "anthropic",
			parentMessageId: "a2",
			// input 100 + cacheRead 800 + cacheWrite 300 = 1200 prompt tokens;
			// 120 of the 300 written tokens carry 1h retention (subset).
			usage: {
				inputTokens: 100,
				outputTokens: 30,
				cacheReadTokens: 800,
				cacheWriteTokens: 300,
				cacheWrite1hTokens: 120,
				cacheHitRate: 800 / 1200,
			},
		}),
	];

	await mockApi({ projects: [proj], conversations: [conv], messages });
	await page.route("**/api/conversations/*/active-run", (route) =>
		route.fulfill({ json: { runId: "r-done", status: "completed" } }),
	);

	await page.goto(`/project/p1/chat/A`, { waitUntil: "networkidle" });

	await expect(page.getByText("reply from a cached turn")).toBeVisible({ timeout: 5000 });
	await expect(page.getByText("reply with fresh input only")).toBeVisible();
	await expect(page.getByText("reply with a 1h cache write premium")).toBeVisible();

	// The two cached turns each show a pill; the no-cache turn shows none.
	const pill = page.getByTestId("cache-stats-pill");
	await expect(pill).toHaveCount(2);
	// First cached turn: rounded hit-rate + tokens, and NO 1h premium segment
	// (its writes carry no 1h-retention subset).
	await expect(pill.first()).toBeVisible();
	await expect(pill.first()).toContainText("80% cached");
	await expect(pill.first()).toContainText("800");
	await expect(pill.first()).not.toContainText("@1h");

	await captureEvidence(page, testInfo, "cache-stats-pill");

	// The 1h-premium turn appends "· <tokens> @1h (2×)" and its tooltip
	// explains the 2× write premium.
	const premiumPill = pill.nth(1);
	await expect(premiumPill).toBeVisible();
	await expect(premiumPill).toContainText("67% cached");
	await expect(premiumPill).toContainText("120 @1h (2×)");
	await expect(premiumPill).toHaveAttribute(
		"title",
		/120 with 1h retention — 1h cache writes bill at 2× the base input rate/,
	);

	await captureEvidence(page, testInfo, "cache-stats-pill-1h");
});

// demo: visual-evidence scoped-gallery demonstration (PR is throwaway)
