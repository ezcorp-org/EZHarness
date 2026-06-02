import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Deletions that span a mention chip must actually delete.
 *
 * The composer edits a COMPACT display string in the textarea while the full
 * `![kind:name]` wire token lives off to the side. Every free-form edit is
 * projected back onto the wire via `applyDisplayEdit`. A previous build
 * rejected ANY edit whose range overlapped a chip — so highlight+delete,
 * Cmd/Ctrl+Delete and select-all silently restored the text whenever a chip
 * sat in the selection. The fix lets a window that *fully covers* a chip
 * splice the whole wire token out; only partial cuts into a chip's interior
 * are still rejected.
 *
 * Regression guard for that behavior.
 */

const proj = makeProject({ id: "proj-del", name: "Delete Project" });
const conv = makeConversation({ id: "conv-del", projectId: "proj-del", title: "Delete Chat" });

function baseMockOpts() {
	return {
		projects: [proj],
		conversations: [conv],
		messages: [makeMessage({ id: "m-del", conversationId: "conv-del", role: "user", content: "hi" })],
	};
}

test.describe("Composer deletions that span a mention chip", () => {
	test("select-all + delete clears a draft containing a chip", async ({ page, mockApi }) => {
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea.chat-textarea");
		await expect(textarea).toBeVisible({ timeout: 5000 });

		// Seed a committed wire token + surrounding prose.
		await textarea.fill("before ![agent:Code Assistant] after");
		await expect(textarea).toHaveValue(/!Code Assistant/);

		// The chip is painted before we delete.
		const overlay = page.locator(".chat-textarea-overlay");
		await expect(overlay.locator('[data-mention-kind="agent"]')).toBeVisible({ timeout: 5000 });

		// Highlight everything and delete — the chip is inside the selection.
		await textarea.focus();
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.press("Backspace");

		// Both the display string AND the wire token are gone (the bug left them
		// in place). The send button keys off the wire `value`, so its disabled
		// state proves the wire actually cleared, not just the display.
		await expect(textarea).toHaveValue("");
		await expect(overlay.locator('[data-mention-kind="agent"]')).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
	});

	test("highlight + delete of a range covering the chip removes the token", async ({ page, mockApi }) => {
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea.chat-textarea");
		await expect(textarea).toBeVisible({ timeout: 5000 });
		await textarea.fill("keep ![agent:Bob] tail");

		const overlay = page.locator(".chat-textarea-overlay");
		await expect(overlay.locator('[data-mention-kind="agent"]')).toBeVisible({ timeout: 5000 });

		// Select the display range covering the chip label + the space before
		// "tail" (from the "!" through the leading space of " tail") and delete.
		await textarea.focus();
		await textarea.evaluate((el: HTMLTextAreaElement) => {
			const v = el.value; // compact display, e.g. "keep !Bob     tail"
			const start = v.indexOf("!");
			const end = v.lastIndexOf(" tail") + 1; // include the joining space
			el.setSelectionRange(start, end);
		});
		await page.keyboard.press("Delete");

		// Chip gone; the surrounding text survives.
		await expect(overlay.locator('[data-mention-kind="agent"]')).toHaveCount(0);
		await expect(textarea).toHaveValue("keep tail");
	});
});
