/**
 * Composer input paths of the real <ChatInput>: IME composition, and
 * attachment staging through drop and paste (model limits, wrong types,
 * no model selected).
 */
import "@testing-library/jest-dom/vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import ChatInput from "./ChatInput.svelte";
import { __resetCapabilityCacheForTests } from "$lib/chat/attachment-client";
import { makeClientCapabilities } from "../../__tests__/stubs/model-capabilities";

const model = { provider: "openai", model: "gpt-4o" };
const imageCaps = makeClientCapabilities("openai", "gpt-4o", {
	kinds: ["text", "image"],
	acceptedMimeTypes: ["image/png"],
	maxBytesPerFile: 1024,
	maxFilesPerMessage: 2,
});

beforeEach(() => {
	__resetCapabilityCacheForTests();
	URL.createObjectURL = vi.fn(() => "blob:mock") as unknown as typeof URL.createObjectURL;
	URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			const body = url.includes("/api/models/capabilities") ? imageCaps : [];
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function png(name: string, bytes = 3): File {
	return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

/** A DataTransfer-like carrier: jsdom ships no DataTransfer constructor. */
function carrying(files: File[]) {
	return { files: Object.assign([...files], { item: (i: number) => files[i] }), types: ["Files"] };
}

function renderComposer(props: Record<string, unknown> = {}) {
	const onsubmit = vi.fn();
	const view = render(ChatInput, { onsubmit, selectedModel: model, ...props });
	const textarea = view.getByRole("combobox") as HTMLTextAreaElement;
	const dropZone = view.getByRole("group", { name: "Chat input with file drop zone" });
	return { ...view, onsubmit, textarea, dropZone };
}

describe("ChatInput IME composition", () => {
	// Regression: Enter that confirms an IME candidate (Japanese, Chinese,
	// Korean input) sent the half-composed message.
	test("Enter while composing confirms the candidate and does not send", async () => {
		const { onsubmit, textarea } = renderComposer();
		await fireEvent.compositionStart(textarea);
		await fireEvent.input(textarea, { target: { value: "こんにちは" } });
		await fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
		expect(onsubmit).not.toHaveBeenCalled();

		await fireEvent.compositionEnd(textarea);
		await fireEvent.keyDown(textarea, { key: "Enter" });
		expect(onsubmit).toHaveBeenCalledWith("こんにちは", undefined);
	});

	test("Safari's post-composition Enter (keyCode 229) does not send", async () => {
		const { onsubmit, textarea } = renderComposer();
		await fireEvent.input(textarea, { target: { value: "你好" } });
		await fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
		expect(onsubmit).not.toHaveBeenCalled();
	});
});

describe("ChatInput attachment staging", () => {
	test("pasting screenshots stages up to the model's limit and names the rest", async () => {
		const { textarea, getAllByTestId, getByTestId } = renderComposer();
		await waitFor(async () => {
			await fireEvent.paste(textarea, { clipboardData: carrying([png("a.png"), png("b.png"), png("c.png")]) });
			expect(getAllByTestId("attachment-chip")).toHaveLength(2);
		});
		expect(getByTestId("attachment-error")).toHaveTextContent("c.png (max 2 files per message)");
	});

	test("a text paste is left to the textarea", async () => {
		const { textarea, queryAllByTestId } = renderComposer();
		const event = await fireEvent.paste(textarea, { clipboardData: { files: [], types: ["text/plain"] } });
		expect(event).toBe(true); // not default-prevented
		expect(queryAllByTestId("attachment-chip")).toHaveLength(0);
	});

	test("dropping an oversized or unsupported file explains why it was refused", async () => {
		const { dropZone, getByTestId, queryAllByTestId } = renderComposer();
		const pdf = new File([new Uint8Array(3)], "doc.pdf", { type: "application/pdf" });
		await waitFor(async () => {
			await fireEvent.drop(dropZone, { dataTransfer: carrying([png("huge.png", 4096), pdf]) });
			expect(getByTestId("attachment-error")).toHaveTextContent('"huge.png" exceeds the 0MB per-file limit.');
		});
		expect(getByTestId("attachment-error")).toHaveTextContent("doesn't accept application/pdf");
		expect(queryAllByTestId("attachment-chip")).toHaveLength(0);
	});

	test("dragging over highlights the drop zone until the drag leaves", async () => {
		const { dropZone } = renderComposer();
		await waitFor(async () => {
			await fireEvent.dragOver(dropZone, { dataTransfer: carrying([png("a.png")]) });
			expect(dropZone).toHaveClass("chat-input-box--dragging");
		});
		await fireEvent.dragLeave(dropZone);
		expect(dropZone).not.toHaveClass("chat-input-box--dragging");
	});

	test("dropping a file before a model is picked asks for a model first", async () => {
		const { dropZone, getByTestId } = renderComposer({ selectedModel: null });
		await fireEvent.drop(dropZone, { dataTransfer: carrying([png("a.png")]) });
		expect(getByTestId("attachment-error")).toHaveTextContent(
			"No model selected — pick one before attaching files.",
		);
	});
});
