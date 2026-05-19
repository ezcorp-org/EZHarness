import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

/**
 * End-to-end: user attaches → sends → the POST response's
 * `userMessage.attachments` is merged onto the optimistic bubble so the
 * image card appears in the history WITHOUT waiting for a full refetch.
 */

const proj = makeProject({ id: "proj-1", name: "Post Render" });
const conv = makeConversation({
	id: "conv-1",
	projectId: "proj-1",
	provider: "anthropic",
	model: "claude-sonnet-4-20250514",
});

const PNG_1x1 = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

test("uploaded image appears in chat history after send without a reload", async ({ page, mockApi }) => {
	await page.addInitScript(() => {
		class FakeEventSource {
			onopen: ((e: Event) => void) | null = null;
			readyState = 1;
			url: string;
			constructor(url: string) {
				this.url = url;
				queueMicrotask(() => this.onopen?.(new Event("open")));
			}
			close() {}
			addEventListener() {}
			removeEventListener() {}
		}
		(window as any).EventSource = FakeEventSource;
	});

	await mockApi({ projects: [proj], conversations: [conv] });
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await page.waitForLoadState("networkidle");
	await expect(page.locator("textarea").first()).toBeEnabled({ timeout: 10_000 });

	const fileInput = page.getByTestId("attachment-file-input");
	await fileInput.setInputFiles({ name: "cat.png", mimeType: "image/png", buffer: PNG_1x1 });
	await page.locator("textarea").first().fill("look");
	await page.getByRole("button", { name: "Send message" }).click();

	// The optimistic merge path: POST returns AttachmentSummary with id
	// `att-sent-1` (see api-mocks.ts). ChatMessage renders it above (or
	// below, per recent layout change) the text.
	const card = page.getByTestId("attachment-card-image").first();
	await expect(card).toBeVisible({ timeout: 10_000 });
	const img = card.locator("img");
	await expect(img).toHaveAttribute("src", "/api/attachments/att-sent-1");
});
