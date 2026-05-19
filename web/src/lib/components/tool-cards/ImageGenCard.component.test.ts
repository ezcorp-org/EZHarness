/**
 * DOM tests for ImageGenCard.svelte.
 *
 * Covers the contract the openai-image-gen-2 grid card needs:
 *   - Renders 1 / 2 / 4 `<img>` tags from the markdown image markers
 *     emitted by the extension's `formatResult` (single `![alt](url)`
 *     per generated image, joined by newlines).
 *   - Clicking a thumbnail opens an in-card lightbox at that image.
 *   - ArrowLeft / ArrowRight cycle and wrap at the ends; Esc closes.
 *   - When the streamed `toolCall.output` preview contains an image
 *     marker but might be truncated, the component eagerly hits
 *     /api/tool-calls/{id}/output to refetch the full output (so
 *     downstream images don't get chopped off mid-URL).
 *
 * The eager-fetch effect mirrors DefaultCard.svelte:36-54 — keeping the
 * two cards aligned on this behavior matters because multi-image
 * outputs are LONG and the per-message preview cap routinely cuts the
 * 3rd/4th URL in half. Component contract pins it explicitly.
 *
 * Mirrors KokoroTtsPlayerCard.component.test.ts:1-60 for the
 * vitest + @testing-library/svelte mocking pattern.
 */

import { render, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import ImageGenCard from "./ImageGenCard.svelte";
import type { ToolCallState } from "$lib/stores.svelte";

// ── Helpers ────────────────────────────────────────────────────────

/** Build a stub tool-call with a markdown output of N image markers. */
function makeToolCall(
	imageCount: number,
	overrides: Partial<ToolCallState> = {},
): ToolCallState {
	const urls = Array.from(
		{ length: imageCount },
		(_, i) => `/api/ext-files/openai-image-gen-2/generated/img-${i + 1}.png`,
	);
	const output = [
		`Generated ${imageCount} image${imageCount === 1 ? "" : "s"} with OpenAI.`,
		"",
		...urls.map((u, i) => `![cat ${i + 1}](${u})`),
	].join("\n");
	return {
		id: `tc-${imageCount}`,
		toolName: "openai-image-gen-2.generate",
		status: "complete",
		input: { prompt: "cat", n: imageCount },
		startedAt: 0,
		duration: 1234,
		cardType: "image-gen-grid",
		output,
		...overrides,
	};
}

beforeEach(() => {
	// Default fetch stub — returns 200 with no `output` field so the
	// eager-fetch effect is a no-op and the rendered grid reflects the
	// initial toolCall.output verbatim. Individual tests override.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
	);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// ── Grid rendering ────────────────────────────────────────────────

describe("ImageGenCard — grid layout", () => {
	test("renders a single image as a 1-cell grid", () => {
		const { getAllByRole, getByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(1),
		});
		const grid = getByTestId("image-gen-grid");
		expect(grid.getAttribute("data-image-count")).toBe("1");
		const imgs = getAllByRole("img");
		expect(imgs).toHaveLength(1);
		expect(imgs[0]).toHaveAttribute(
			"src",
			"/api/ext-files/openai-image-gen-2/generated/img-1.png",
		);
	});

	test("renders 2 images side-by-side with the expected URLs", () => {
		const { getAllByRole, getByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(2),
		});
		const grid = getByTestId("image-gen-grid");
		expect(grid.getAttribute("data-image-count")).toBe("2");
		const imgs = getAllByRole("img");
		expect(imgs).toHaveLength(2);
		expect(imgs.map((i) => i.getAttribute("src"))).toEqual([
			"/api/ext-files/openai-image-gen-2/generated/img-1.png",
			"/api/ext-files/openai-image-gen-2/generated/img-2.png",
		]);
	});

	test("renders 4 images in a 2×2 grid", () => {
		const { getAllByRole, getByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(4),
		});
		const grid = getByTestId("image-gen-grid");
		expect(grid.getAttribute("data-image-count")).toBe("4");
		const imgs = getAllByRole("img");
		expect(imgs).toHaveLength(4);
	});

	test("renders no grid when the output has no image markers", () => {
		const tc: ToolCallState = {
			id: "tc-empty",
			toolName: "openai-image-gen-2.generate",
			status: "complete",
			input: { prompt: "cat" },
			startedAt: 0,
			cardType: "image-gen-grid",
			output: "Error: model declined to generate.",
		};
		const { queryByTestId } = render(ImageGenCard, { toolCall: tc });
		expect(queryByTestId("image-gen-grid")).toBeNull();
	});
});

