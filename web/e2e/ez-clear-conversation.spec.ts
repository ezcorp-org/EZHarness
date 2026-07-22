// re-evidence 2026-07-22: a covered surface changed in feat/hub-project-pages
// (per-project hub pages + ECF control plane); this touch triggers the visual
// evidence pipeline to re-capture this spec's screenshots for PR review.
/**
 * Ez panel — "Clear conversation" inline two-step confirm.
 *
 * REGRESSION: the clear button used native `window.confirm()`. Browsers
 * silently suppress repeated page dialogs (the "Don't allow this page to
 * prompt you again" state) and some embedded/webview contexts block them
 * outright — in those cases `confirm()` returns `false` with no visible
 * prompt, so clicking Clear did LITERALLY NOTHING. The fix replaces the
 * native dialog with a dialog-free inline two-step confirm (arm → confirm),
 * which is what this spec pins end-to-end:
 *
 *   1. First click ARMS — the button morphs to a red "Confirm?" affordance
 *      and NOTHING is deleted (messages remain).
 *   2. Second click CONFIRMS — DELETE /api/ez/conversation/messages fires
 *      and the panel drops to its empty state.
 *   3. NO native dialog is ever raised (a `page.on("dialog")` trap would
 *      catch a regression back to `window.confirm`).
 *
 * Frontend-visual change (web/src/lib/components/ez/EzPanel.svelte) →
 * `@evidence`-tagged so the Visual evidence gate captures the armed state
 * and the post-clear empty state.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeMessage } from "./fixtures/data.js";

test.describe("Ez panel — clear conversation", () => {
	const proj = makeProject({ id: "proj-1" });

	const seed = {
		projects: [proj],
		ezConversation: { conversationId: "ez-conv-1" },
		ezMessages: [
			makeMessage({ id: "ez-u1", role: "user", content: "hi Ez" }),
			makeMessage({
				id: "ez-a1",
				role: "assistant",
				content: "Hello! How can I help?",
				parentMessageId: "ez-u1",
				createdAt: "2026-04-01T00:01:00.000Z",
			}),
		],
	};

	test("two-step inline confirm clears the conversation without any native dialog @evidence", async ({ page, mockApi }, testInfo) => {
		// Trap ANY native dialog — a regression back to window.confirm would
		// trip this and fail the test (also proving the "does nothing when
		// the browser suppresses dialogs" footgun is gone).
		let dialogSeen = false;
		page.on("dialog", (d) => {
			dialogSeen = true;
			void d.dismiss();
		});

		// Observe the clear DELETE so we can assert it fired only on confirm.
		const deleteRequests: string[] = [];
		page.on("request", (r) => {
			if (r.method() === "DELETE" && r.url().includes("/api/ez/conversation/messages")) {
				deleteRequests.push(r.url());
			}
		});

		await mockApi(seed);
		await page.goto(`/project/${proj.id}/chat`);

		await page.locator('[data-testid="ez-button"]:visible').click();
		const panel = page.getByTestId("ez-panel");
		await expect(panel).toBeVisible();
		await expect(page.getByTestId("ez-message")).toHaveCount(2);

		const clearBtn = page.getByTestId("ez-panel-clear");
		await expect(clearBtn).toHaveAttribute("data-confirming", "false");
		await expect(clearBtn).toHaveAttribute("aria-label", "Clear conversation");

		// First click ARMS — button morphs to "Confirm?", nothing deleted.
		await clearBtn.click();
		await expect(clearBtn).toHaveAttribute("data-confirming", "true");
		await expect(clearBtn).toHaveAttribute("aria-label", "Confirm clear conversation");
		await expect(clearBtn).toContainText("Confirm?");
		await expect(page.getByTestId("ez-message")).toHaveCount(2);
		expect(deleteRequests).toHaveLength(0);

		// Evidence: the armed destructive-confirm state.
		await captureEvidence(page, testInfo, "ez-clear-armed");

		// Second click CONFIRMS — DELETE fires, panel drops to empty state.
		await Promise.all([
			page.waitForRequest((r) => r.method() === "DELETE" && r.url().includes("/api/ez/conversation/messages")),
			clearBtn.click(),
		]);
		await expect(page.getByTestId("ez-message")).toHaveCount(0);
		await expect(page.getByTestId("ez-panel-empty")).toBeVisible();
		await expect(clearBtn).toHaveAttribute("data-confirming", "false");
		expect(deleteRequests).toHaveLength(1);

		// The whole point of the fix: the destructive action never used a
		// native dialog.
		expect(dialogSeen).toBe(false);

		// Evidence: the post-clear empty state.
		await captureEvidence(page, testInfo, "ez-clear-empty");
	});

	test("the Ez composer renders the locked mode chip (disabled ModeSelector labelled 'Ez') @evidence", async ({ page, mockApi }, testInfo) => {
		// Pins ChatInput's locked-mode path: EzPanel passes
		// lockedMode={modeSlug:'ez'} and ChatInput synthesizes a full
		// Mode-shaped object (id/slug/extensionTools/…) to drive a REAL but
		// disabled <ModeSelector> chip — this renders that synthesized object.
		await mockApi(seed);
		await page.goto(`/project/${proj.id}/chat`);

		await page.locator('[data-testid="ez-button"]:visible').click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();

		const locked = page.getByTestId("chat-input-locked-mode");
		await expect(locked).toBeVisible();
		await expect(locked.getByTestId("mode-selector")).toContainText("Ez");
		// The chip is a real ModeSelector, rendered locked (disabled trigger).
		await expect(locked.getByTestId("mode-selector").locator("button").first()).toBeDisabled();

		await captureEvidence(page, testInfo, "ez-locked-mode-chip");
	});

	test("a single click only arms — it does not delete the conversation", async ({ page, mockApi }) => {
		const deleteRequests: string[] = [];
		page.on("request", (r) => {
			if (r.method() === "DELETE" && r.url().includes("/api/ez/conversation/messages")) {
				deleteRequests.push(r.url());
			}
		});

		await mockApi(seed);
		await page.goto(`/project/${proj.id}/chat`);

		await page.locator('[data-testid="ez-button"]:visible').click();
		await expect(page.getByTestId("ez-panel")).toBeVisible();
		await expect(page.getByTestId("ez-message")).toHaveCount(2);

		await page.getByTestId("ez-panel-clear").click();
		await expect(page.getByTestId("ez-panel-clear")).toHaveAttribute("data-confirming", "true");

		// Messages are untouched after a single (arming) click, and no
		// DELETE has been sent.
		await expect(page.getByTestId("ez-message")).toHaveCount(2);
		expect(deleteRequests).toHaveLength(0);
	});
});
