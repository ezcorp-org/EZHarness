/**
 * Pure-logic module for routing sub-agent events back to the user-visible
 * (root) run that the UI is watching.
 *
 * Background
 * ----------
 * When a sub-agent is invoked (via `invoke_agent`), it runs in its own
 * sub-conversation with its own run id. Tool-related events ( notably
 * `tool:permission_request`) emitted by the sub-agent carry the
 * SUB-conversation id, not the parent. If the UI only knows about root
 * conversations (the ones the user actively started), those events are
 * silently dropped — the permission prompt never renders and the sub-agent
 * blocks forever waiting for approval.
 *
 * This module owns two maps that bridge the gap:
 *   - subConvToRootRun[subConversationId] = rootRunId
 *   - agentRunToRootRun[agentRunId]       = rootRunId
 *
 * `registerSpawn` populates both on every `agent:spawn` event, inheriting
 * the root from the parent run (directly if the parent is a root, or via
 * `agentRunToRootRun` for deeply nested spawns). `unregisterSpawn` cleans
 * them up on `agent:complete`. `resolveRunForConversation` is used by event
 * handlers to find the root run for any conversationId — root or sub.
 *
 * The module is kept pure (no Svelte runes, no side effects) so it can be
 * exhaustively unit-tested without a browser or Svelte runtime. The
 * Svelte store calls these functions and assigns the returned `RoutingState`
 * back to `$state`-backed properties for reactivity.
 */

export interface RoutingState {
	/** runId → conversationId for root (user-started) runs. */
	streamingRunToConversation: Record<string, string>;
	/** subConversationId → rootRunId for every active sub-agent. */
	subConvToRootRun: Record<string, string>;
	/** agentRunId → rootRunId for every active sub-agent run. */
	agentRunToRootRun: Record<string, string>;
}

export interface AgentSpawnEvent {
	/** The PARENT run id spawning the agent (may be a root or another agentRunId). */
	runId: string;
	/** The NEW run id allocated for the spawned agent. */
	agentRunId: string;
	/** The conversation the spawned agent will run in. */
	subConversationId: string;
}

export interface AgentCompleteEvent {
	subConversationId: string;
	agentRunId?: string;
}

/** Fresh, empty routing state with independent map references. */
export function emptyRoutingState(): RoutingState {
	return {
		streamingRunToConversation: {},
		subConvToRootRun: {},
		agentRunToRootRun: {},
	};
}

/**
 * Reverse lookup: find the runId whose root conversation matches `conversationId`.
 * Only considers root streams — not sub-agent conversations.
 */
export function getActiveRunIdForConversation(
	state: RoutingState,
	conversationId: string,
): string | undefined {
	for (const [runId, convId] of Object.entries(state.streamingRunToConversation)) {
		if (convId === conversationId) return runId;
	}
	return undefined;
}

/**
 * Resolve a conversationId (root or sub) to the user-visible root runId.
 * Direct root lookup wins over sub-conversation fallback if the same id
 * appears in both — this matches the intent that root streams are
 * authoritative.
 */
export function resolveRunForConversation(
	state: RoutingState,
	conversationId: string,
): string | undefined {
	const direct = getActiveRunIdForConversation(state, conversationId);
	if (direct) return direct;
	return state.subConvToRootRun[conversationId];
}

/**
 * Register an `agent:spawn` event. Resolves the root run from the parent
 * runId (directly for top-level spawns, or via `agentRunToRootRun` for
 * nested spawns) and records both `subConversationId → rootRunId` and
 * `agentRunId → rootRunId`.
 *
 * If the parent runId cannot be resolved to a root, the state is returned
 * unchanged (same reference) — this is a defensive no-op rather than an
 * orphan entry, since rendering a permission prompt against an unknown
 * root would confuse the user.
 */
export function registerSpawn(
	state: RoutingState,
	event: AgentSpawnEvent,
): RoutingState {
	const { runId, agentRunId, subConversationId } = event;
	const rootRunId = state.streamingRunToConversation[runId]
		? runId
		: state.agentRunToRootRun[runId];
	if (!rootRunId) return state;
	return {
		streamingRunToConversation: state.streamingRunToConversation,
		subConvToRootRun: { ...state.subConvToRootRun, [subConversationId]: rootRunId },
		agentRunToRootRun: { ...state.agentRunToRootRun, [agentRunId]: rootRunId },
	};
}

/**
 * Remove the mappings for an `agent:complete` event. No-op if neither entry
 * is present. Does not mutate the input state.
 */
export function unregisterSpawn(
	state: RoutingState,
	event: AgentCompleteEvent,
): RoutingState {
	const { subConversationId, agentRunId } = event;
	const hasSub = subConversationId in state.subConvToRootRun;
	const hasAgent = agentRunId !== undefined && agentRunId in state.agentRunToRootRun;
	if (!hasSub && !hasAgent) return state;

	let nextSubConv = state.subConvToRootRun;
	if (hasSub) {
		const { [subConversationId]: _removed, ...rest } = state.subConvToRootRun;
		void _removed;
		nextSubConv = rest;
	}

	let nextAgentRun = state.agentRunToRootRun;
	if (hasAgent && agentRunId !== undefined) {
		const { [agentRunId]: _removed, ...rest } = state.agentRunToRootRun;
		void _removed;
		nextAgentRun = rest;
	}

	return {
		streamingRunToConversation: state.streamingRunToConversation,
		subConvToRootRun: nextSubConv,
		agentRunToRootRun: nextAgentRun,
	};
}