// ── Lightbox ─────────────────────────────────────────────────────

describe("ImageGenCard — lightbox / carousel", () => {
	test("clicking a thumbnail opens the lightbox on that image", async () => {
		const { getByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(4),
		});
		await fireEvent.click(getByTestId("image-gen-thumb-1")); // 2nd image
		const lightbox = getByTestId("image-gen-lightbox");
		expect(lightbox).toBeInTheDocument();
		expect(lightbox.getAttribute("data-active-index")).toBe("1");
		const lightboxImg = getByTestId("image-gen-lightbox-img");
		expect(lightboxImg).toHaveAttribute(
			"src",
			"/api/ext-files/openai-image-gen-2/generated/img-2.png",
		);
		expect(getByTestId("image-gen-lightbox-counter")).toHaveTextContent("2 / 4");
	});

	test("ArrowRight cycles forward and wraps past the end", async () => {
		const { getByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(4),
		});
		// Open on image 4 (index 3)
		await fireEvent.click(getByTestId("image-gen-thumb-3"));
		expect(getByTestId("image-gen-lightbox").getAttribute("data-active-index")).toBe("3");
		// Right past the end → wraps to index 0
		await fireEvent.keyDown(window, { key: "ArrowRight" });
		expect(getByTestId("image-gen-lightbox").getAttribute("data-active-index")).toBe("0");
		expect(getByTestId("image-gen-lightbox-img")).toHaveAttribute(
			"src",
			"/api/ext-files/openai-image-gen-2/generated/img-1.png",
		);
	});

	test("ArrowLeft cycles back and wraps past index 0", async () => {
		const { getByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(4),
		});
		// Open on image 1 (index 0)
		await fireEvent.click(getByTestId("image-gen-thumb-0"));
		expect(getByTestId("image-gen-lightbox").getAttribute("data-active-index")).toBe("0");
		// Left before index 0 → wraps to last (index 3)
		await fireEvent.keyDown(window, { key: "ArrowLeft" });
		expect(getByTestId("image-gen-lightbox").getAttribute("data-active-index")).toBe("3");
		expect(getByTestId("image-gen-lightbox-img")).toHaveAttribute(
			"src",
			"/api/ext-files/openai-image-gen-2/generated/img-4.png",
		);
	});

	test("Escape closes the lightbox", async () => {
		const { getByTestId, queryByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(2),
		});
		await fireEvent.click(getByTestId("image-gen-thumb-0"));
		expect(queryByTestId("image-gen-lightbox")).toBeInTheDocument();
		await fireEvent.keyDown(window, { key: "Escape" });
		expect(queryByTestId("image-gen-lightbox")).toBeNull();
	});

	test("clicking the close button closes the lightbox", async () => {
		const { getByTestId, queryByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(2),
		});
		await fireEvent.click(getByTestId("image-gen-thumb-0"));
		await fireEvent.click(getByTestId("image-gen-lightbox-close"));
		expect(queryByTestId("image-gen-lightbox")).toBeNull();
	});

	test("prev/next buttons are present only when more than one image", async () => {
		const { getByTestId, queryByTestId, rerender } = render(ImageGenCard, {
			toolCall: makeToolCall(1),
		});
		await fireEvent.click(getByTestId("image-gen-thumb-0"));
		expect(queryByTestId("image-gen-lightbox-prev")).toBeNull();
		expect(queryByTestId("image-gen-lightbox-next")).toBeNull();
		// Switch to the 2-image case — nav buttons appear.
		await rerender({ toolCall: makeToolCall(2) });
		await fireEvent.click(getByTestId("image-gen-thumb-0"));
		expect(queryByTestId("image-gen-lightbox-prev")).toBeInTheDocument();
		expect(queryByTestId("image-gen-lightbox-next")).toBeInTheDocument();
	});
});

// ── Eager-fetch on truncated output ───────────────────────────────

