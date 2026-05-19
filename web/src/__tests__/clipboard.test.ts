import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { copyToClipboard } from "../lib/clipboard";

// Mock DOM APIs for bun:test (no browser)
let mockWriteText: ReturnType<typeof mock>;
let mockExecCommand: ReturnType<typeof mock>;
let mockCreateElement: ReturnType<typeof mock>;

const fakeTextarea = {
	value: '',
	style: {} as Record<string, string>,
	select: mock(() => {}),
};

beforeEach(() => {
	mockWriteText = mock(async () => {});
	mockExecCommand = mock(() => true);
	mockCreateElement = mock(() => fakeTextarea);
	fakeTextarea.value = '';

	// Bun's Mock<…> is structurally narrower than the DOM globals (Clipboard,
	// Node.appendChild, etc); cast through `unknown` so the stubs satisfy the
	// global shapes without needing `@ts-expect-error`.
	globalThis.navigator = {
		clipboard: { writeText: mockWriteText } as unknown as Clipboard,
	} as unknown as Navigator;
	globalThis.document = {
		createElement: mockCreateElement,
		body: {
			appendChild: mock(() => {}) as unknown as <T extends Node>(node: T) => T,
			removeChild: mock(() => {}) as unknown as <T extends Node>(child: T) => T,
		},
		execCommand: mockExecCommand,
	} as unknown as Document;
});

afterEach(() => {
	// @ts-expect-error
	delete globalThis.navigator;
	// @ts-expect-error
	delete globalThis.document;
});

describe("copyToClipboard", () => {
	test("uses navigator.clipboard.writeText when available", async () => {
		const ok = await copyToClipboard("hello");
		expect(ok).toBe(true);
		expect(mockWriteText).toHaveBeenCalledWith("hello");
	});

	test("falls back to execCommand when clipboard API fails", async () => {
		mockWriteText.mockRejectedValueOnce(new Error("denied"));
		const ok = await copyToClipboard("fallback text");
		expect(ok).toBe(true);
		expect(mockExecCommand).toHaveBeenCalledWith("copy");
		expect(fakeTextarea.value).toBe("fallback text");
	});

	test("falls back to execCommand when clipboard API missing", async () => {
		// @ts-expect-error
		globalThis.navigator = {};
		const ok = await copyToClipboard("no clipboard");
		expect(ok).toBe(true);
		expect(mockExecCommand).toHaveBeenCalledWith("copy");
	});

	test("returns false when both methods fail", async () => {
		mockWriteText.mockRejectedValueOnce(new Error("denied"));
		mockExecCommand.mockReturnValueOnce(false);
		const ok = await copyToClipboard("fail");
		expect(ok).toBe(false);
	});

	test("copies empty string", async () => {
		const ok = await copyToClipboard("");
		expect(ok).toBe(true);
		expect(mockWriteText).toHaveBeenCalledWith("");
	});

	test("copies multiline content", async () => {
		const text = "line 1\nline 2\nline 3";
		const ok = await copyToClipboard(text);
		expect(ok).toBe(true);
		expect(mockWriteText).toHaveBeenCalledWith(text);
	});

	test("copies JSON content", async () => {
		const json = JSON.stringify([{ id: "1", title: "Test" }], null, 2);
		const ok = await copyToClipboard(json);
		expect(ok).toBe(true);
		expect(mockWriteText).toHaveBeenCalledWith(json);
	});
});
