import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage, makeAttachment } from "./fixtures/data.js";

/**
 * Clicking an image attachment card opens the shared lightbox store — the
 * same one MarkdownRenderer uses for inline images.
 */

const proj = makeProject({ id: "proj-1", name: "Lightbox" });
const conv = makeConversation({
	id: "conv-1",
	projectId: "proj-1",
	provider: "anthropic",
	model: "claude-sonnet-4-20250514",
});

test("clicking an image attachment card opens the lightbox", async ({ page, mockApi }) => {
	const att = makeAttachment({ id: "att-lb", filename: "cow.png", mimeType: "image/png", kind: "image" });
	const userMsg = makeMessage({
		id: "m1",
		conversationId: conv.id,
		role: "user",
		content: "image",
		attachments: [att],
	});

	await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg] });
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);

	const card = page.getByTestId("attachment-card-image").first();
	await expect(card).toBeVisible({ timeout: 10_000 });
	await card.click();

	// ImageLightbox renders a full-screen overlay when open — assert any
	// visible overlay with the attachment's src survives the click. The
	// lightbox swallows src via `lightbox.show(url, filename, null)`.
	const overlay = page.locator(`img[src="/api/attachments/${att.id}"]`);
	// Two images with the same src should now exist: the card's <img> and
	// the lightbox's. Count >= 2 confirms the overlay rendered.
	await expect(overlay).toHaveCount(2, { timeout: 5_000 });
});

test("Enter key on a focused image card opens the lightbox (keyboard a11y)", async ({ page, mockApi }) => {
	const att = makeAttachment({ id: "att-kb", filename: "cow.png", mimeType: "image/png", kind: "image" });
	const userMsg = makeMessage({
		id: "m1",
		conversationId: conv.id,
		role: "user",
		content: "image",
		attachments: [att],
	});

	await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg] });
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);

	const card = page.getByTestId("attachment-card-image").first();
	await expect(card).toBeVisible({ timeout: 10_000 });
	await card.focus();
	await page.keyboard.press("Enter");

	const overlay = page.locator(`img[src="/api/attachments/${att.id}"]`);
	await expect(overlay).toHaveCount(2, { timeout: 5_000 });
});