describe("ImageGenCard — eager full-output fetch", () => {
	test("when the streamed output is truncated, fetches the full output and re-renders the grid", async () => {
		// Truncated preview: 1st image URL ends mid-string (no closing
		// paren); 2nd image marker isn't even in the slice. The eager
		// effect should fire because the preview contains AT LEAST one
		// completable marker.
		const truncated =
			"Generated 4 images with OpenAI.\n\n" +
			"![cat 1](/api/ext-files/openai-image-gen-2/generated/img-1.png)\n" +
			"![cat 2](/api/ext-files/openai-image-gen-2/generated/img-2.pn"; // cut off

		// Full output (what /api/tool-calls/{id}/output returns) has all 4.
		const full =
			"Generated 4 images with OpenAI.\n\n" +
			"![cat 1](/api/ext-files/openai-image-gen-2/generated/img-1.png)\n" +
			"![cat 2](/api/ext-files/openai-image-gen-2/generated/img-2.png)\n" +
			"![cat 3](/api/ext-files/openai-image-gen-2/generated/img-3.png)\n" +
			"![cat 4](/api/ext-files/openai-image-gen-2/generated/img-4.png)";

		const fetchSpy = vi.fn(async (url: RequestInfo | URL) => {
			const u = String(url);
			if (u.includes("/api/tool-calls/")) {
				return new Response(JSON.stringify({ output: full }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("{}", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchSpy);

		const { getAllByRole } = render(ImageGenCard, {
			toolCall: makeToolCall(4, { output: truncated }),
		});

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith("/api/tool-calls/tc-4/output");
			// After the refetch resolves, all 4 thumbnails are rendered.
			expect(getAllByRole("img")).toHaveLength(4);
		});
	});

	test("does NOT fetch the full output when the preview has no image markers", async () => {
		const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchSpy);
		render(ImageGenCard, {
			toolCall: {
				id: "tc-empty",
				toolName: "openai-image-gen-2.generate",
				status: "complete",
				input: { prompt: "cat" },
				startedAt: 0,
				cardType: "image-gen-grid",
				output: "(no images returned)",
			} satisfies ToolCallState,
		});
		// Eager fetch is gated on `outputHasImage` — never called here.
		await new Promise((r) => setTimeout(r, 10));
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("silently degrades when the eager-fetch rejects (no crash, no retry storm)", async () => {
		// The card's eager `.catch()` (ImageGenCard.svelte:114) swallows
		// the failure on purpose — the truncated preview is the fallback.
		// This test pins three properties:
		//   1. Mounting with a rejecting fetch does NOT throw.
		//   2. The truncated preview's images still render (no blanking).
		//   3. The component only attempts the fetch once (no retry loop).
		const fetchSpy = vi.fn(async () => {
			throw new Error("network down");
		});
		vi.stubGlobal("fetch", fetchSpy);

		// One image survives the truncation; second is cut mid-URL.
		const truncated =
			"Generated 4 images with OpenAI.\n\n" +
			"![cat 1](/api/ext-files/openai-image-gen-2/generated/img-1.png)\n" +
			"![cat 2](/api/ext-files/openai-image-gen-2/generated/img-2.pn";

		const { getAllByRole } = render(ImageGenCard, {
			toolCall: makeToolCall(4, { output: truncated }),
		});

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith("/api/tool-calls/tc-4/output");
		});
		// The 1 fully-parseable image marker still renders. The card did
		// not blank out, did not throw an unhandled rejection.
		expect(getAllByRole("img").length).toBe(1);
		// Eager-fetch is one-shot — `imageOutputLoaded` flips on dispatch,
		// so a rejection does NOT trigger a retry.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});

// ── Backdrop click ────────────────────────────────────────────────

describe("ImageGenCard — backdrop click", () => {
	test("clicking the backdrop (not the image) closes the lightbox", async () => {
		// `handleBackdropClick` (ImageGenCard.svelte:157-159) only fires
		// when the click target IS the backdrop element itself. Clicks
		// on the `<img>` inside don't bubble-close because the target is
		// the image, not the backdrop. Asserting both halves here.
		const { getByTestId, queryByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(4),
		});
		await fireEvent.click(getByTestId("image-gen-thumb-0"));
		const backdrop = getByTestId("image-gen-lightbox");
		expect(backdrop).toBeInTheDocument();

		// Click the lightbox image — target !== currentTarget, so it must
		// NOT close. (Guards against a regression where a stray
		// `onclick={closeLightbox}` on `<img>` would swallow zoom-in.)
		const lightboxImg = getByTestId("image-gen-lightbox-img");
		await fireEvent.click(lightboxImg);
		expect(queryByTestId("image-gen-lightbox")).toBeInTheDocument();

		// Click the backdrop element directly — target === currentTarget,
		// closes the lightbox.
		await fireEvent.click(backdrop);
		expect(queryByTestId("image-gen-lightbox")).toBeNull();
	});
});

// ── 3-image grid (per spec: 3-4 → 2×2 grid) ───────────────────────

describe("ImageGenCard — 3-image grid", () => {
	test("renders 3 images using the 2×2 grid layout (slot 4 left empty)", () => {
		// Spec: "3-4 → 2×2 grid". The component picks `grid-4` for any
		// count >= 3 (ImageGenCard.svelte:190-196). Three thumbs render;
		// the 4th slot is just empty space — cleaner than asymmetric span.
		const { getAllByRole, getByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(3),
		});
		const grid = getByTestId("image-gen-grid");
		expect(grid.getAttribute("data-image-count")).toBe("3");
		// 2×2 layout class is `grid-4` for both 3 and 4 image cases.
		expect(grid.className).toContain("grid-4");
		const imgs = getAllByRole("img");
		expect(imgs).toHaveLength(3);
		expect(imgs.map((i) => i.getAttribute("src"))).toEqual([
			"/api/ext-files/openai-image-gen-2/generated/img-1.png",
			"/api/ext-files/openai-image-gen-2/generated/img-2.png",
			"/api/ext-files/openai-image-gen-2/generated/img-3.png",
		]);
	});
});

// ── Status-driven header icon ─────────────────────────────────────

describe("ImageGenCard — status renders", () => {
	test("status='running' renders the spinner icon (no grid yet)", () => {
		// The eager-fetch effect is gated on `status === 'complete'`, so
		// a running call short-circuits the grid even if `output` has
		// image markers. Tests both: spinner present, grid absent.
		const tc = makeToolCall(2, { status: "running", output: undefined });
		const { container, queryByTestId } = render(ImageGenCard, { toolCall: tc });
		// `animate-spin` is the unique tailwind class on the spinner svg.
		const spinner = container.querySelector(".animate-spin");
		expect(spinner).toBeInTheDocument();
		expect(queryByTestId("image-gen-grid")).toBeNull();
	});

	test("status='error' renders the red X icon", () => {
		// The error path lights up the red svg at lines 220-222. We can't
		// match on the path string alone (it's used by other svgs too),
		// but `.text-red-500` is unique to the error icon.
		const tc = makeToolCall(0, {
			status: "error",
			output: undefined,
			error: "OpenAI API rejected the prompt",
		});
		const { container } = render(ImageGenCard, { toolCall: tc });
		const errorIcon = container.querySelector(".text-red-500");
		expect(errorIcon).toBeInTheDocument();
	});
});

// ── Expand / collapse + CopyButton gating ─────────────────────────

describe("ImageGenCard — expand toggle + CopyButton", () => {
	// The expanded panel uses `transition:slide`, which calls
	// `Element.animate()` (Web Animations API) — jsdom doesn't implement
	// it. Stub a no-op to let `slide` run through without throwing; we
	// don't assert on the animation, only on the DOM state after toggling.
	beforeEach(() => {
		if (typeof (Element.prototype as unknown as { animate?: unknown }).animate !== "function") {
			(Element.prototype as unknown as { animate: (...args: unknown[]) => unknown }).animate =
				() => ({
					cancel() {},
					finished: Promise.resolve(),
					onfinish: null,
					play() {},
					pause() {},
				});
		}
	});

	test("clicking the header toggles the expanded panel; CopyButton appears only when expanded with output", async () => {
		// Three properties pinned:
		//   1. The expanded `<pre>Input</pre>` panel is hidden until the
		//      header is clicked.
		//   2. CopyButton (aria-label="Copy output") is NOT rendered
		//      while collapsed (gated on `expanded && displayOutput`).
		//   3. After expand, both appear; after a second click, both go.
		const { getByRole, queryByLabelText, container } = render(ImageGenCard, {
			toolCall: makeToolCall(2),
		});

		// Collapsed: no "Input" label, no CopyButton.
		expect(container.textContent).not.toContain("Input");
		expect(queryByLabelText("Copy output")).toBeNull();

		// Click the header button (the expand button is the only
		// element with `aria-expanded`, which `getByRole('button')` with
		// `expanded: false` selects).
		const header = getByRole("button", { expanded: false });
		await fireEvent.click(header);

		await waitFor(() => {
			expect(container.textContent).toContain("Input");
			// CopyButton renders because `displayOutput` is set (from
			// `toolCall.output`) AND `expanded` is true.
			expect(queryByLabelText("Copy output")).toBeInTheDocument();
		});

		// Toggle back collapsed.
		const collapseHeader = getByRole("button", { expanded: true });
		await fireEvent.click(collapseHeader);
		await waitFor(() => {
			expect(queryByLabelText("Copy output")).toBeNull();
		});
	});
});

// ── Per-thumbnail Edit affordance ─────────────────────────────────

describe("ImageGenCard — Edit affordance", () => {
	beforeEach(() => {
		// transition:slide on the edit form needs the same Element.animate
		// stub as the expand panel.
		if (typeof (Element.prototype as unknown as { animate?: unknown }).animate !== "function") {
			(Element.prototype as unknown as { animate: (...args: unknown[]) => unknown }).animate =
				() => ({
					cancel() {},
					finished: Promise.resolve(),
					onfinish: null,
					play() {},
					pause() {},
				});
		}
	});

	test("Edit buttons are hidden when no onsendmessage prop is wired", () => {
		// Defensive: card must still render N images and lightbox in
		// read-only contexts (replay views, history mode).
		const { queryByTestId } = render(ImageGenCard, { toolCall: makeToolCall(2) });
		expect(queryByTestId("image-gen-edit-btn-0")).toBeNull();
		expect(queryByTestId("image-gen-edit-btn-1")).toBeNull();
	});

	test("clicking the per-thumbnail Edit button opens the inline edit form for that image", async () => {
		const onsendmessage = vi.fn();
		const { getByTestId, queryByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(3),
			onsendmessage,
		});
		// Edit form is hidden initially.
		expect(queryByTestId("image-gen-edit-form")).toBeNull();
		// Click Edit on image index 1.
		await fireEvent.click(getByTestId("image-gen-edit-btn-1"));
		await waitFor(() => {
			const form = getByTestId("image-gen-edit-form");
			expect(form).toBeInTheDocument();
			expect(form.getAttribute("data-edit-index")).toBe("1");
		});
	});

	test("Send dispatches a message containing the targeted image's URL and the typed prompt", async () => {
		const onsendmessage = vi.fn();
		const { getByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(2),
			onsendmessage,
		});
		await fireEvent.click(getByTestId("image-gen-edit-btn-0"));
		const ta = getByTestId("image-gen-edit-textarea") as HTMLTextAreaElement;
		await fireEvent.input(ta, { target: { value: "make it night mode" } });
		await fireEvent.click(getByTestId("image-gen-edit-send"));
		expect(onsendmessage).toHaveBeenCalledTimes(1);
		const msg = onsendmessage.mock.calls[0]![0]!;
		// The dispatched message must reference the extension explicitly,
		// inline the targeted URL (so the model can pass it to `edit` without
		// asking the user), and carry the user's edit description.
		expect(msg).toContain("![ext:openai-image-gen-2]");
		expect(msg).toContain("/api/ext-files/openai-image-gen-2/generated/img-1.png");
		expect(msg).toContain("make it night mode");
		expect(msg).toContain("`edit` tool");
	});

	test("Send is disabled while the prompt is empty / whitespace-only", async () => {
		const onsendmessage = vi.fn();
		const { getByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(2),
			onsendmessage,
		});
		await fireEvent.click(getByTestId("image-gen-edit-btn-0"));
		const send = getByTestId("image-gen-edit-send") as HTMLButtonElement;
		expect(send).toBeDisabled();
		const ta = getByTestId("image-gen-edit-textarea") as HTMLTextAreaElement;
		await fireEvent.input(ta, { target: { value: "   " } });
		expect(send).toBeDisabled();
		await fireEvent.input(ta, { target: { value: "actual prompt" } });
		expect(send).not.toBeDisabled();
	});

	test("Cancel closes the form without sending anything", async () => {
		const onsendmessage = vi.fn();
		const { getByTestId, queryByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(2),
			onsendmessage,
		});
		await fireEvent.click(getByTestId("image-gen-edit-btn-0"));
		const ta = getByTestId("image-gen-edit-textarea") as HTMLTextAreaElement;
		await fireEvent.input(ta, { target: { value: "anything" } });
		await fireEvent.click(getByTestId("image-gen-edit-cancel"));
		await waitFor(() => {
			expect(queryByTestId("image-gen-edit-form")).toBeNull();
		});
		expect(onsendmessage).not.toHaveBeenCalled();
	});

	test("opens with the textarea auto-focused (and refocuses when switching to a different thumbnail's Edit)", async () => {
		const onsendmessage = vi.fn();
		const { getByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(3),
			onsendmessage,
		});
		// Open Edit on image 0 — textarea should receive focus so the user
		// can start typing without an extra click.
		await fireEvent.click(getByTestId("image-gen-edit-btn-0"));
		const ta0 = getByTestId("image-gen-edit-textarea") as HTMLTextAreaElement;
		await waitFor(() => {
			expect(document.activeElement).toBe(ta0);
		});

		// Switch to image 2 while the form is open. Svelte reuses the same
		// <textarea> node, but the autofocus effect tracks editIndex so it
		// re-focuses (which also blurs anything the user may have clicked
		// away to in the meantime).
		ta0.blur(); // simulate the user clicking off the textarea
		expect(document.activeElement).not.toBe(ta0);
		await fireEvent.click(getByTestId("image-gen-edit-btn-2"));
		await waitFor(() => {
			expect(document.activeElement).toBe(getByTestId("image-gen-edit-textarea"));
		});
	});

	test("Escape closes the form; Cmd-Enter sends", async () => {
		const onsendmessage = vi.fn();
		const { getByTestId, queryByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(2),
			onsendmessage,
		});
		// Open, type, Escape → closed, NOT sent.
		await fireEvent.click(getByTestId("image-gen-edit-btn-0"));
		const ta = getByTestId("image-gen-edit-textarea") as HTMLTextAreaElement;
		await fireEvent.input(ta, { target: { value: "first attempt" } });
		await fireEvent.keyDown(ta, { key: "Escape" });
		await waitFor(() => {
			expect(queryByTestId("image-gen-edit-form")).toBeNull();
		});
		expect(onsendmessage).not.toHaveBeenCalled();

		// Re-open, type, Cmd-Enter → sent.
		await fireEvent.click(getByTestId("image-gen-edit-btn-1"));
		const ta2 = getByTestId("image-gen-edit-textarea") as HTMLTextAreaElement;
		await fireEvent.input(ta2, { target: { value: "second attempt" } });
		await fireEvent.keyDown(ta2, { key: "Enter", metaKey: true });
		expect(onsendmessage).toHaveBeenCalledTimes(1);
		expect(onsendmessage.mock.calls[0]![0]!).toContain("second attempt");
	});
});

