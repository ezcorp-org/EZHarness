/**
 * DOM tests for the thumbnail-preview effect that ChatInput.svelte uses
 * to render staged image files. We drive a focused probe component
 * (StagedThumbnailProbe.svelte) that mirrors the exact `$effect` block
 * from ChatInput — running the real composer in isolation would require
 * stubbing ~10 children and stores.
 *
 * Keep the probe in sync with ChatInput.svelte if the effect block
 * changes. See fixtures/StagedThumbnailProbe.svelte.
 */

import { render, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import Probe from "./__fixtures__/StagedThumbnailProbe.svelte";

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
		const { getAllByTestId } = render(Probe, {
			stagedFiles: [makeFile("cat.png", "image/png"), makeFile("notes.txt", "text/plain")],
		});
		const items = getAllByTestId(/^preview-\d+$/);
		expect(items.length).toBe(2);
		expect(items[0]!.textContent).toMatch(/^blob:/);
		expect(items[1]!.textContent).toBe("(no-thumb)");
	});

	test("revokes prior URL batch when stagedFiles changes", async () => {
		const firstFile = makeFile("a.png", "image/png");
		const { rerender, getByTestId } = render(Probe, { stagedFiles: [firstFile] });
		const firstUrl = getByTestId("preview-0").textContent!;
		expect(firstUrl).toMatch(/^blob:/);
		expect(revokeSpy).not.toHaveBeenCalled();

		await rerender({ stagedFiles: [makeFile("b.png", "image/png")] });

		// The previous run's URL should now be revoked.
		expect(revokeSpy).toHaveBeenCalledWith(firstUrl);
	});

	test("revokes all allocated URLs on component unmount", async () => {
		const { unmount, getByTestId } = render(Probe, {
			stagedFiles: [makeFile("a.png", "image/png"), makeFile("b.png", "image/png")],
		});
		const urls = [getByTestId("preview-0").textContent!, getByTestId("preview-1").textContent!];
		unmount();
		for (const u of urls) expect(revokeSpy).toHaveBeenCalledWith(u);
	});

	test("empty stagedFiles produces no previews and no URL allocations", () => {
		const { queryAllByTestId } = render(Probe, { stagedFiles: [] });
		expect(queryAllByTestId(/^preview-\d+$/)).toHaveLength(0);
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});
});
