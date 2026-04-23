import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage, makeAttachment } from "./fixtures/data.js";

/**
 * Verifies that attachments persisted on a user message render as cards in
 * the chat history — images as <img> via /api/attachments/:id, other kinds
 * as a download card.
 */

const proj = makeProject({ id: "proj-1", name: "History Render" });
const conv = makeConversation({
	id: "conv-1",
	projectId: "proj-1",
	provider: "anthropic",
	model: "claude-sonnet-4-20250514",
});

test("image attachment on a past user message renders inline as an <img>", async ({ page, mockApi }) => {
	const attachment = makeAttachment({
		id: "att-1",
		filename: "cow.png",
		mimeType: "image/png",
		kind: "image",
		sizeBytes: 42,
	});
	const userMsg = makeMessage({
		id: "m1",
		conversationId: conv.id,
		role: "user",
		content: "use this",
		attachments: [attachment],
	});
	const assistantMsg = makeMessage({
		id: "m2",
		conversationId: conv.id,
		role: "assistant",
		content: "ok",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);

	const card = page.getByTestId("attachment-card-image").first();
	await expect(card).toBeVisible({ timeout: 10_000 });
	const img = card.locator("img");
	await expect(img).toHaveAttribute("src", `/api/attachments/${attachment.id}`);
	await expect(img).toHaveAttribute("alt", attachment.filename);
	await expect(img).toHaveAttribute("loading", "lazy");
});

test("non-image attachment renders as a file card with download link", async ({ page, mockApi }) => {
	const attachment = makeAttachment({
		id: "att-2",
		filename: "notes.txt",
		mimeType: "text/plain",
		kind: "text",
		sizeBytes: 2048,
	});
	const userMsg = makeMessage({
		id: "m1",
		conversationId: conv.id,
		role: "user",
		content: "doc",
		attachments: [attachment],
	});

	await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg] });
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);

	const card = page.getByTestId("attachment-card-file").first();
	await expect(card).toBeVisible({ timeout: 10_000 });
	await expect(card).toContainText(attachment.filename);
	// Pretty-bytes: 2048 → "2.0 KB".
	await expect(card).toContainText("2.0 KB");

	const download = card.getByTestId("attachment-download");
	await expect(download).toHaveAttribute("href", `/api/attachments/${attachment.id}?download=1`);
	await expect(download).toHaveAttribute("download", attachment.filename);
});

test("broken image URL falls back from image card to file card", async ({ page, mockApi }) => {
	const attachment = makeAttachment({
		id: "att-broken",
		filename: "missing.png",
		mimeType: "image/png",
		kind: "image",
	});
	const userMsg = makeMessage({
		id: "m1",
		conversationId: conv.id,
		role: "user",
		content: "oops",
		attachments: [attachment],
	});

	// Serve a 404 for THIS attachment only so the <img> onerror fires. The
	// rest of the attachment route falls through to the mock's 1×1 PNG.
	await page.route(`**/api/attachments/${attachment.id}`, (route) =>
		route.fulfill({ status: 404, body: "not found" }),
	);
	await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg] });
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);

	// The image card swaps to the file card when onerror fires.
	const fileCard = page.getByTestId("attachment-card-file").first();
	await expect(fileCard).toBeVisible({ timeout: 10_000 });
	await expect(fileCard).toContainText("missing.png");
});

test("attachment card renders BELOW the message text (layout preference)", async ({ page, mockApi }) => {
	const attachment = makeAttachment({
		id: "att-order",
		filename: "cow.png",
		mimeType: "image/png",
		kind: "image",
	});
	const userMsg = makeMessage({
		id: "m1",
		conversationId: conv.id,
		role: "user",
		content: "here is the image",
		attachments: [attachment],
	});
	await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg] });
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);

	const text = page.locator("p", { hasText: "here is the image" }).first();
	const card = page.getByTestId("attachment-card-image").first();
	await expect(text).toBeVisible({ timeout: 10_000 });
	await expect(card).toBeVisible();

	const textBox = await text.boundingBox();
	const cardBox = await card.boundingBox();
	expect(textBox).not.toBeNull();
	expect(cardBox).not.toBeNull();
	// Card's top edge is below the text's bottom edge.
	expect(cardBox!.y).toBeGreaterThanOrEqual(textBox!.y + textBox!.height - 1);
});

test("multiple attachments render as separate cards on the same message", async ({ page, mockApi }) => {
	const atts = [
		makeAttachment({ id: "att-a", filename: "a.png", mimeType: "image/png", kind: "image" }),
		makeAttachment({ id: "att-b", filename: "b.png", mimeType: "image/png", kind: "image" }),
		makeAttachment({ id: "att-c", filename: "notes.txt", mimeType: "text/plain", kind: "text" }),
	];
	const userMsg = makeMessage({
		id: "m1",
		conversationId: conv.id,
		role: "user",
		content: "three items",
		attachments: atts,
	});

	await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg] });
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);

	await expect(page.getByTestId("attachment-card-image")).toHaveCount(2);
	await expect(page.getByTestId("attachment-card-file")).toHaveCount(1);
});
