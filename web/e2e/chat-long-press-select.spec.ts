/**
 * E2E coverage for the mobile long-press → chat-turn-select bug.
 *
 * The chat row supports keyboard + click + shift+click to enter select
 * mode (covered in chat-select-mode.spec.ts and chat-multi-select.spec.ts).
 * On touch devices there's no shift key, so we wire `use:longPress` onto
 * the row — a 500ms touch-hold synthesizes a shiftKey:true click that
 * runs through the same `toggleSelectedMessage` handler. This spec proves:
 *
 *   1. A long-press outside select mode auto-enters and selects the row.
 *   2. A second long-press range-extends from the anchor.
 *   3. A long-press whose target is a markdown <a> inside the row is
 *      vetoed (link still navigates / row does NOT enter select mode).
 *   4. A short tap (< 500ms) outside select mode does NOT enter it.
 *
 * `dispatchEvent` is used instead of `page.touchscreen` because Playwright's
 * touchscreen API doesn't expose press-and-hold timing — and the longPress
 * action listens on Pointer events (which Playwright dispatches faithfully
 * via `dispatchEvent("pointerdown", { pointerType: "touch" })`).
 */

import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Chat row long-press → select mode (mobile)", () => {
	test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

	const proj = makeProject({ id: "proj-lp-1", name: "Long-Press Project" });
	const conv = makeConversation({ id: "conv-lp-1", projectId: "proj-lp-1", title: "Main" });

	function seedTurns() {
		return [
			makeMessage({
				id: "msg-lp-1",
				conversationId: "conv-lp-1",
				role: "user",
				content: "First user question",
				createdAt: "2026-04-01T00:00:00.000Z",
			}),
			makeMessage({
				id: "msg-lp-2",
				conversationId: "conv-lp-1",
				role: "assistant",
				content: "First assistant answer",
				parentMessageId: "msg-lp-1",
				createdAt: "2026-04-01T00:01:00.000Z",
			}),
			makeMessage({
				id: "msg-lp-3",
				conversationId: "conv-lp-1",
				role: "user",
				content: "Second user question",
				parentMessageId: "msg-lp-2",
				createdAt: "2026-04-01T00:02:00.000Z",
			}),
			makeMessage({
				id: "msg-lp-4",
				conversationId: "conv-lp-1",
				role: "assistant",
				// Markdown link is intentional — used by the descendant-veto
				// test below to confirm long-press on a link does NOT enter
				// select mode.
				content: "Check out [the docs](https://example.com/docs)",
				parentMessageId: "msg-lp-3",
				createdAt: "2026-04-01T00:03:00.000Z",
			}),
		];
	}

	/**
	 * Synthesize a touch hold by dispatching a `pointerdown` (pointerType:
	 * touch), waiting past the longPress delay (500ms default + safety
	 * buffer), then `pointerup`. The action's setTimeout is real, so we
	 * have to actually wait — vitest fake timers aren't available in e2e.
	 */
	async function longPressTouch(locator: ReturnType<typeof Object>): Promise<void> {
		// `locator` is a Playwright Locator — typed loosely to keep the
		// helper concise. dispatchEvent throws if the element isn't in the
		// DOM, so callers should ensure the row is rendered first.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const loc = locator as any;
		await loc.dispatchEvent("pointerdown", { pointerType: "touch", clientX: 10, clientY: 10 });
		// 500ms default delay + 200ms buffer. Action's timer fires inside
		// this window; subsequent pointerup is a no-op for the gesture but
		// keeps the DOM state clean.
		await loc.page().waitForTimeout(700);
		await loc.dispatchEvent("pointerup", { pointerType: "touch", clientX: 10, clientY: 10 });
	}

	test("long-press on a turn auto-enters select mode and selects that turn", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("First user question")).toBeVisible();

		// Action bar is NOT visible — user has not entered select mode.
		await expect(page.getByTestId("select-action-bar")).toHaveCount(0);

		const row = page.locator('[data-message-id="msg-lp-1"]');
		await longPressTouch(row);

		// Auto-entered select mode: action bar is visible, count is 1.
		await expect(page.getByTestId("select-action-bar")).toBeVisible();
		await expect(page.getByTestId("selected-count")).toHaveText("1");
		// The pressed turn is the one selected.
		await expect(page.getByTestId("select-checkbox-msg-lp-1")).toBeVisible();
	});

	test("second long-press range-extends from the anchor", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("First user question")).toBeVisible();

		// First long-press → anchor at msg-lp-1, count = 1.
		await longPressTouch(page.locator('[data-message-id="msg-lp-1"]'));
		await expect(page.getByTestId("selected-count")).toHaveText("1");

		// Second long-press on msg-lp-3 → range extends across msgs 1, 2, 3.
		await longPressTouch(page.locator('[data-message-id="msg-lp-3"]'));
		await expect(page.getByTestId("selected-count")).toHaveText("3");
	});

	test("long-press on a markdown <a> inside a turn does NOT enter select mode", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("the docs")).toBeVisible();

		// The <a> renders inside msg-lp-4. Press-and-hold the link itself,
		// not the row body — the longPress action's `shouldFire` predicate
		// vetoes when the target is an interactive descendant.
		const link = page.locator('[data-message-id="msg-lp-4"] a[href*="example.com"]');
		await expect(link).toBeVisible();
		await longPressTouch(link);

		await expect(page.getByTestId("select-action-bar")).toHaveCount(0);
	});

	test("a short press (<500ms) does NOT enter select mode", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("First user question")).toBeVisible();

		const row = page.locator('[data-message-id="msg-lp-1"]');
		await row.dispatchEvent("pointerdown", { pointerType: "touch", clientX: 10, clientY: 10 });
		await page.waitForTimeout(150);
		await row.dispatchEvent("pointerup", { pointerType: "touch", clientX: 10, clientY: 10 });

		// Stay an extra 500ms past the longPress delay to give a chance for
		// any stray timer to fire — it shouldn't.
		await page.waitForTimeout(500);
		await expect(page.getByTestId("select-action-bar")).toHaveCount(0);
	});
});
