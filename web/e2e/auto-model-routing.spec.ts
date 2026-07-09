import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Auto (smart routing) — model-picker entry + per-message provenance pills.
 *
 * RENDER-level spec (mockApi; no Docker):
 *
 * 1. Assistant turns persisted with routing provenance render the footer
 *    pills: `usage.requestedModel === null` → an "auto" pill next to the
 *    served model name; `usage.failover === true` → an amber "failover"
 *    pill. Turns without provenance (legacy rows / pinned turns) render
 *    neither.
 *
 * 2. Selecting the dedicated "Auto (smart routing)" picker row puts the
 *    EXPLICIT `model: null, provider: null` sentinel on the send wire —
 *    distinguishable from an absent field — so the server routes the turn
 *    instead of falling back to the stored conv.model.
 *
 * Frontend-visual change → `@evidence`-tagged with `captureEvidence`.
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

test("auto-routed and failover turns render provenance pills @evidence", async ({ page, mockApi }, testInfo) => {
	await installFakeEventSource(page);

	const proj = makeProject({ id: "p1" });
	const conv = makeConversation({ id: "A", projectId: "p1", title: "Auto Routing" });
	const messages = [
		makeMessage({ id: "u1", conversationId: "A", role: "user", content: "route this", parentMessageId: null }),
		// Routed turn: no user pin (requestedModel === null) → "auto" pill
		// beside the served model name.
		makeMessage({
			id: "a1",
			conversationId: "A",
			role: "assistant",
			content: "reply from a routed turn",
			model: "claude-sonnet-4-20250514",
			provider: "anthropic",
			parentMessageId: "u1",
			usage: {
				inputTokens: 100,
				outputTokens: 20,
				requestedProvider: null,
				requestedModel: null,
				routedTier: "balanced",
			},
		}),
		// Routed turn that ALSO failed over pre-stream → auto + failover pills.
		makeMessage({
			id: "a2",
			conversationId: "A",
			role: "assistant",
			content: "reply served by a fallback provider",
			model: "gpt-4o",
			provider: "openai",
			parentMessageId: "a1",
			usage: {
				inputTokens: 120,
				outputTokens: 25,
				requestedProvider: null,
				requestedModel: null,
				routedTier: "balanced",
				failover: true,
			},
		}),
		// Pinned turn (explicit user pin in provenance) → NO pills.
		makeMessage({
			id: "a3",
			conversationId: "A",
			role: "assistant",
			content: "reply from a pinned turn",
			model: "claude-sonnet-4-20250514",
			provider: "anthropic",
			parentMessageId: "a2",
			usage: {
				inputTokens: 90,
				outputTokens: 15,
				requestedProvider: "anthropic",
				requestedModel: "claude-sonnet-4-20250514",
			},
		}),
	];

	await mockApi({ projects: [proj], conversations: [conv], messages });
	await page.route("**/api/conversations/*/active-run", (route) =>
		route.fulfill({ json: { runId: "r-done", status: "completed" } }),
	);

	await page.goto(`/project/p1/chat/A`, { waitUntil: "networkidle" });

	await expect(page.getByText("reply from a routed turn")).toBeVisible({ timeout: 5000 });
	await expect(page.getByText("reply served by a fallback provider")).toBeVisible();
	await expect(page.getByText("reply from a pinned turn")).toBeVisible();

	// Two routed turns show the auto pill; the pinned turn shows none.
	const autoPill = page.getByTestId("auto-routed-pill");
	await expect(autoPill).toHaveCount(2);
	await expect(autoPill.first()).toBeVisible();
	await expect(autoPill.first()).toHaveText("auto");
	await expect(autoPill.first()).toHaveAttribute(
		"title",
		/the router served it with anthropic\/claude-sonnet-4-20250514/,
	);

	// Exactly one failover pill, on the fallback-served turn.
	const failoverPill = page.getByTestId("failover-pill");
	await expect(failoverPill).toHaveCount(1);
	await expect(failoverPill).toHaveText("failover");
	await expect(failoverPill).toHaveAttribute(
		"title",
		/served by openai\/gpt-4o/,
	);

	await captureEvidence(page, testInfo, "auto-model-routing");
});

test("selecting Auto in the picker sends the explicit null sentinel @evidence", async ({ page, mockApi }, testInfo) => {
	await installFakeEventSource(page);

	const proj = makeProject({ id: "p1" });
	const conv = makeConversation({ id: "B", projectId: "p1", title: "Fresh Auto Chat" });
	await mockApi({ projects: [proj], conversations: [conv], messages: [] });
	await page.route("**/api/conversations/*/active-run", (route) =>
		route.fulfill({ json: { runId: null, status: "none" } }),
	);

	// Capture the send POST — registered after mockApi so it takes
	// precedence over the fixture's generic handler.
	let sentBody: Record<string, unknown> | null = null;
	await page.route("**/api/conversations/B/messages", (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		sentBody = route.request().postDataJSON() as Record<string, unknown>;
		return route.fulfill({
			json: {
				userMessage: {
					id: "sent-1",
					conversationId: "B",
					role: "user",
					content: (sentBody?.content as string) ?? "sent",
					thinkingContent: null,
					model: null,
					provider: null,
					usage: null,
					runId: null,
					parentMessageId: null,
					excluded: false,
					createdAt: new Date().toISOString(),
				},
				runId: "run-auto-1",
				attachments: [],
				ezActionResults: [],
			},
		});
	});

	await page.goto(`/project/p1/chat/B`, { waitUntil: "networkidle" });

	// Open the picker and choose the dedicated Auto row.
	const selector = page.getByTestId("model-selector");
	await selector.getByRole("button").first().click();
	const autoRow = page.getByTestId("model-option-auto");
	await expect(autoRow).toBeVisible();
	await captureEvidence(page, testInfo, "auto-model-routing-picker");
	await autoRow.click();

	// The button label flips to the Auto label (no model auto-persisted over it).
	await expect(selector).toContainText("Auto (smart routing)");

	// Send a message — the wire body must carry the EXPLICIT nulls.
	const composer = page.getByPlaceholder("Send a message...");
	await composer.fill("route my first turn");
	await composer.press("Enter");

	await expect.poll(() => sentBody).not.toBeNull();
	expect(sentBody!.model).toBeNull();
	expect(sentBody!.provider).toBeNull();
	expect("model" in sentBody!).toBe(true);
	expect("provider" in sentBody!).toBe(true);
});
