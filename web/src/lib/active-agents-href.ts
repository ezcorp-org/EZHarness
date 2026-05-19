/**
 * Href builder for the Active Agents list. Sub-agents (rows where
 * `parentConversationId` is set) link to their parent chat with a
 * `?agent=<subConversationId>` query param; the chat page picks that up
 * and opens the right-side AgentDetailPanel for the sub-agent. Top-level
 * agents link directly to their own conversation.
 *
 * Rows without a `projectId` fall back to the `global` project segment.
 */
export interface ActiveAgentHrefInput {
	conversationId: string;
	parentConversationId: string | null;
	projectId: string | null;
}

export function buildActiveAgentHref(row: ActiveAgentHrefInput): string {
	const targetConvId = row.parentConversationId ?? row.conversationId;
	const projectSegment = row.projectId ?? "global";
	const query = row.parentConversationId
		? `?agent=${encodeURIComponent(row.conversationId)}`
		: "";
	return `/project/${projectSegment}/chat/${targetConvId}${query}`;
}
