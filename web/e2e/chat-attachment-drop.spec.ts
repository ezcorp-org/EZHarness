import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });
const conv = makeConversation({
	id: "conv-1",
	projectId: "proj-1",
	title: "Drop Chat",
	provider: "anthropic",
	model: "claude-sonnet-4-20250514",
});

// 1×1 transparent PNG. Same byte sequence the paperclip E2E uses so both
// tests exercise the identical downstream path (stageFiles → multipart POST).
const PNG_1x1 = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

async function stubEventSource(page: import("@playwright/test").Page) {
	// Same no-op EventSource shim the paperclip E2E uses — without it the
	// connection stays "reconnecting" under the mock server and the textarea
	// never enables. Must be installed before navigation.
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

/**
 * Drives a drag-drop of one file onto the given selector. Playwright's
 * built-in dragAndDrop can't attach a `File` to the DataTransfer, so we
 * build the DataTransfer in page context and dispatch real DragEvents.
 */
async function dropFileOn(
	page: import("@playwright/test").Page,
	selector: string,
	file: { name: string; type: string; bytes: number[] },
) {
	const handle = await page.evaluateHandle(
		({ sel, f }) => {
			const el = document.querySelector(sel);
			if (!el) throw new Error(`drop target not found: ${sel}`);
			const dt = new DataTransfer();
			const buf = new Uint8Array(f.bytes);
			dt.items.add(new File([buf], f.name, { type: f.type }));
			el.dispatchEvent(
				new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }),
			);
			el.dispatchEvent(
				new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }),
			);
			return true;
		},
		{ sel: selector, f: { name: file.name, type: file.type, bytes: Array.from(file.bytes) } },
	);
	await handle.dispose();
}

test("dropping a PNG anywhere in the chat window stages it and sends multipart", async ({
	page,
	mockApi,
}) => {
	await stubEventSource(page);
	await mockApi({ projects: [proj], conversations: [conv] });
	await page.goto("/project/proj-1/chat/conv-1");
	await page.waitForLoadState("networkidle");

	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeEnabled({ timeout: 10_000 });
	// Capabilities must have loaded (stageFiles is a no-op without them).
	await expect(page.getByTestId("attachment-button")).toBeVisible({ timeout: 5_000 });

	// Drop the PNG onto the chat column — outside the composer's input box —
	// to prove the outer drop zone, not just the inner one, stages files.
	await dropFileOn(page, "[data-testid='chat-column']", {
		name: "dropped.png",
		type: "image/png",
		bytes: Array.from(PNG_1x1),
	});

	const chip = page.getByTestId("attachment-chip");
	await expect(chip).toBeVisible();
	// Image chips render the filename in `title` + the inner <img alt>, not as
	// text content (the visible text is just the remove-button glyph).
	await expect(chip).toHaveAttribute("title", "dropped.png");

	await textarea.fill("dropped this in");

	const sendRequest = page.waitForRequest(
		(req) => req.method() === "POST" && /\/api\/conversations\/[^/]+\/messages$/.test(req.url()),
		{ timeout: 5_000 },
	);
	await page.getByRole("button", { name: "Send message" }).click();
	const req = await sendRequest;
	expect((req.headers()["content-type"] ?? "").startsWith("multipart/form-data")).toBe(true);
	const raw = req.postDataBuffer()?.toString("binary") ?? "";
	expect(raw).toContain("dropped.png");

	await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
});

test("dropping a file directly on the composer still stages once (no double-stage from bubbling)", async ({
	page,
	mockApi,
}) => {
	await stubEventSource(page);
	await mockApi({ projects: [proj], conversations: [conv] });
	await page.goto("/project/proj-1/chat/conv-1");
	await page.waitForLoadState("networkidle");
	await expect(page.locator("textarea").first()).toBeEnabled({ timeout: 10_000 });
	await expect(page.getByTestId("attachment-button")).toBeVisible({ timeout: 5_000 });

	// The inner `.chat-input-box` handler must stopPropagation so the outer
	// chat-column handler doesn't run the file through stageFiles a second
	// time — otherwise one dropped file would produce two chips.
	await dropFileOn(page, ".chat-input-box", {
		name: "nested.png",
		type: "image/png",
		bytes: Array.from(PNG_1x1),
	});

	await expect(page.getByTestId("attachment-chip")).toHaveCount(1);
	await expect(page.getByTestId("attachment-chip")).toHaveAttribute("title", "nested.png");
});
