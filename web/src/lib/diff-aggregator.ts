import { isDiffBlock } from "./markdown";

export interface ExtractedDiff {
	messageId: string;
	content: string;
	fileName?: string;
}

export interface ToolCallDiffGroup {
	filePath: string;
	toolName: string;
	diffs: string[];
}

const FENCED_BLOCK_RE = /```(\w*)\n([\s\S]*?)```/g;
const DIFF_FILENAME_RE = /\+\+\+ b\/(.+)/;

/**
 * Extract diff code blocks from markdown message content.
 * Returns them in order of appearance.
 */
export function extractDiffBlocks(messageContent: string, messageId: string): ExtractedDiff[] {
	const results: ExtractedDiff[] = [];
	let match: RegExpExecArray | null;

	while ((match = FENCED_BLOCK_RE.exec(messageContent)) !== null) {
		const lang = match[1] || undefined;
		const text = match[2].trimEnd();

		if (!isDiffBlock(text, lang)) continue;

		const fileMatch = text.match(DIFF_FILENAME_RE);
		results.push({
			messageId,
			content: text,
			fileName: fileMatch?.[1],
		});
	}

	return results;
}

/** Known file-path fields in tool call inputs */
function getFilePath(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const obj = input as Record<string, unknown>;
	const p = obj.file_path ?? obj.path;
	return typeof p === "string" ? p : undefined;
}

/** Check if a tool call input contains edit-related fields */
function hasEditFields(input: unknown): boolean {
	if (!input || typeof input !== "object") return false;
	const obj = input as Record<string, unknown>;
	return "new_string" in obj || "old_string" in obj || "content" in obj;
}

/** Build a unified diff string from an edit tool call */
function formatEditDiff(input: Record<string, unknown>): string {
	const filePath = String(input.file_path ?? input.path ?? "unknown");
	const oldStr = String(input.old_string ?? "");
	const newStr = String(input.new_string ?? input.content ?? "");
	const oldLines = oldStr ? oldStr.split("\n") : [];
	const newLines = newStr ? newStr.split("\n") : [];
	const hunk = `@@ -1,${oldLines.length || 1} +1,${newLines.length || 1} @@`;
	const removed = oldLines.map((l) => `-${l}`).join("\n");
	const added = newLines.map((l) => `+${l}`).join("\n");
	return `--- a/${filePath}\n+++ b/${filePath}\n${hunk}\n${removed}\n${added}`;
}

/**
 * Aggregate tool call diffs grouped by file path.
 * Inspects input for file_path/path fields, skips unrecognized formats.
 */
export function aggregateToolCallDiffs(
	toolCalls: Array<{ toolName: string; input?: unknown; output?: unknown }>
): ToolCallDiffGroup[] {
	const groups = new Map<string, ToolCallDiffGroup>();

	for (const tc of toolCalls) {
		const filePath = getFilePath(tc.input);
		if (!filePath) continue;
		if (!hasEditFields(tc.input)) continue;

		const diff = formatEditDiff(tc.input as Record<string, unknown>);

		let group = groups.get(filePath);
		if (!group) {
			group = { filePath, toolName: tc.toolName, diffs: [] };
			groups.set(filePath, group);
		}
		group.diffs.push(diff);
	}

	return Array.from(groups.values());
}
