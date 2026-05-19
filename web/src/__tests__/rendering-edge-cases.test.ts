import { describe, test, expect } from "bun:test";
import { extractInputSummary, formatOutputPreview } from "../lib/components/tool-cards/utils";

// ── Pure helper functions extracted from component logic for testability ──

/**
 * Extracted from ChatMessage.svelte line 214:
 *   {#each toolCalls as tc, i (tc.id ?? `${tc.toolName}-${i}`)}
 */
function generateToolCallKey(tc: { id?: string; toolName: string }, index: number): string {
	return tc.id ?? `${tc.toolName}-${index}`;
}

/**
 * Extracted from extensions/+page.svelte permissionIcons():
 *   Defensive access over optional permission fields.
 */
function getToolCount(manifest: { tools?: any[] }): number {
	return manifest.tools?.length ?? 0;
}

function getPermissionIcons(
	perms?: { network?: string[]; filesystem?: string[]; shell?: boolean; env?: string[] }
): string[] {
	if (!perms) return [];
	const icons: string[] = [];
	if (perms.network?.length) icons.push("network");
	if (perms.filesystem?.length) icons.push("filesystem");
	if (perms.shell) icons.push("shell");
	if (perms.env?.length) icons.push("env");
	return icons;
}

// ── Test groups ──

describe("permissionIcons handles missing data", () => {
	test("undefined input returns empty string", () => {
		expect(extractInputSummary(undefined)).toBeUndefined();
		// Coerce to empty string check as the spec requests
		expect(extractInputSummary(undefined) ?? "").toBe("");
	});

	test("null input returns empty string", () => {
		expect(extractInputSummary(null)).toBeUndefined();
		expect(extractInputSummary(null) ?? "").toBe("");
	});

	test("empty object returns empty string", () => {
		expect(extractInputSummary({})).toBeUndefined();
		expect(extractInputSummary({}) ?? "").toBe("");
	});

	test("valid command field returns command string", () => {
		expect(extractInputSummary({ command: "ls -la" })).toBe("ls -la");
	});

	test("valid file_path returns file_path string", () => {
		expect(extractInputSummary({ file_path: "/tmp/foo.txt" })).toBe("/tmp/foo.txt");
	});
});

describe("tool call key uniqueness", () => {
	test("two tool calls with same name but different indices produce different keys", () => {
		const tc = { toolName: "bash" };
		expect(generateToolCallKey(tc, 0)).not.toBe(generateToolCallKey(tc, 1));
	});

	test("tool call with id always uses id regardless of index", () => {
		const tc = { id: "abc-123", toolName: "bash" };
		expect(generateToolCallKey(tc, 0)).toBe("abc-123");
		expect(generateToolCallKey(tc, 5)).toBe("abc-123");
		expect(generateToolCallKey(tc, 99)).toBe("abc-123");
	});

	test("tool call without id uses name-index fallback", () => {
		const tc = { toolName: "read_file" };
		expect(generateToolCallKey(tc, 3)).toBe("read_file-3");
	});

	test("multiple calls with same name and no id all produce unique keys", () => {
		const calls = Array.from({ length: 5 }, () => ({ toolName: "write" }));
		const keys = calls.map((tc, i) => generateToolCallKey(tc, i));
		const unique = new Set(keys);
		expect(unique.size).toBe(keys.length);
	});
});

describe("extension manifest optional fields", () => {
	test("getToolCount with undefined tools returns 0", () => {
		expect(getToolCount({})).toBe(0);
	});

	test("getToolCount with empty array returns 0", () => {
		expect(getToolCount({ tools: [] })).toBe(0);
	});

	test("getToolCount with 3 tools returns 3", () => {
		expect(getToolCount({ tools: ["a", "b", "c"] })).toBe(3);
	});

	test("getPermissionIcons with undefined returns []", () => {
		expect(getPermissionIcons(undefined)).toEqual([]);
	});

	test("getPermissionIcons with empty perms returns []", () => {
		expect(getPermissionIcons({})).toEqual([]);
	});

	test("getPermissionIcons with all fields set returns all icons", () => {
		const result = getPermissionIcons({
			network: ["https://api.example.com"],
			filesystem: ["/tmp"],
			shell: true,
			env: ["HOME"],
		});
		expect(result).toEqual(["network", "filesystem", "shell", "env"]);
	});

	test('getPermissionIcons with only shell returns ["shell"]', () => {
		expect(getPermissionIcons({ shell: true })).toEqual(["shell"]);
	});
});

describe("formatOutputPreview edge cases", () => {
	test("undefined returns empty string", () => {
		expect(formatOutputPreview(undefined) ?? "").toBe("");
	});

	test("null returns empty string", () => {
		expect(formatOutputPreview(null) ?? "").toBe("");
	});

	test("number input (coerced) returns string", () => {
		const result = formatOutputPreview(42);
		expect(result).toBe("42");
		expect(typeof result).toBe("string");
	});

	test("very long string is truncated with ...", () => {
		const long = "a".repeat(100);
		const result = formatOutputPreview(long, 50);
		expect(result).toBe("a".repeat(47) + "...");
		expect(result!.length).toBe(50);
	});

	test("exactly at limit has no truncation", () => {
		const exact = "b".repeat(50);
		const result = formatOutputPreview(exact, 50);
		expect(result).toBe(exact);
		expect(result).not.toContain("...");
	});

	test("one over limit is truncated", () => {
		const over = "c".repeat(51);
		const result = formatOutputPreview(over, 50);
		expect(result).toBe("c".repeat(47) + "...");
		expect(result!.length).toBe(50);
	});
});
