import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Context indicator — a DELIBERATE model switch re-scales the gauge.
 *
 * The bug this pins: once a conversation had one assistant reply, the
 * denominator was locked to the model that SERVED it. Picking a different model
 * changed the max tokens by nothing — the bar and the percentage sat exactly
 * where they were, so a user who switched to a 1M model to escape a full
 * context still saw "95%" and no reason to believe the switch had worked.
 *
 * The fix must NOT reopen #157, whose whole point was that the picker is stale
 * by default. So this spec pins both halves with the SAME model:
 *
 *   1. that model sitting in the global `ezcorp-last-model` key is INHERITED —
 *      it must not touch the denominator (still 95%, against the served 200k);
 *   2. the user then picking that same model from the composer is CHOSEN — it
 *      must re-aim the denominator at it (18%, against its 904k budget).
 *
 * Same model, same catalog, opposite outcomes — which is only possible if the
 * code is reading deliberateness and not merely "what is in the picker".
 *
 * Frontend-visual change → `@evidence`-tagged so the visual gate captures the
 * re-scaled pill and its popover.
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

/** The two windows that matter: the 200k model that served, and the 1M one. */
const MODELS = [
	{
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		tier: "balanced",
		costTier: "medium",
		displayName: "Claude Sonnet 4.5",
		available: true,
		contextWindow: 200_000,
		inputBudget: 168_000,
		estimated: false,
	},
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
];

test("switching models re-scales the context bar to the new model's budget @evidence", async ({
	page,
	mockApi,
}, testInfo) => {
	await installFakeEventSource(page);

	const proj = makeProject({ id: "p1" });
	// Unpinned, exactly like every conversation `createConversation` makes.
	const conv = makeConversation({ id: "A", projectId: "p1", title: "Model Switch" });
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
			model: "claude-sonnet-4-5",
			provider: "anthropic",
			parentMessageId: "u1",
			// 8k fresh + 152k from cache = 160k actually occupying the window.
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
	// The 1M model is ALREADY in the picker on load — inherited from the global
	// cross-chat preference, not chosen here. Half 1 of the assertion.
	await page.addInitScript(() => {
		localStorage.setItem(
			"ezcorp-last-model",
			JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-6" }),
		);
	});

	await page.goto("/project/p1/chat/A", { waitUntil: "networkidle" });
	await expect(page.getByText("served by the 200k model")).toBeVisible({ timeout: 5000 });

	const pct = page.getByTestId("context-usage-pct");
	// 160k against the SERVED model's 168k budget. The inherited 1M value in the
	// picker is ignored — #157 still holds.
	await expect(pct).toHaveText("95%");
	await expect(page.getByTestId("context-usage-indicator")).toHaveAttribute("data-tone", "danger");

	// Half 2: the user deliberately picks the very same 1M model.
	await page.getByTestId("model-selector").getByRole("button").first().click();
	await page.getByRole("option", { name: "Claude Sonnet 4.6" }).click();

	// 160k against 904k. Pre-fix this stayed at 95% forever.
	await expect(pct).toHaveText("18%");
	await expect(page.getByTestId("context-usage-indicator")).toHaveAttribute("data-tone", "muted");

	// The popover names the new numbers and says which turn they describe — a
	// gauge that re-scaled silently would be indistinguishable from a glitch.
	await page.getByTestId("context-usage-indicator").hover();
	const summary = page.getByTestId("ctx-usage-summary");
	await expect(summary).toContainText("904k");
	await expect(summary).toContainText("1.0M window");
	const explanation = page.getByTestId("ctx-usage-explanation");
	await expect(explanation).toContainText("switched models");
	await expect(explanation).toContainText("NEXT turn");

	await captureEvidence(page, testInfo, "context-window-model-switch");
});
