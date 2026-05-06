/**
 * DOM tests for AttachmentCard.svelte. Runs under vitest with the Svelte
 * plugin + jsdom. Covers the branches the pure-logic tests + Playwright
 * e2e can't assert in isolation: which render path is chosen for each
 * kind, lightbox store interaction, and onerror fallback.
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeEach } from "vitest";
import AttachmentCard from "./AttachmentCard.svelte";
import { lightbox } from "$lib/image-lightbox.svelte";

const image = {
	id: "att-img-1",
	filename: "cow.png",
	mimeType: "image/png",
	sizeBytes: 2048,
	kind: "image" as const,
};
const textFile = {
	id: "att-txt-1",
	filename: "notes.txt",
	mimeType: "text/plain",
	sizeBytes: 512,
	kind: "text" as const,
};

beforeEach(() => {
	// Reset the shared lightbox store so each test sees a clean state.
	lightbox.hide();
});
afterEach(() => cleanup());

describe("AttachmentCard", () => {
	test("image kind renders <img> via /api/attachments/:id with filename alt + lazy", () => {
		const { getByTestId } = render(AttachmentCard, { attachment: image });
		const card = getByTestId("attachment-card-image");
		const img = card.querySelector("img")!;
		expect(img).toBeInTheDocument();
		expect(img).toHaveAttribute("src", `/api/attachments/${image.id}`);
		expect(img).toHaveAttribute("alt", image.filename);
		expect(img).toHaveAttribute("loading", "lazy");
	});

	test("non-image kind renders file card with filename + pretty size + download link", () => {
		const { getByTestId } = render(AttachmentCard, { attachment: textFile });
		const card = getByTestId("attachment-card-file");
		expect(card).toHaveTextContent(textFile.filename);
		expect(card).toHaveTextContent("512 B");
		const download = getByTestId("attachment-download");
		expect(download).toHaveAttribute("href", `/api/attachments/${textFile.id}?download=1`);
		expect(download).toHaveAttribute("download", textFile.filename);
	});

	test("clicking an image card opens the shared lightbox store", async () => {
		const { getByTestId } = render(AttachmentCard, { attachment: image });
		expect(lightbox.open).toBe(false);
		const card = getByTestId("attachment-card-image");
		await fireEvent.click(card);
		expect(lightbox.open).toBe(true);
		expect(lightbox.src).toBe(`/api/attachments/${image.id}`);
		expect(lightbox.alt).toBe(image.filename);
		expect(lightbox.originalUrl).toBe(null);
	});

	test("Enter and Space keys on a focused image card open the lightbox (a11y)", async () => {
		const { getByTestId } = render(AttachmentCard, { attachment: image });
		const card = getByTestId("attachment-card-image");
		await fireEvent.keyDown(card, { key: "Enter" });
		expect(lightbox.open).toBe(true);
		lightbox.hide();
		await fireEvent.keyDown(card, { key: " " });
		expect(lightbox.open).toBe(true);
	});

	test("image <img> onerror falls back to file card", async () => {
		const { queryByTestId, getByTestId } = render(AttachmentCard, { attachment: image });
		expect(queryByTestId("attachment-card-image")).not.toBeNull();
		const img = getByTestId("attachment-card-image").querySelector("img")!;
		await fireEvent.error(img);
		expect(queryByTestId("attachment-card-image")).toBeNull();
		const fallback = getByTestId("attachment-card-file");
		expect(fallback).toHaveTextContent(image.filename);
	});

	test("audio kind renders the inline <audio> player branch", () => {
		// Audio attachments now render with native <audio controls> so
		// users can scrub / play directly inside the chat bubble — no
		// click-through to a download. See AttachmentCard.audio.component.test.ts
		// for the new branch's full contract.
		const { getByTestId, queryByTestId } = render(AttachmentCard, {
			attachment: { id: "a1", filename: "bell.mp3", mimeType: "audio/mpeg", sizeBytes: 4096, kind: "audio" },
		});
		const card = getByTestId("attachment-card-audio");
		const audio = card.querySelector("audio");
		expect(audio).not.toBeNull();
		expect(audio).toHaveAttribute("src", "/api/attachments/a1");
		expect(audio).toHaveAttribute("aria-label", "bell.mp3");
		// File card branch is NOT rendered for audio kind anymore.
		expect(queryByTestId("attachment-card-file")).toBeNull();
	});

	test("pdf kind renders file card with document icon", () => {
		const { getByTestId } = render(AttachmentCard, {
			attachment: { id: "p1", filename: "spec.pdf", mimeType: "application/pdf", sizeBytes: 1024 * 1024, kind: "pdf" },
		});
		const card = getByTestId("attachment-card-file");
		expect(card).toHaveTextContent("📄");
		expect(card).toHaveTextContent("spec.pdf");
		expect(card).toHaveTextContent("1.0 MB");
	});

	test("unusual filenames render verbatim in the file card", () => {
		const { getByTestId } = render(AttachmentCard, {
			attachment: { id: "q1", filename: `weird "quoted" & <tags>.txt`, mimeType: "text/plain", sizeBytes: 10, kind: "text" },
		});
		const card = getByTestId("attachment-card-file");
		// Svelte escapes for text content — assert textContent, not innerHTML.
		expect(card.textContent).toContain(`weird "quoted" & <tags>.txt`);
	});

	test("aria-label on the image card includes the filename for screen readers", () => {
		const { getByTestId } = render(AttachmentCard, { attachment: image });
		const card = getByTestId("attachment-card-image");
		expect(card).toHaveAttribute("aria-label", `Open ${image.filename}`);
	});
});
