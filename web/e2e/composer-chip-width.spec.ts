import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Composer mention chips must hug their visible label — no large blank gap to
 * the right of the chip (and no caret floating out past it).
 *
 * The composer paints pretty chips in an overlay mirrored over a transparent
 * textarea. The textarea is bound to a COMPACT display string (`!Code
 * Assistant`) while the full `![kind:name]` wire token is kept off to the side
 * for submission. Because the textarea now lays out the compact label, the
 * caret / following text sit flush against the chip instead of being pushed
 * out by the hidden `[kind:` … `]` characters.
 *
 * Regression guard: a previous build laid out the raw wire token in the
 * textarea, so the reserved width was far wider than the chip and a ~46px gap
 * opened to the right of every `!`/`/`/`$` mention.
 */

const proj = makeProject({ id: "proj-chip", name: "Chip Project" });
const conv = makeConversation({ id: "conv-chip", projectId: "proj-chip", title: "Chip Chat" });

function baseMockOpts() {
	return {
		projects: [proj],
		conversations: [conv],
		messages: [makeMessage({ id: "m-chip", conversationId: "conv-chip", role: "user", content: "hi" })],
	};
}

test.describe("Composer mention chips lay out compact (no whitespace gap)", () => {
	test("textarea lays out the COMPACT label, not the raw wire token", async ({ page, mockApi }) => {
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea.chat-textarea");
		await expect(textarea).toBeVisible({ timeout: 5000 });

		// Seed a committed wire token + trailing prose by typing the wire form;
		// the composer projects it to the compact display the textarea renders.
		await textarea.fill("![agent:Code Assistant] after");

		// The textarea (what actually gets laid out / where the caret travels)
		// shows the compact label — proving the gap-causing raw token is gone.
		await expect(textarea).toHaveValue(/^!Code Assistant\s+after$/);

		// The chip is still painted in the overlay.
		const overlay = page.locator(".chat-textarea-overlay");
		const pill = overlay.locator('[data-mention-kind="agent"]');
		await expect(pill).toBeVisible({ timeout: 5000 });
		await expect(pill).toContainText("!Code Assistant");
	});

	test("the chip width matches its compact reservation (chip is not ballooned/gapped)", async ({
		page,
		mockApi,
	}) => {
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea.chat-textarea");
		await expect(textarea).toBeVisible({ timeout: 5000 });
		await textarea.fill("/[cmd:deploy-production] go");

		const overlay = page.locator(".chat-textarea-overlay");
		const pill = overlay.locator('[data-mention-kind="command"]');
		const reserved = overlay.locator("span.invisible").first();
		// boundingBox() auto-waits for the elements, avoiding a race with the
		// reproject re-render that a raw querySelector snapshot can hit.
		await expect(pill).toBeVisible({ timeout: 5000 });
		await expect(reserved).toBeAttached({ timeout: 5000 });
		const pillBox = await pill.boundingBox();
		const reservedBox = await reserved.boundingBox();

		// The reservation now equals the compact label width, so the chip
		// (label + a little padding) sits right on top of it — they are within a
		// chip-padding's worth of each other, NOT ~46px apart as before.
		expect(Math.abs(pillBox!.width - reservedBox!.width)).toBeLessThan(24);
	});
});
