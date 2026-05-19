import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Real-browser proof of the chat image blur-in lifecycle:
 *   - markdown image renders inside `<span.progressive-img-wrap>` with
 *     the <img> blurred + transparent over a shimmer placeholder;
 *   - once the bytes arrive and `load` fires, the wire() handler adds
 *     `--loaded` to both the img and the wrapper (un-blur + fade in);
 *   - a broken image collapses the wrapper (`--error`) AND the existing
 *     fallback card still replaces the <img> — the progressive-image
 *     and image-error-handler wirings coexist on one error event.
 *
 * The unit + jsdom component tests pin the same contract; this spec
 * proves it survives the real render pipeline (marked → DOMPurify →
 * {@html} → $effect) and a real network load in Chromium.
 */

const proj = makeProject({ id: "proj-1", name: "Image Blur-In" });

const ONE_BY_ONE_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	"base64",
);

test.describe("chat image blur-in", () => {
	test("blurred placeholder → sharp once the image loads", async ({
		page,
		mockApi,
	}) => {
		const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Here: ![a cat](https://img.example.test/cat.png)",
			createdAt: "2026-01-01T00:01:00.000Z",
		});
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [assistantMsg],
		});

		// Hold the image bytes until the test has observed the loading
		// state, so the blurred → sharp transition is deterministic.
		let releaseImage: () => void = () => {};
		const imageGate = new Promise<void>((resolve) => {
			releaseImage = resolve;
		});
		await page.route("https://img.example.test/cat.png", async (route) => {
			await imageGate;
			await route.fulfill({
				status: 200,
				contentType: "image/png",
				body: ONE_BY_ONE_PNG,
			});
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const wrap = page.locator("span.progressive-img-wrap").first();
		const img = wrap.locator("img.progressive-img");
		await expect(img).toBeVisible();

		// ── Loading state: blurred, transparent, not yet --loaded ──
		await expect(img).not.toHaveClass(/progressive-img--loaded/);
		await expect(wrap).not.toHaveClass(/progressive-img-wrap--loaded/);
		const loadingStyle = await img.evaluate((el) => {
			const s = getComputedStyle(el);
			return { filter: s.filter, opacity: s.opacity };
		});
		expect(loadingStyle.filter).toContain("blur");
		expect(loadingStyle.filter).not.toContain("blur(0");
		expect(Number(loadingStyle.opacity)).toBeLessThan(1);

		// ── Release the bytes → load fires → settles sharp ──
		releaseImage();
		await expect(img).toHaveClass(/progressive-img--loaded/);
		await expect(wrap).toHaveClass(/progressive-img-wrap--loaded/);
		await expect
			.poll(async () =>
				img.evaluate((el) => getComputedStyle(el).opacity),
			)
			.toBe("1");
		// The heavy placeholder blur is gone (engines serialize a settled
		// `blur(0)` inconsistently — "none" vs "blur(0px)" — so assert the
		// meaningful invariant: it's no longer the 16px loading blur).
		const finalFilter = await img.evaluate(
			(el) => getComputedStyle(el).filter,
		);
		expect(finalFilter).not.toContain("16px");
	});

	test("broken image collapses the wrapper and shows the fallback card", async ({
		page,
		mockApi,
	}) => {
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
		await page.route("https://img.example.test/gone.png", (r) =>
			r.fulfill({ status: 404, contentType: "text/plain", body: "nope" }),
		);

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// progressive-image's error handler flagged the wrapper for the
		// markdown-scoped `display:contents` collapse + stopped the shimmer.
		const wrap = page.locator("span.progressive-img-wrap").first();
		await expect(wrap).toHaveClass(/progressive-img-wrap--error/);
		await expect(wrap).toHaveClass(/progressive-img-wrap--loaded/);

		// attachImageFallbacks still swapped the <img> for the fallback —
		// the two error listeners coexist on the single error event.
		const fallback = page.getByTestId("chat-image-fallback");
		await expect(fallback).toBeVisible();
		await expect(fallback).toContainText("Image unavailable");
		await expect(fallback).toContainText("broken one");
		await expect(page.locator('img[data-chat-image="1"]')).toHaveCount(0);
	});
});
