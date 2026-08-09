import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Context indicator — the denominator follows the SERVED model.
 *
 * The bug this pins: the numerator came from the last assistant row (the model
 * that actually answered) while the denominator came from the model picker.
 * Those are different models more often than it looks —
 *
 *   - the picker is seeded from `ezcorp-last-model`, a single GLOBAL
 *     localStorage key shared across every chat and project, so the last model
 *     picked ANYWHERE became the denominator for every unpinned chat;
 *   - a new conversation is created with `model: null` and only an explicit
 *     pick ever writes it back, so most chats are unpinned;
 *   - failover and tier routing change the served model without touching the
 *     picker at all.
 *
 * Net effect: a thread served by a 200k model, with a 1M model left in the
 * picker, reported ~16% used when it was actually near full — and the user saw
 * a 1M window on a model that does not have one.
 *
 * Also pinned here: usage is measured against the ENFORCED input budget
 * (window − response reserve − safety margin), because compaction starts
 * dropping messages there, not at the raw window.
 *
 * Frontend-visual change → `@evidence`-tagged so the visual gate captures the
 * rendered pill and its popover.
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

/** Catalog with the two windows that matter: a real 1M model and a 200k one. */
const MODELS = [
	{
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		tier: "balanced",
		costTier: "medium",
		displayName: "Claude Sonnet 4.6",
		available: true,
		contextWindow: 1_000_000,
		inputBudget: 904_000,
		estimated: false,
	},
	{
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		tier: "balanced",
		costTier: "medium",
		displayName: "Claude Sonnet 4.5",
		available: true,
		// 200k, NOT the 1M the upstream catalog claims for this id.
		contextWindow: 200_000,
		inputBudget: 168_000,
		estimated: false,
	},
];

test("context indicator measures the served model's budget, not the picker's window @evidence", async ({
	page,
	mockApi,
}, testInfo) => {
	await installFakeEventSource(page);

	const proj = makeProject({ id: "p1" });
	// Unpinned, exactly like every conversation `createConversation` makes.
	const conv = makeConversation({ id: "A", projectId: "p1", title: "Context Window" });
	const messages = [
		makeMessage({
			id: "u1",
			conversationId: "A",
			role: "user",
			content: "a long conversation",
			parentMessageId: null,
		}),
		makeMessage({
			id: "a1",
			conversationId: "A",
			role: "assistant",
			content: "served by the 200k model",
			// The model that ACTUALLY answered.
			model: "claude-sonnet-4-5",
			provider: "anthropic",
			parentMessageId: "u1",
			// 8k fresh + 152k served from cache = 160k actually occupying the
			// window. Counting only the fresh 8k is how the gauge used to read
			// near-empty on a thread that was nearly full.
			usage: {
				inputTokens: 8_000,
				outputTokens: 500,
				cacheReadTokens: 152_000,
				cacheWriteTokens: 0,
				cacheHitRate: 0.95,
			},
		}),
	];

	await mockApi({ projects: [proj], conversations: [conv], messages });
	await page.route("**/api/models", (route) => route.fulfill({ json: MODELS }));
	await page.route("**/api/conversations/*/active-run", (route) =>
		route.fulfill({ json: { runId: "r-done", status: "completed" } }),
	);
	// The stale global preference: the user last picked the 1M model somewhere
	// else entirely. Pre-fix this became this chat's denominator.
	await page.addInitScript(() => {
		localStorage.setItem(
			"ezcorp-last-model",
			JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-6" }),
		);
	});

	await page.goto("/project/p1/chat/A", { waitUntil: "networkidle" });
	await expect(page.getByText("served by the 200k model")).toBeVisible({ timeout: 5000 });

	// 160k against the SERVED model's 168k budget = 95%.
	// Pre-fix: 8k against the picker's 1M window = 1%.
	const pct = page.getByTestId("context-usage-pct");
	await expect(pct).toBeVisible();
	await expect(pct).toHaveText("95%");
	await expect(page.getByTestId("context-usage-indicator")).toHaveAttribute("data-tone", "danger");

	// The popover names both numbers, so the reserve is self-explaining rather
	// than something the user has to discover.
	await page.getByTestId("context-usage-indicator").hover();
	const summary = page.getByTestId("ctx-usage-summary");
	await expect(summary).toBeVisible();
	await expect(summary).toContainText("168k");
	await expect(summary).toContainText("200k window");
	// The 1M model is in the catalog but did not serve this turn — its window
	// must appear nowhere in the indicator.
	await expect(summary).not.toContainText("1.0M");

	await expect(page.getByTestId("ctx-usage-explanation")).toContainText(
		"older messages start being dropped",
	);

	await captureEvidence(page, testInfo, "context-window-served-model");
});
