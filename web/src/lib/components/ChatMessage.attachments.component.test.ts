/**
 * DOM tests for the attachment-slot block in ChatMessage.svelte. We drive
 * a focused probe component (MessageAttachmentsProbe.svelte) that mirrors
 * the slot — mounting the full ChatMessage would require stubbing
 * MarkdownRenderer, BranchNavigator, MessageToolbar, ProviderIcon, etc.
 */

import { render, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach } from "vitest";
import Probe from "./__fixtures__/MessageAttachmentsProbe.svelte";

const img = { id: "a1", filename: "cow.png", mimeType: "image/png", sizeBytes: 1, kind: "image" as const };
const txt = { id: "a2", filename: "notes.txt", mimeType: "text/plain", sizeBytes: 2048, kind: "text" as const };

afterEach(() => cleanup());

describe("ChatMessage attachment slot", () => {
	test("undefined attachments → no wrapper div rendered", () => {
		const { queryByTestId } = render(Probe, {});
		expect(queryByTestId("message-attachments")).toBeNull();
	});

	test("empty attachments → no wrapper div rendered", () => {
		const { queryByTestId } = render(Probe, { attachments: [] });
		expect(queryByTestId("message-attachments")).toBeNull();
	});

	test("one image → one image card under the message-attachments wrapper", () => {
		const { getByTestId } = render(Probe, { attachments: [img] });
		const wrapper = getByTestId("message-attachments");
		expect(wrapper.querySelectorAll("[data-testid='attachment-card-image']").length).toBe(1);
	});

	test("multiple mixed-kind attachments render each as its own card", () => {
		const { getByTestId } = render(Probe, { attachments: [img, txt] });
		const wrapper = getByTestId("message-attachments");
		expect(wrapper.querySelectorAll("[data-testid='attachment-card-image']").length).toBe(1);
		expect(wrapper.querySelectorAll("[data-testid='attachment-card-file']").length).toBe(1);
	});

	test("attachment wrapper renders AFTER the prompt text (layout order)", () => {
		const { getByTestId, container } = render(Probe, { attachments: [img] });
		const promptText = container.querySelector("p")!;
		const wrapper = getByTestId("message-attachments");
		// compareDocumentPosition: DOCUMENT_POSITION_FOLLOWING = 4.
		expect(promptText.compareDocumentPosition(wrapper) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	test("cards are keyed by id so re-rendering with the same ids reuses nodes", async () => {
		const { rerender, getByTestId } = render(Probe, { attachments: [img, txt] });
		const firstImgCard = getByTestId("message-attachments").querySelector(
			"[data-testid='attachment-card-image']",
		);
		// Re-render with the same ids in reverse order — the keyed each
		// should preserve the original DOM nodes rather than re-creating.
		await rerender({ attachments: [txt, img] });
		const secondImgCard = getByTestId("message-attachments").querySelector(
			"[data-testid='attachment-card-image']",
		);
		expect(secondImgCard).toBe(firstImgCard);
	});
});
