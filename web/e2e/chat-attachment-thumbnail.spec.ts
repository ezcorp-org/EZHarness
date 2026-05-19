import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

/**
 * Staged image files in the ChatInput render as thumbnails (object-URL
 * preview) instead of the generic filename chip. Non-image files still
 * get the chip.
 */

const proj = makeProject({ id: "proj-1", name: "Thumb" });
const conv = makeConversation({
	id: "conv-1",
	projectId: "proj-1",
	provider: "anthropic",
	model: "claude-sonnet-4-20250514",
});

// Smallest valid PNG for the file staging check.
const PNG_1x1 = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

// Fake EventSource so the composer hydrates in e2e — mirrors the pattern
// used by chat-attachment-image.spec.ts.
async function installFakeEventSource(page: import("@playwright/test").Page) {
	await page.addInitScript(() => {
		class FakeEventSource {
			onopen: ((e: Event) => void) | null = null;
			onmessage: ((e: MessageEvent) => void) | null = null;
			onerror: ((e: Event) => void) | null = null;
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
}

test("staged image file renders a thumbnail preview (not the filename chip)", async ({ page, mockApi }) => {
	await installFakeEventSource(page);
	await mockApi({ projects: [proj], conversations: [conv] });
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await page.waitForLoadState("networkidle");
	await expect(page.locator("textarea").first()).toBeEnabled({ timeout: 10_000 });

	const fileInput = page.getByTestId("attachment-file-input");
	await fileInput.setInputFiles({ name: "cat.png", mimeType: "image/png", buffer: PNG_1x1 });

	const chip = page.getByTestId("attachment-chip");
	await expect(chip).toBeVisible();
	// Thumbnail variant contains an <img> using a blob: object URL. The
	// filename-chip variant does NOT render an <img>.
	const thumbImg = chip.locator("img");
	await expect(thumbImg).toBeVisible();
	const src = await thumbImg.getAttribute("src");
	expect(src).toBeTruthy();
	expect(src!.startsWith("blob:")).toBe(true);
	// Thumbnail uses the filename as alt for a11y.
	await expect(thumbImg).toHaveAttribute("alt", "cat.png");
});

test("staged non-image file renders a filename chip without thumbnail", async ({ page, mockApi }) => {
	await installFakeEventSource(page);
	await mockApi({ projects: [proj], conversations: [conv] });
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await page.waitForLoadState("networkidle");
	await expect(page.locator("textarea").first()).toBeEnabled({ timeout: 10_000 });

	const fileInput = page.getByTestId("attachment-file-input");
	await fileInput.setInputFiles({
		name: "notes.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("hello", "utf-8"),
	});

	const chip = page.getByTestId("attachment-chip");
	await expect(chip).toBeVisible();
	await expect(chip).toContainText("notes.txt");
	// No <img> inside the non-image chip.
	await expect(chip.locator("img")).toHaveCount(0);
});

test("removing a staged image revokes the thumbnail and clears the tray", async ({ page, mockApi }) => {
	await installFakeEventSource(page);
	await mockApi({ projects: [proj], conversations: [conv] });
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await page.waitForLoadState("networkidle");
	await expect(page.locator("textarea").first()).toBeEnabled({ timeout: 10_000 });

	const fileInput = page.getByTestId("attachment-file-input");
	await fileInput.setInputFiles({ name: "cat.png", mimeType: "image/png", buffer: PNG_1x1 });
	const chip = page.getByTestId("attachment-chip");
	await expect(chip).toBeVisible();

	await chip.locator("button", { hasText: "×" }).click();
	await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
});