// ── Blur-in loading ───────────────────────────────────────────────

describe("ImageGenCard — blur-in loading", () => {
	test("each thumbnail is wired for progressive loading; load settles it", async () => {
		// Integration the progressive-image unit test can't cover: the
		// grid thumb button actually carries `.progressive-img-wrap`, the
		// <img> carries `.progressive-img` + `use:progressiveImage`
		// (data-prog-wired), and firing `load` toggles the --loaded
		// lifecycle on both. Guards against a regression that drops the
		// action/classes from the grid markup.
		const { getByTestId } = render(ImageGenCard, {
			toolCall: makeToolCall(2),
		});
		const thumb0 = getByTestId("image-gen-thumb-0");
		const img0 = thumb0.querySelector("img")!;
		expect(thumb0).toHaveClass("progressive-img-wrap");
		expect(img0).toHaveClass("progressive-img");
		expect(img0).toHaveAttribute("data-prog-wired", "1");
		expect(img0).not.toHaveClass("progressive-img--loaded");

		await fireEvent.load(img0);
		expect(img0).toHaveClass("progressive-img--loaded");
		expect(thumb0).toHaveClass("progressive-img-wrap--loaded");

		// Thumbnails settle independently — the 2nd is still blurred.
		const img1 = getByTestId("image-gen-thumb-1").querySelector("img")!;
		expect(img1).not.toHaveClass("progressive-img--loaded");
	});
});
