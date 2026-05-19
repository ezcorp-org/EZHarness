import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Covers the image-in-chat flow: a tool/skill returns an image URL, the model
 * includes it in its reply as markdown, the chat view renders it as an <img>
 * with lazy loading, click opens a lightbox, broken URLs get a fallback card.
 */

const proj = makeProject({ id: "proj-1", name: "Image Render" });

// 1×1 transparent PNG to satisfy the network fetch for a "working" image.
const ONE_BY_ONE_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	"base64",
);

test.describe("chat image rendering", () => {
	test("markdown image URL renders as a lazy-loaded chat image", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "draw a cat",
		});
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Here is your cat: ![a cute cat](https://img.example.test/cat.png)",
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});

		// Serve the image URL with a real PNG so onload fires (not onerror).
		await page.route("https://img.example.test/**", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "image/png",
				body: ONE_BY_ONE_PNG,
			});
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const img = page.locator('img[data-chat-image="1"]').first();
		await expect(img).toBeVisible();
		await expect(img).toHaveAttribute("src", "https://img.example.test/cat.png");
		await expect(img).toHaveAttribute("alt", "a cute cat");
		await expect(img).toHaveAttribute("loading", "lazy");
		await expect(img).toHaveAttribute("decoding", "async");
		await expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
	});

	test("clicking a chat image opens the lightbox; Escape closes it", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "![view](https://img.example.test/view.png)",
			createdAt: "2026-01-01T00:01:00.000Z",
		});
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [assistantMsg],
		});
		await page.route("https://img.example.test/**", (r) =>
			r.fulfill({ status: 200, contentType: "image/png", body: ONE_BY_ONE_PNG }),
		);

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByTestId("image-lightbox")).toHaveCount(0);
		await page.locator('img[data-chat-image="1"]').first().click();
		await expect(page.getByTestId("image-lightbox")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByTestId("image-lightbox")).toHaveCount(0);
	});

	test("broken image URL renders a fallback card with a link to the original", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "![broken one](https://img.example.test/gone.png)",
			createdAt: "2026-01-01T00:01:00.000Z",
		});
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [assistantMsg],
		});
		// Return 404 to trigger the <img> error event.
		await page.route("https://img.example.test/gone.png", (r) =>
			r.fulfill({ status: 404, contentType: "text/plain", body: "not found" }),
		);

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const fallback = page.getByTestId("chat-image-fallback");
		await expect(fallback).toBeVisible();
		await expect(fallback).toContainText("Image unavailable");
		await expect(fallback).toContainText("broken one");

		const link = fallback.getByRole("link", { name: "Open original" });
		await expect(link).toHaveAttribute("href", "https://img.example.test/gone.png");
		await expect(link).toHaveAttribute("target", "_blank");
		await expect(link).toHaveAttribute("rel", "noopener noreferrer");

		// Original <img> has been replaced by the fallback span.
		await expect(page.locator('img[data-chat-image="1"]')).toHaveCount(0);
	});

	test("lightbox backdrop click closes the lightbox", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "![x](https://img.example.test/x.png)",
			createdAt: "2026-01-01T00:01:00.000Z",
		});
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [assistantMsg],
		});
		await page.route("https://img.example.test/**", (r) =>
			r.fulfill({ status: 200, contentType: "image/png", body: ONE_BY_ONE_PNG }),
		);

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.locator('img[data-chat-image="1"]').first().click();
		const lightbox = page.getByTestId("image-lightbox");
		await expect(lightbox).toBeVisible();

		// Click the backdrop (not the inner image) to dismiss.
		const box = await lightbox.boundingBox();
		if (!box) throw new Error("lightbox has no bounding box");
		await page.mouse.click(box.x + 4, box.y + 4);
		await expect(lightbox).toHaveCount(0);
	});

	test("lightbox close button dismisses the lightbox", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "![x](https://img.example.test/x.png)",
			createdAt: "2026-01-01T00:01:00.000Z",
		});
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [assistantMsg],
		});
		await page.route("https://img.example.test/**", (r) =>
			r.fulfill({ status: 200, contentType: "image/png", body: ONE_BY_ONE_PNG }),
		);

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.locator('img[data-chat-image="1"]').first().click();
		await expect(page.getByTestId("image-lightbox")).toBeVisible();

		await page.getByRole("button", { name: "Close image preview" }).click();
		await expect(page.getByTestId("image-lightbox")).toHaveCount(0);
	});
});
