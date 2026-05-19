import { test, expect, describe } from "bun:test";
import {
	prettyBytes,
	iconForKind,
	attachmentUrl,
	attachmentDownloadUrl,
} from "$lib/components/attachment-card-logic.js";

describe("prettyBytes", () => {
	test("renders bytes under 1KB", () => {
		expect(prettyBytes(0)).toBe("0 B");
		expect(prettyBytes(512)).toBe("512 B");
	});

	test("renders KB with one decimal", () => {
		expect(prettyBytes(1024)).toBe("1.0 KB");
		expect(prettyBytes(2048)).toBe("2.0 KB");
		expect(prettyBytes(1536)).toBe("1.5 KB");
	});

	test("renders MB with one decimal", () => {
		expect(prettyBytes(1024 * 1024)).toBe("1.0 MB");
		expect(prettyBytes(10 * 1024 * 1024)).toBe("10.0 MB");
	});

	test("renders GB with two decimals", () => {
		expect(prettyBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
		expect(prettyBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
	});
});

describe("iconForKind", () => {
	test("maps known kinds", () => {
		expect(iconForKind("pdf")).toBe("📄");
		expect(iconForKind("audio")).toBe("🎵");
		expect(iconForKind("text")).toBe("📝");
	});

	test("maps image to picture frame", () => {
		expect(iconForKind("image")).toBe("🖼️");
	});
});

describe("attachment URL helpers", () => {
	test("attachmentUrl uses the id", () => {
		expect(attachmentUrl("abc-123")).toBe("/api/attachments/abc-123");
	});

	test("attachmentDownloadUrl appends ?download=1", () => {
		expect(attachmentDownloadUrl("abc-123")).toBe("/api/attachments/abc-123?download=1");
	});
});
