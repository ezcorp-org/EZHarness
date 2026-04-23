/**
 * DOM tests for the thumbnail-preview effect in StagedAttachmentTray.svelte —
 * the component ChatInput delegates its staged-attachments chip row to. Kept
 * at the component level rather than mounting the full composer so we don't
 * have to stub ~10 children and stores.
 */

import { render, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import StagedAttachmentTray from "./StagedAttachmentTray.svelte";

function makeFile(name: string, type: string): File {
	return new File([new Uint8Array([1, 2, 3])], name, { type });
}

let urlMap = new Map<File, string>();
let nextId = 0;
let revokeSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	urlMap = new Map();
	nextId = 0;
	URL.createObjectURL = vi.fn((blob: Blob) => {
		const url = `blob:mock://${++nextId}`;
		urlMap.set(blob as File, url);
		return url;
	});
	revokeSpy = vi.fn();
	URL.revokeObjectURL = revokeSpy;
});
afterEach(() => cleanup());

describe("ChatInput thumbnail preview effect", () => {
	test("image file produces a blob URL; non-image yields no-thumb", () => {
		const { getAllByTestId } = render(StagedAttachmentTray, {
			stagedFiles: [makeFile("cat.png", "image/png"), makeFile("notes.txt", "text/plain")],
		});
		const chips = getAllByTestId("attachment-chip");
		expect(chips.length).toBe(2);
		const imgSrc = chips[0]!.querySelector("img")?.getAttribute("src");
		expect(imgSrc).toMatch(/^blob:/);
		// Non-image chips render a filename span, not an <img>.
		expect(chips[1]!.querySelector("img")).toBeNull();
		expect(chips[1]!.textContent).toContain("notes.txt");
	});

	test("revokes prior URL batch when stagedFiles changes", async () => {
		const firstFile = makeFile("a.png", "image/png");
		const { rerender, getByTestId } = render(StagedAttachmentTray, { stagedFiles: [firstFile] });
		const firstUrl = getByTestId("attachment-chip").querySelector("img")!.getAttribute("src")!;
		expect(firstUrl).toMatch(/^blob:/);
		expect(revokeSpy).not.toHaveBeenCalled();

		await rerender({ stagedFiles: [makeFile("b.png", "image/png")] });

		// The previous run's URL should now be revoked.
		expect(revokeSpy).toHaveBeenCalledWith(firstUrl);
	});

	test("revokes all allocated URLs on component unmount", async () => {
		const { unmount, getAllByTestId } = render(StagedAttachmentTray, {
			stagedFiles: [makeFile("a.png", "image/png"), makeFile("b.png", "image/png")],
		});
		const chips = getAllByTestId("attachment-chip");
		const urls = chips.map((c) => c.querySelector("img")!.getAttribute("src")!);
		unmount();
		for (const u of urls) expect(revokeSpy).toHaveBeenCalledWith(u);
	});

	test("empty stagedFiles produces no previews and no URL allocations", () => {
		const { queryAllByTestId } = render(StagedAttachmentTray, { stagedFiles: [] });
		expect(queryAllByTestId("attachment-chip")).toHaveLength(0);
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});
});
