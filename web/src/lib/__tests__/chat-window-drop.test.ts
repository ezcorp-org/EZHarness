import { test, expect, describe } from "bun:test";
import {
	shouldHandleChatWindowDragOver,
	filesFromChatWindowDrop,
} from "../chat/chat-window-drop";

function makeFileList(files: File[]): FileList {
	// Minimal FileList-like: length + index access + iteration. The helpers
	// only touch `.length` and array-like indexing, so this is sufficient.
	const list = {
		length: files.length,
		item(i: number) {
			return files[i] ?? null;
		},
		[Symbol.iterator]: function* () {
			for (const f of files) yield f;
		},
	} as unknown as FileList;
	for (let i = 0; i < files.length; i++) {
		(list as unknown as Record<number, File>)[i] = files[i]!;
	}
	return list;
}

function makeDataTransfer(opts: {
	types?: string[];
	files?: File[];
} = {}): DataTransfer {
	return {
		types: opts.types ?? [],
		files: makeFileList(opts.files ?? []),
	} as unknown as DataTransfer;
}

function makeFile(name: string, type = "image/png", size = 4): File {
	return new File([new Uint8Array(size)], name, { type });
}

describe("shouldHandleChatWindowDragOver", () => {
	test("returns true when stager wired and Files in types", () => {
		const dt = makeDataTransfer({ types: ["Files"] });
		expect(shouldHandleChatWindowDragOver(dt, true)).toBe(true);
	});

	test("returns false without a stager (ChatInput not mounted)", () => {
		const dt = makeDataTransfer({ types: ["Files"] });
		expect(shouldHandleChatWindowDragOver(dt, false)).toBe(false);
	});

	test("returns false when dataTransfer is null", () => {
		expect(shouldHandleChatWindowDragOver(null, true)).toBe(false);
	});

	test("returns false when types does not include Files (plain text drag)", () => {
		const dt = makeDataTransfer({ types: ["text/plain", "text/html"] });
		expect(shouldHandleChatWindowDragOver(dt, true)).toBe(false);
	});

	test("returns false when types is empty", () => {
		const dt = makeDataTransfer({ types: [] });
		expect(shouldHandleChatWindowDragOver(dt, true)).toBe(false);
	});

	test("handles DOMStringList-like types without Array#includes", () => {
		const types = {
			length: 1,
			0: "Files",
		} as unknown as ReadonlyArray<string>;
		const dt = { types, files: makeFileList([]) } as unknown as DataTransfer;
		expect(shouldHandleChatWindowDragOver(dt, true)).toBe(true);
	});
});

describe("filesFromChatWindowDrop", () => {
	test("returns the FileList when stager wired and files present", () => {
		const f = makeFile("cat.png");
		const dt = makeDataTransfer({ files: [f] });
		const out = filesFromChatWindowDrop(dt, true);
		expect(out).not.toBeNull();
		expect(out!.length).toBe(1);
		expect(out![0]!.name).toBe("cat.png");
	});

	test("returns null without a stager", () => {
		const dt = makeDataTransfer({ files: [makeFile("a.png")] });
		expect(filesFromChatWindowDrop(dt, false)).toBeNull();
	});

	test("returns null when dataTransfer is null", () => {
		expect(filesFromChatWindowDrop(null, true)).toBeNull();
	});

	test("returns null when files list is empty", () => {
		const dt = makeDataTransfer({ files: [] });
		expect(filesFromChatWindowDrop(dt, true)).toBeNull();
	});

	test("returns all dropped files in order (multi-file drop)", () => {
		const a = makeFile("a.png");
		const b = makeFile("b.pdf", "application/pdf");
		const out = filesFromChatWindowDrop(makeDataTransfer({ files: [a, b] }), true);
		expect(out).not.toBeNull();
		expect(out!.length).toBe(2);
		expect(out![0]!.name).toBe("a.png");
		expect(out![1]!.name).toBe("b.pdf");
	});
});
