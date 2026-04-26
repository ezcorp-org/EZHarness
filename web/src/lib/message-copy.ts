/**
 * Formats a chat message + its tool calls into a plain-text block suitable
 * for clipboard copy. Used by `MessageToolbar`'s single-message copy and by
 * the multi-select bulk-copy action in the chat page so both share the same
 * format.
 *
 * Tool calls render as:
 *   [Tool: name]
 *   Input: <stringified input>
 *   Output: <stringified output>
 *
 * Empty parts (no content, no input, no output) are skipped so e.g. a
 * "tool-only" assistant turn doesn't produce a leading blank section.
 */

interface ToolCallLike {
	toolName: string;
	input?: unknown;
	output?: unknown;
}

export function formatMessageForCopy(
	content: string,
	toolCalls?: ToolCallLike[],
): string {
	const parts: string[] = [];
	if (content) parts.push(content);
	if (toolCalls?.length) {
		for (const tc of toolCalls) {
			const header = `[Tool: ${tc.toolName}]`;
			const input = tc.input
				? `Input: ${typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input, null, 2)}`
				: "";
			const output = tc.output
				? `Output: ${typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output, null, 2)}`
				: "";
			parts.push([header, input, output].filter(Boolean).join("\n"));
		}
	}
	return parts.join("\n\n");
}
