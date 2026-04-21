import { test, expect, describe } from "bun:test";

// Pure logic extracted from ExportMenu.svelte and api.ts exportConversation

type ExportFormat = "markdown" | "json";

/** Build the export API URL for a conversation. */
function buildExportUrl(conversationId: string, format: ExportFormat, leafMessageId?: string): string {
	const params = new URLSearchParams({ format });
	if (leafMessageId) params.set("leafMessageId", leafMessageId);
	return `/api/conversations/${conversationId}/export?${params}`;
}

/** Derive filename from Content-Disposition header or fall back to default. */
function deriveFilename(disposition: string, format: ExportFormat): string {
	const match = disposition.match(/filename="(.+?)"/);
	return match?.[1] ?? `conversation.${format === "json" ? "json" : "md"}`;
}

/** The two supported export format options. */
const EXPORT_FORMATS: ExportFormat[] = ["markdown", "json"];

// ── export format options ────────────────────────────────────────────

describe("export format options", () => {
	test("there are exactly 2 export formats", () => {
		expect(EXPORT_FORMATS.length).toBe(2);
	});

	test("markdown is a valid format", () => {
		expect(EXPORT_FORMATS).toContain("markdown");
	});

	test("json is a valid format", () => {
		expect(EXPORT_FORMATS).toContain("json");
	});
});

// ── buildExportUrl ───────────────────────────────────────────────────

describe("buildExportUrl", () => {
	test("includes conversationId in path", () => {
		const url = buildExportUrl("conv-abc", "markdown");
		expect(url).toContain("/api/conversations/conv-abc/export");
	});

	test("includes format=markdown param", () => {
		const url = buildExportUrl("conv-abc", "markdown");
		expect(url).toContain("format=markdown");
	});

	test("includes format=json param", () => {
		const url = buildExportUrl("conv-abc", "json");
		expect(url).toContain("format=json");
	});

	test("omits leafMessageId when not provided", () => {
		const url = buildExportUrl("conv-abc", "json");
		expect(url).not.toContain("leafMessageId");
	});

	test("includes leafMessageId when provided", () => {
		const url = buildExportUrl("conv-abc", "json", "msg-xyz");
		expect(url).toContain("leafMessageId=msg-xyz");
	});

	test("both format and leafMessageId appear in URL together", () => {
		const url = buildExportUrl("conv-123", "markdown", "msg-456");
		expect(url).toContain("format=markdown");
		expect(url).toContain("leafMessageId=msg-456");
	});
});

// ── deriveFilename ───────────────────────────────────────────────────

describe("deriveFilename", () => {
	test("extracts filename from Content-Disposition header", () => {
		const filename = deriveFilename('attachment; filename="my-chat.md"', "markdown");
		expect(filename).toBe("my-chat.md");
	});

	test("extracts json filename from header", () => {
		const filename = deriveFilename('attachment; filename="export-2024.json"', "json");
		expect(filename).toBe("export-2024.json");
	});

	test("falls back to conversation.md for markdown when no header match", () => {
		expect(deriveFilename("", "markdown")).toBe("conversation.md");
	});

	test("falls back to conversation.json for json when no header match", () => {
		expect(deriveFilename("", "json")).toBe("conversation.json");
	});

	test("falls back to conversation.md when disposition has no filename", () => {
		expect(deriveFilename("attachment", "markdown")).toBe("conversation.md");
	});

	test("extracts filename with spaces", () => {
		const filename = deriveFilename('inline; filename="my conversation export.md"', "markdown");
		expect(filename).toBe("my conversation export.md");
	});
});
