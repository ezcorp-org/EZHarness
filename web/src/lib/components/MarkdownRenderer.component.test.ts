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
import { afterEach, beforeEach, describe, test, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import MarkdownRenderer from "./MarkdownRenderer.svelte";
import { DIFF_VIEW_MODE_KEY } from "$lib/diff-view-mode";

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

describe("MarkdownRenderer — diff view-mode persistence", () => {
	// markdown.ts always emits a chat diff in split mode (data-view="side-by-side")
	// with both views in the DOM; the component's restore $effect re-applies the
	// globally-persisted preference, and the toggle button persists new choices.
	const DIFF_MD = [
		"```diff",
		"--- a/src/auth.ts",
		"+++ b/src/auth.ts",
		"@@ -1,2 +1,2 @@",
		"-const ok = false;",
		"+const ok = true;",
		"```",
	].join("\n");

	beforeEach(() => localStorage.clear());
	afterEach(() => localStorage.clear());

	test("defaults to split when nothing is stored", () => {
		const { container } = render(MarkdownRenderer, { content: DIFF_MD });
		expect(container.querySelector(".diff-container")).toHaveAttribute("data-view", "side-by-side");
	});

	test("restores the persisted unified mode after render (the refresh fix)", async () => {
		localStorage.setItem(DIFF_VIEW_MODE_KEY, "line-by-line");
		const { container } = render(MarkdownRenderer, { content: DIFF_MD });

		await waitFor(() => {
			expect(container.querySelector(".diff-container")).toHaveAttribute("data-view", "unified");
		});
		const side = container.querySelector(".diff-view-side") as HTMLElement;
		const unified = container.querySelector(".diff-view-unified") as HTMLElement;
		expect(side.style.display).toBe("none");
		expect(unified.style.display).toBe("");
	});

	test("clicking the toggle switches the view and persists the choice", async () => {
		const { container } = render(MarkdownRenderer, { content: DIFF_MD });
		const containerEl = container.querySelector(".diff-container")!;
		expect(containerEl).toHaveAttribute("data-view", "side-by-side");

		await fireEvent.click(container.querySelector(".diff-toggle-btn")!);
		expect(containerEl).toHaveAttribute("data-view", "unified");
		expect(localStorage.getItem(DIFF_VIEW_MODE_KEY)).toBe("line-by-line");

		await fireEvent.click(container.querySelector(".diff-toggle-btn")!);
		expect(containerEl).toHaveAttribute("data-view", "side-by-side");
		expect(localStorage.getItem(DIFF_VIEW_MODE_KEY)).toBe("side-by-side");
	});
});
