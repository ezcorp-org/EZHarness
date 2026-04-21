/**
 * Content blocks represent an ordered sequence of text, thinking, tool-call references,
 * and agent-call references within a single assistant message. This enables
 * interleaved rendering of text, tool cards, and agent chips in the chat UI.
 */

export interface TextBlock {
	type: "text";
	content: string;
}

export interface ThinkingBlock {
	type: "thinking";
	content: string;
}

export interface ToolRefBlock {
	type: "tool_ref";
	/** Index into the accompanying ToolCallState[] array */
	toolIndex: number;
}

export interface AgentRefBlock {
	type: "agent_ref";
	/** Index into the accompanying AgentCallState[] array */
	agentIndex: number;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolRefBlock | AgentRefBlock;

/**
 * Manages an ordered list of content blocks during streaming.
 * Text tokens are appended to the current text block; when a tool starts,
 * the current text block is finalized and a tool_ref is inserted.
 */
export class ContentBlockBuilder {
	blocks: ContentBlock[] = [];
	private nextToolIndex = 0;
	private nextAgentIndex = 0;
	private thinkingContent = "";

	/** Append streaming text to the current (or a new) text block. */
	appendText(text: string): void {
		const last = this.blocks[this.blocks.length - 1];
		if (last?.type === "text") {
			last.content += text;
		} else {
			this.blocks.push({ type: "text", content: text });
		}
	}

	/** Append streaming thinking content. */
	appendThinking(text: string): void {
		this.thinkingContent += text;
	}

	/** Insert a tool_ref block (called on tool:start). Returns the tool index. */
	pushToolRef(): number {
		const idx = this.nextToolIndex++;
		this.blocks.push({ type: "tool_ref", toolIndex: idx });
		return idx;
	}

	/** Insert an agent_ref block (called on agent:spawn). Returns the agent index. */
	pushAgentRef(): number {
		const idx = this.nextAgentIndex++;
		this.blocks.push({ type: "agent_ref", agentIndex: idx });
		return idx;
	}

	/** Reset for a new turn (after turn_text_reset). */
	reset(): void {
		this.blocks = [];
		this.nextToolIndex = 0;
		this.nextAgentIndex = 0;
		this.thinkingContent = "";
	}

	/** Get a snapshot of the current blocks. */
	snapshot(): ContentBlock[] {
		const result: ContentBlock[] = [];
		if (this.thinkingContent) {
			result.push({ type: "thinking", content: this.thinkingContent });
		}
		for (const b of this.blocks) {
			result.push(b.type === "text" ? { ...b } : { ...b });
		}
		return result;
	}
}

/**
 * Build content blocks from a saved message's text content and its
 * ordered list of tool calls and agent calls. Since we don't store block
 * positions in the DB, we reconstruct: thinking first, then text, then tool_refs, then agent_refs.
 */
export function buildHistoricalBlocks(
	text: string,
	toolCallCount: number,
	agentCallCount: number = 0,
	thinkingContent?: string | null,
): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	if (thinkingContent) {
		blocks.push({ type: "thinking", content: thinkingContent });
	}
	if (text) {
		blocks.push({ type: "text", content: text });
	}
	for (let i = 0; i < toolCallCount; i++) {
		blocks.push({ type: "tool_ref", toolIndex: i });
	}
	for (let i = 0; i < agentCallCount; i++) {
		blocks.push({ type: "agent_ref", agentIndex: i });
	}
	return blocks;
}
