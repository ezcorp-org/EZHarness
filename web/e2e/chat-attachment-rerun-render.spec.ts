import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage, makeAttachment } from "./fixtures/data.js";

/**
 * Regression: re-running a prompt that carried an image must keep the image.
 *
 * A rerun/edit forks a NEW user row and re-sends WITHOUT re-uploading the File
 * bytes, so the server clones the original turn's attachments onto the fork
 * (see `src/chat/attachments/clone.ts`). This spec drives the real rerun toolbar
 * action and asserts the forked user turn — now the active branch — still renders
 * the image card. Before the fix, the fork carried zero attachments, the original
 * (image-bearing) row dropped off the active path, and the image vanished.
 */

const proj = makeProject({ id: "proj-1", name: "Rerun Render" });
const conv = makeConversation({
	id: "conv-1",
	projectId: "proj-1",
	provider: "anthropic",
	model: "claude-sonnet-4-20250514",
});

// Original user turn with an image, plus its assistant reply.
const origAttachment = makeAttachment({ id: "att-orig", filename: "cat.png", mimeType: "image/png", kind: "image" });
const userMsg = makeMessage({
	id: "u1",
	conversationId: "conv-1",
	role: "user",
	content: "describe this",
	parentMessageId: null,
	attachments: [origAttachment],
});
const assistantMsg = makeMessage({
	id: "a1",
	conversationId: "conv-1",
	role: "assistant",
	content: "a cat",
	parentMessageId: "u1",
	createdAt: "2026-01-01T00:01:00.000Z",
});

// The forked user row the (fixed) server returns: same prompt, attachments
// CLONED onto a fresh row + attachment id.
const inheritedAttachment = makeAttachment({ id: "att-fork", filename: "cat.png", mimeType: "image/png", kind: "image" });
const forkedUserMsg = makeMessage({
	id: "u1-fork",
	conversationId: "conv-1",
	role: "user",
	content: "describe this",
	parentMessageId: null,
	createdAt: "2026-01-01T00:02:00.000Z",
	attachments: [inheritedAttachment],
});

test("re-running an image prompt keeps the image on the forked turn", async ({ page, mockApi }) => {
	// Stub SSE so the streaming placeholder settles without a live run.
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

	await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });

	// The rerun POSTs `editOf` to /messages; the fixed server replies with a
	// forked userMessage carrying the CLONED attachments. Registered AFTER
	// mockApi so this override wins (Playwright runs the last-registered route
	// first); non-editOf requests fall back to the mock.
	let editOfPosted = false;
	await page.route("**/api/conversations/*/messages", async (route) => {
		if (route.request().method() === "POST") {
			const body = route.request().postData() ?? "";
			if (body.includes("editOf")) {
				editOfPosted = true;
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						userMessage: forkedUserMsg,
						runId: "run-rerun",
						attachments: [inheritedAttachment],
						ezActionResults: [],
					}),
				});
			}
		}
		return route.fallback();
	});

	await page.goto(`/project/${proj.id}/chat/${conv.id}`);

	// Precondition: the original image renders.
	const origImg = page.getByTestId("attachment-card-image").locator("img");
	await expect(origImg).toHaveAttribute("src", "/api/attachments/att-orig", { timeout: 10_000 });

	// Hover the user row (nearest group-hover container) → the Re-run toolbar
	// action appears; click it scoped to the row so the overlapping toolbar
	// can't intercept the hover.
	const userRow = page
		.getByText("describe this")
		.first()
		.locator("xpath=ancestor::div[contains(@class, 'group')][1]");
	await userRow.hover();
	const rerunBtn = userRow.locator('[data-testid="rerun-prompt-btn"]').first();
	await expect(rerunBtn).toBeVisible();
	await rerunBtn.click();

	// The rerun forked via editOf…
	await expect.poll(() => editOfPosted).toBe(true);

	// …and the forked turn (now the active branch) still shows the image —
	// served from the CLONED attachment id, not the original.
	const forkImg = page.getByTestId("attachment-card-image").locator("img");
	await expect(forkImg).toHaveAttribute("src", "/api/attachments/att-fork", { timeout: 10_000 });
});
