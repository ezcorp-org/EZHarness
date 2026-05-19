/**
 * PHASE 7 — shared mobile tap-to-reveal for the per-message toolbar.
 *
 * Parity proof on the OTHER surface: the MAIN chat. The shared
 * MessageToolbar `variant='hover'` only fades in on `group-hover`,
 * which never fires on a coarse pointer. The Phase-7 fix adds a
 * tap-to-reveal affordance in the shared ChatMessage/MessageToolbar
 * (instance-local `toolbarRevealed` → `data-toolbar-revealed="true"` on
 * the `.group` row → `group-data-[toolbar-revealed=true]:opacity-100`
 * arbitrary variant). Because BOTH the main chat AND the agent sub-chat
 * panel render through the same ChatMessage/MessageToolbar, this single
 * shared change fixes both — `agent-panel-parity.spec.ts` proves the
 * panel surface; THIS spec proves the main-chat surface.
 *
 * Does NOT touch `main-chat-parity.spec.ts` (a frozen Phase-0 pin).
 * This is a NEW spec for NEW behaviour the app never had.
 *
 * Runs on `chromium` (desktop, fine pointer — hover still works) AND
 * `mobile-chromium` (Pixel 5 preset → `(hover: none)` → tap reveals).
 *
 * Interaction is driven via `dispatchEvent("click", …)` on the row's
 * `[data-message-id]` element — the SAME mechanism the sibling
 * `chat-long-press-select.spec.ts` uses. A real `.tap()`/`.click()`
 * fails its actionability check because the absolutely-positioned
 * `-bottom-3` MessageToolbar overlay sits over the row's hit point (a
 * documented Playwright hover-toolbar artefact, see
 * `agent-panel-parity.spec.ts`). `dispatchEvent` targets the row
 * directly and fires the exact `click` the production handler listens
 * for, so it exercises the real product path without the overlay /
 * splash interception noise.
 */

import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Mobile Reveal Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

const userMsg = makeMessage({
	id: "m1",
	conversationId: "conv-1",
	role: "user",
	content: "Question for the toolbar",
	parentMessageId: null,
});
const assistantMsg = makeMessage({
	id: "m2",
	conversationId: "conv-1",
	role: "assistant",
	content: "Answer that needs a reachable toolbar",
	parentMessageId: "m1",
	createdAt: "2026-01-01T00:01:00.000Z",
});

test.describe("Main-chat per-message toolbar — mobile tap-to-reveal (Phase 7)", () => {
	test("assistant turn toolbar is reachable: tap on coarse pointer, hover on desktop", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForLoadState("networkidle");

		await expect(
			page.getByText("Answer that needs a reachable toolbar"),
		).toBeVisible();

		const assistantRow = page.locator('[data-message-id="m2"]');
		const regenerate = page
			.getByRole("button", { name: "Regenerate response" })
			.first();

		if (testInfo.project.name === "mobile-chromium") {
			// Coarse pointer: group-hover never fires, so the toolbar is
			// transparent until a plain tap of the row flips
			// data-toolbar-revealed (production reads
			// matchMedia("(hover: none)") — true on the Pixel 5 preset).
			await assistantRow.dispatchEvent("click");
			await expect(assistantRow).toHaveAttribute(
				"data-toolbar-revealed",
				"true",
			);
			await expect(regenerate).toBeVisible({ timeout: 5000 });
			// Tapping again hides it (toggle).
			await assistantRow.dispatchEvent("click");
			await expect(assistantRow).not.toHaveAttribute(
				"data-toolbar-revealed",
				"true",
			);
		} else {
			// Desktop / fine pointer: hover path is UNCHANGED. A plain
			// click must NOT force-reveal (no data-toolbar-revealed), and
			// hover still surfaces the toolbar.
			await assistantRow.dispatchEvent("click");
			await expect(assistantRow).not.toHaveAttribute(
				"data-toolbar-revealed",
				"true",
			);
			await assistantRow.hover();
			await expect(regenerate).toBeVisible({ timeout: 5000 });
		}
	});

	test("tapping a toolbar button does not interfere; user-row toolbar also reachable", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForLoadState("networkidle");

		await expect(page.getByText("Question for the toolbar")).toBeVisible();
		const userRow = page.locator('[data-message-id="m1"]');

		if (testInfo.project.name === "mobile-chromium") {
			// User row reveals on tap (both row variants share the fix).
			await userRow.dispatchEvent("click");
			await expect(userRow).toHaveAttribute(
				"data-toolbar-revealed",
				"true",
			);
			const copyBtn = userRow
				.getByRole("button", { name: "Copy message" })
				.first();
			await expect(copyBtn).toBeVisible({ timeout: 5000 });
			// Dispatching the click on the Copy button (an interactive
			// descendant) must NOT toggle the reveal back off — the guard
			// reuses the same isInteractiveDescendant predicate as
			// long-press/select. The click bubbles to the row handler
			// whose `isInteractiveDescendant(e.target)` veto fires.
			await copyBtn.dispatchEvent("click");
			await expect(userRow).toHaveAttribute(
				"data-toolbar-revealed",
				"true",
			);
		} else {
			await userRow.dispatchEvent("click");
			await expect(userRow).not.toHaveAttribute(
				"data-toolbar-revealed",
				"true",
			);
			await userRow.hover();
			await expect(
				userRow.getByRole("button", { name: "Copy message" }).first(),
			).toBeVisible({ timeout: 5000 });
		}
	});
});
