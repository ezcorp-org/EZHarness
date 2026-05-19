/**
 * DOM tests for MarkdownRenderer.svelte's image handling. Runs under
 * vitest with the Svelte plugin + jsdom.
 *
 * The pure-logic tests cover markdown.ts (the emitted HTML string) and
 * progressive-image.ts (the wire() state machine) in isolation. What
 * neither can prove is the *integration* inside the real component:
 *   1. DOMPurify (run inside renderMarkdown) actually preserves the
 *      `<span class="progressive-img-wrap">` wrapper — a stricter
 *      sanitizer config would silently drop it.
 *   2. The `$effect` actually invokes attachProgressiveImages on the
 *      rendered `{@html}` so the <img> gets wired (data-prog-wired).
 *   3. The blur-in load lifecycle toggles the --loaded classes.
 *   4. attachProgressiveImages and attachImageFallbacks coexist on the
 *      same error event: the wrapper collapses (--error) AND the
 *      existing fallback card still replaces the image.
 */

import { render, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import { afterEach, describe, test, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import MarkdownRenderer from "./MarkdownRenderer.svelte";

afterEach(() => cleanup());

const IMG_MD = "Here: ![a cat](https://img.example.test/cat.png)";

describe("MarkdownRenderer — progressive image integration", () => {
	test("DOMPurify preserves the wrapper span and the <img> is wired by the effect", async () => {
		const { container } = render(MarkdownRenderer, { content: IMG_MD });

		// (1) Wrapper survived sanitization with the right structure.
		const img = container.querySelector(
			"span.progressive-img-wrap > img.chat-image.progressive-img",
		) as HTMLImageElement | null;
		expect(img).not.toBeNull();

		// (2) The mount $effect ran attachProgressiveImages → img wired.
		await waitFor(() => {
			expect(img).toHaveAttribute("data-prog-wired", "1");
		});
		// Still blurred — nothing has loaded yet.
		expect(img).not.toHaveClass("progressive-img--loaded");
	});

	test("img load settles the blur-in on the img + wrapper", async () => {
		const { container } = render(MarkdownRenderer, { content: IMG_MD });
		const wrap = container.querySelector(
			"span.progressive-img-wrap",
		) as HTMLElement;
		const img = wrap.querySelector("img")!;
		await waitFor(() =>
			expect(img).toHaveAttribute("data-prog-wired", "1"),
		);

		await fireEvent.load(img);

		expect(img).toHaveClass("progressive-img--loaded");
		expect(wrap).toHaveClass("progressive-img-wrap--loaded");
	});

	test("error path: wrapper collapses (--error) AND the fallback card still replaces the image", async () => {
		const { container, getByTestId } = render(MarkdownRenderer, {
			content: IMG_MD,
		});
		const wrap = container.querySelector(
			"span.progressive-img-wrap",
		) as HTMLElement;
		const img = wrap.querySelector("img")!;
		await waitFor(() =>
			expect(img).toHaveAttribute("data-prog-wired", "1"),
		);

		await fireEvent.error(img);

		// progressive-image's error handler flagged the wrapper for the
		// markdown-scoped `display:contents` collapse + stopped the shimmer.
		expect(wrap).toHaveClass("progressive-img-wrap--error");
		expect(wrap).toHaveClass("progressive-img-wrap--loaded");
		// attachImageFallbacks still swapped the <img> for the fallback
		// span — the two error listeners coexist.
		const fallback = getByTestId("chat-image-fallback");
		expect(fallback).toBeInTheDocument();
		expect(fallback).toHaveTextContent("Image unavailable");
		expect(fallback).toHaveTextContent("a cat");
		expect(container.querySelector('img[data-chat-image="1"]')).toBeNull();
	});

	test("no image markdown → no wrapper emitted", () => {
		const { container } = render(MarkdownRenderer, {
			content: "just **text**, no pictures",
		});
		expect(container.querySelector(".progressive-img-wrap")).toBeNull();
	});
});
