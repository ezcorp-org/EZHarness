import type { AgentCallState, AssignmentStatus } from "./stores.svelte.js";

/**
 * Row shape for a sub-conversation loaded from the DB (via
 * `/api/conversations/:id/messages?withToolCalls=true`). Mirrors the
 * client-side projection used by the chat page.
 */
export interface SubConvoRecord {
	id: string;
	agentName: string;
	agentConfigId: string;
	parentMessageId: string;
	messageCount?: number;
	lastMessagePreview?: string | null;
}

/** Assignment status lookup from the task-tracking snapshot. */
export interface SubConvoAssignment {
	status: AssignmentStatus;
	resultPreview?: string;
}

/**
 * Synthesize an `AgentCallState` from a DB-loaded sub-conversation. Used by
 * the chat page to render `AgentDetailPanel` for historical sub-agents and
 * for sub-agents opened via the Active Agents list (`?agent=<subConvId>`
 * deep link) where no live streaming state is in memory yet.
 *
 * When a task-tracking assignment is supplied, its status is authoritative;
 * otherwise we infer status from message presence (no messages → the agent
 * didn't respond).
 */
export function subConvoToAgentCallState(
	sc: SubConvoRecord,
	assignment?: SubConvoAssignment,
): AgentCallState {
	// Auto-spin-up stores only the assistant response (messageCount=1);
	// invoke_agent stores user task + assistant response (messageCount>=2).
	// Any messages at all means the agent produced something.
	const hasResponse = (sc.messageCount ?? 0) >= 1;

	let status: AgentCallState["status"];
	let resultPreview: string | undefined;
	if (assignment) {
		status =
			assignment.status === "failed"
				? "error"
				: assignment.status === "running"
					? "running"
					: "complete";
		resultPreview = assignment.resultPreview ?? (sc.lastMessagePreview ?? undefined);
	} else {
		status = hasResponse ? "complete" : "error";
		resultPreview = hasResponse
			? (sc.lastMessagePreview ?? undefined)
			: "Agent did not respond";
	}

	return {
		subConversationId: sc.id,
		agentName: sc.agentName,
		agentConfigId: sc.agentConfigId,
		task: "",
		status,
		resultPreview,
		startedAt: 0,
	};
}
