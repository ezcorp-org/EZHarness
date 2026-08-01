import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * @evidence — WS7 "Retry with…" (the unbiased paired comparison).
 *
 * `POST /messages/:mid/retry` already forked a same-role assistant SIBLING off
 * one user turn, and already accepted a `provider`/`model` override. That makes
 * it a prompt-held-constant A/B: the single most informative routing signal the
 * product can produce. The only thing missing was a way for the user to choose
 * the other side of the comparison.
 *
 * The affordance is a caret beside the existing one-click "Retry" (which is
 * deliberately unchanged — "Current chat model" in the menu is that same
 * behaviour). The evidence shot shows the open menu over a two-sibling A/B
 * state; the assertions prove the picked model reaches the retry body and that
 * the model list is fetched only when the menu opens.
 */
test.describe("@evidence routing retry-with-model", () => {
	const proj = makeProject({ id: "proj-1", name: "Retry Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

	// u1 → { a1, a2 }: two siblings so the ‹1/2› switcher renders alongside the
	// A/B controls the caret lives in.
	const u1 = makeMessage({ id: "u1", conversationId: "conv-1", role: "user", content: "Draft a tagline", parentMessageId: null, createdAt: "2026-01-01T00:00:00.000Z" });
	const a1 = makeMessage({ id: "a1", conversationId: "conv-1", role: "assistant", content: "Option one", parentMessageId: "u1", createdAt: "2026-01-01T00:00:01.000Z" });
	const a2 = makeMessage({ id: "a2", conversationId: "conv-1", role: "assistant", content: "Option two", parentMessageId: "u1", createdAt: "2026-01-01T00:00:02.000Z" });

	const MODELS = [
		{ provider: "anthropic", model: "claude-opus-4-5", tier: "powerful", costTier: "high", available: true, displayName: "Opus 4.5" },
		{ provider: "anthropic", model: "claude-haiku-4-5", tier: "fast", costTier: "low", available: true, displayName: "Haiku 4.5" },
	];

	function treeRoute(page: import("@playwright/test").Page) {
		return page.route("**/api/conversations/*/tree", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ conversationId: "conv-1", currentLeaf: "a2", nodes: [] }),
			}),
		);
	}

	function modelsRoute(page: import("@playwright/test").Page, hits: { count: number }) {
		return page.route("**/api/models", (route) => {
			hits.count += 1;
			return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MODELS) });
		});
	}

	test("the caret opens a tier-grouped model menu beside Retry @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [u1, a1, a2] });
		await treeRoute(page);
		const hits = { count: 0 };
		await modelsRoute(page, hits);

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Option two")).toBeVisible();

		// Both affordances live in the A/B controls row: one-click Retry, plus the
		// caret that picks the other side of the comparison.
		await expect(page.getByTestId("ab-retry-btn").first()).toBeVisible();
		const caret = page.getByTestId("ab-retry-with-btn").first();
		await expect(caret).toBeVisible();
		await caret.click();

		const menu = page.getByTestId("ab-retry-model-menu");
		await expect(menu).toBeVisible();
		await expect(menu.getByTestId("ab-retry-model-current")).toBeVisible();
		await expect(menu.getByText("Opus 4.5")).toBeVisible();
		await expect(menu.getByText("Haiku 4.5")).toBeVisible();

		await captureEvidence(page, testInfo, "routing-retry-with-model");
	});

	test("picking a model sends it in the /retry body", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [u1, a1, a2] });
		await treeRoute(page);
		await modelsRoute(page, { count: 0 });

		let body: Record<string, unknown> | null = null;
		await page.route("**/api/conversations/*/messages/*/retry", (route) => {
			body = JSON.parse(route.request().postData() ?? "{}");
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ userMessage: u1, retriedMessageId: "a2", runId: "run-retry" }),
			});
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Option two")).toBeVisible();
		await page.getByTestId("ab-retry-with-btn").first().click();
		await page.getByTestId("ab-retry-model-menu").getByText("Opus 4.5").click();

		await expect.poll(() => body).not.toBeNull();
		expect(body).toMatchObject({ provider: "anthropic", model: "claude-opus-4-5" });
	});

	test("the model list is loaded on demand and then reused", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [u1, a1, a2] });
		await treeRoute(page);
		const hits = { count: 0 };
		await modelsRoute(page, hits);

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const caret = page.getByTestId("ab-retry-with-btn").first();
		await expect(caret).toBeVisible();
		// The composer's own model picker loads the catalog too, so this counts
		// only the DELTA the menu adds. (That the row itself fetches nothing on
		// mount — which is what keeps a long thread from firing one request per
		// assistant row — is asserted directly in
		// web/src/lib/components/ChatThread.abretry.component.test.ts.)
		const before = hits.count;

		await caret.click();
		await expect(page.getByTestId("ab-retry-model-menu")).toBeVisible();
		await expect.poll(() => hits.count).toBeGreaterThan(before);
		const afterFirstOpen = hits.count;

		// Reopening reuses the loaded list rather than refetching it. Closed via
		// Escape rather than a second caret click: while the menu is open the
		// click-outside backdrop covers the whole viewport (the same z-40 overlay
		// PermissionModeIndicator uses), so a real browser routes that click to
		// the backdrop, not the button.
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("ab-retry-model-menu")).toHaveCount(0);
		await caret.click();
		await expect(page.getByTestId("ab-retry-model-menu")).toBeVisible();
		expect(hits.count).toBe(afterFirstOpen);
	});

	test("the caret is hidden while a run is active, like Retry itself", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [u1, a1, a2] });
		await treeRoute(page);
		await page.route("**/api/conversations/*/active-run", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ runId: "run-live", status: "running", startedAt: new Date().toISOString() }),
			}),
		);

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Option two")).toBeVisible();
		await expect(page.getByTestId("ab-retry-with-btn")).toHaveCount(0);
	});
});
