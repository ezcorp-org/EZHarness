import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * iOS Safari auto-zooms when a focused form control's computed font-size is
 * below 16px. The fix bumps `input`/`textarea`/`select` to 16px under
 * `(pointer: coarse)`, plus an explicit override for the chat composer's
 * scoped `.chat-textarea` (and its mirror `.chat-textarea-overlay`).
 *
 * Chromium reports `(pointer: coarse)` when the context is created with
 * `hasTouch: true` + `isMobile: true`. We assert font-size >= 16 on the
 * touch context and confirm it is the smaller designed size on desktop —
 * that pair proves the fix is keyed on the media query, not applied always.
 */

const mobile = { width: 375, height: 812 };
const desktop = { width: 1280, height: 800 };

const proj = makeProject({ id: "proj-zoom", name: "Zoom Project" });
const conv = makeConversation({ id: "conv-zoom", projectId: "proj-zoom", title: "Zoom Chat" });
const userMsg = makeMessage({
	id: "msg-z1",
	conversationId: "conv-zoom",
	role: "user",
	content: "hello",
});

function baseMockOpts() {
	return {
		projects: [proj],
		conversations: [conv],
		messages: [userMsg],
	};
}

async function fontSizeOf(locator: ReturnType<import("@playwright/test").Page["locator"]>) {
	return locator.evaluate((el: HTMLElement) =>
		parseFloat(getComputedStyle(el).fontSize),
	);
}

test.describe("Mobile input zoom — touch viewport", () => {
	test.use({ viewport: mobile, hasTouch: true, isMobile: true });

	test("chat textarea font-size is >= 16px to suppress iOS focus-zoom", async ({
		page,
		mockApi,
	}) => {
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea.chat-textarea");
		await expect(textarea).toBeVisible({ timeout: 5000 });

		// Sanity: the test environment must actually report coarse pointer,
		// otherwise the @media block we are testing wouldn't apply and the
		// test would silently pass for the wrong reason.
		const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
		expect(coarse).toBe(true);

		expect(await fontSizeOf(textarea)).toBeGreaterThanOrEqual(16);
	});

	test("chat overlay (chip mirror) font-size matches the textarea", async ({
		page,
		mockApi,
	}) => {
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea.chat-textarea");
		const overlay = page.locator(".chat-textarea-overlay");
		await expect(textarea).toBeVisible({ timeout: 5000 });
		await expect(overlay).toBeAttached();

		// Chips position on top of typed text, so any drift between the
		// textarea and its mirror overlay misaligns mention pills.
		expect(await fontSizeOf(textarea)).toBe(await fontSizeOf(overlay));
	});
});

test.describe("Mobile input zoom — desktop viewport (no touch)", () => {
	test.use({ viewport: desktop, hasTouch: false, isMobile: false });

	test("chat textarea keeps designed 14px size on fine-pointer devices", async ({
		page,
		mockApi,
	}) => {
		await mockApi(baseMockOpts());
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea.chat-textarea");
		await expect(textarea).toBeVisible({ timeout: 5000 });

		const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
		expect(coarse).toBe(false);

		// 0.875rem at the default 16px root = 14px. Asserting the smaller
		// size confirms the @media override is correctly scoped, not global.
		expect(await fontSizeOf(textarea)).toBeLessThan(16);
	});
});
