/**
 * IME composition vs. Enter-to-send.
 *
 * Japanese, Chinese and Korean input methods use Enter to confirm a
 * candidate. That keydown carries `isComposing` (Chrome, Firefox) or
 * keyCode 229 (Safari, after compositionend). Before the fix every
 * Enter-to-submit field sent the half-composed text. RENDER tier (mockApi).
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeConversation, makeProject } from "./fixtures/data.js";
import { threadMessages } from "./fixtures/composer.js";

const proj = makeProject({ id: "proj-1", name: "IME Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
const TEXT = "こんにちは世界";

test.describe("IME Enter does not send", () => {
	test("main composer keeps the draft on an IME Enter and sends on a plain Enter @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		const sendBtn = page.getByRole("button", { name: "Send message" });
		await expect(sendBtn).toHaveAttribute("title", "Send message", { timeout: 20_000 });
		const textarea = page.locator("textarea.chat-textarea");
		await textarea.fill(TEXT);

		await textarea.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
		await textarea.dispatchEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true });

		await expect(textarea).toHaveValue(TEXT);
		await expect(threadMessages(page).getByText(TEXT)).toHaveCount(0);
		await captureEvidence(page, testInfo, "ime-enter-keeps-draft");

		await textarea.press("Enter");
		await expect(threadMessages(page).getByText(TEXT)).toBeVisible();
		await expect(textarea).toHaveValue("");
	});

	test("Ez panel composer keeps the draft on an IME Enter @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj], ezConversation: { conversationId: "ez-conv-1" } });
		await page.goto(`/project/${proj.id}/chat`);
		await page.getByTestId("ez-button").click();
		const panel = page.getByTestId("ez-panel");
		await expect(panel).toBeVisible();
		const textarea = panel.getByPlaceholder(/Ask Ez to do something/);
		await expect(panel.getByRole("button", { name: "Send message" })).toHaveAttribute("title", "Send message", { timeout: 20_000 });
		await textarea.fill(TEXT);

		await textarea.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });

		await expect(textarea).toHaveValue(TEXT);
		await expect(panel.getByTestId("ez-message")).toHaveCount(0);
		await captureEvidence(page, testInfo, "ime-enter-ez-panel");
	});
});
