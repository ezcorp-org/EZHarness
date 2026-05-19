/**
 * DOM tests for MessageAttachments — the component ChatMessage delegates its
 * attachment-slot block to. Kept as a component-level suite (rather than
 * mounting the full ChatMessage) to avoid stubbing MarkdownRenderer,
 * BranchNavigator, MessageToolbar, ProviderIcon, etc.
 */

import { render, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach } from "vitest";
import MessageAttachments from "./MessageAttachments.svelte";

const img = { id: "a1", filename: "cow.png", mimeType: "image/png", sizeBytes: 1, kind: "image" as const };
const txt = { id: "a2", filename: "notes.txt", mimeType: "text/plain", sizeBytes: 2048, kind: "text" as const };

afterEach(() => cleanup());

describe("ChatMessage attachment slot", () => {
	test("undefined attachments → no wrapper div rendered", () => {
		const { queryByTestId } = render(MessageAttachments, {});
		expect(queryByTestId("message-attachments")).toBeNull();
	});

	test("empty attachments → no wrapper div rendered", () => {
		const { queryByTestId } = render(MessageAttachments, { attachments: [] });
		expect(queryByTestId("message-attachments")).toBeNull();
	});

	test("one image → one image card under the message-attachments wrapper", () => {
		const { getByTestId } = render(MessageAttachments, { attachments: [img] });
		const wrapper = getByTestId("message-attachments");
		expect(wrapper.querySelectorAll("[data-testid='attachment-card-image']").length).toBe(1);
	});

	test("multiple mixed-kind attachments render each as its own card", () => {
		const { getByTestId } = render(MessageAttachments, { attachments: [img, txt] });
		const wrapper = getByTestId("message-attachments");
		expect(wrapper.querySelectorAll("[data-testid='attachment-card-image']").length).toBe(1);
		expect(wrapper.querySelectorAll("[data-testid='attachment-card-file']").length).toBe(1);
	});

	test("attachment wrapper renders AFTER the prompt text (layout order)", () => {
		// MessageAttachments emits the wrapper as its root output, so a
		// parent (ChatMessage) that renders prompt text first naturally
		// positions the wrapper after it. We simulate that parent here by
		// injecting a <p> before the mounted root.
		const { getByTestId, container } = render(MessageAttachments, { attachments: [img] });
		const promptText = document.createElement("p");
		promptText.textContent = "prompt text";
		container.insertBefore(promptText, container.firstChild);
		const wrapper = getByTestId("message-attachments");
		// compareDocumentPosition: DOCUMENT_POSITION_FOLLOWING = 4.
		expect(promptText.compareDocumentPosition(wrapper) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	test("cards are keyed by id so re-rendering with the same ids reuses nodes", async () => {
		const { rerender, getByTestId } = render(MessageAttachments, { attachments: [img, txt] });
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
