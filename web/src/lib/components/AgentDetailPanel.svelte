<script lang="ts">
	/**
	 * Agent sub-chat drawer. Phase 5 of the ChatThread parity refactor:
	 * the bespoke "Turn N / Response" feed + `DetailMessage` +  5s poll +
	 * `PanelChatInput` were replaced by the shared
	 * `<ChatThread variant="panel">` so the sub-chat has FULL main-chat
	 * parity — hover toolbar (Copy / shift-rich-Copy / Retry / Regenerate
	 * / Re-run / Edit / Edit-text / Branch / Exclude / Save-memory),
	 * branch message-tree with ‹/› nav, live SSE token streaming (no
	 * polling), and per-message endpoints that now accept the sub-conv's
	 * ROOT owner (Phases 1-2). The panel keeps only its own chrome:
	 * agent header (name / status / task / stats).
	 *
	 * Model picker: ChatThread's composer owns model selection;
	 * `persistModel` is injected as `updateConversation(subConvId, …)` so
	 * a pick is written to the sub-conv row (the server-side
	 * `subConv.model` fallback drains it on the next idle agent-chat
	 * send and queued auto-continue runs reuse it). The pre-Phase-5
	 * standalone left-aligned ModelSelector is gone — its job (seed from
	 * the agent's last model, persist to the row) is now ChatThread's
	 * load + persistModel path, with zero behaviour loss.
	 */
	import type { AgentCallState } from "$lib/stores.svelte.js";
	import { store } from "$lib/stores.svelte.js";
	import SwipeDrawer from "./SwipeDrawer.svelte";
	import { agentColor } from "$lib/agent-color.js";
	import ChatThread from "./ChatThread.svelte";
	import { updateConversation } from "$lib/api.js";
	import { page } from "$app/state";

	let {
		agent,
		open = false,
		onclose,
	}: {
		agent: AgentCallState;
		open: boolean;
		onclose: () => void;
	} = $props();

	let color = $derived(agentColor(agent.agentName));

	// Currently-processing badge — streaming state OR a running task
	// assignment on this sub-conversation (runs started via agent-chat).
	let isProcessing = $derived.by(() => {
		if (agent.status === "running") return true;
		for (const snapshot of Object.values(store.taskSnapshots)) {
			for (const task of snapshot.tasks) {
				for (const a of task.assignments) {
					if (
						a.subConversationId === agent.subConversationId &&
						a.status === "running"
					)
						return true;
				}
			}
		}
		return false;
	});

	// Active project id for ChatThread (file mentions etc.). The sub-chat
	// runs inside the same project as the parent route.
	let projectId = $derived(page.params.id ?? "global");
</script>

<SwipeDrawer
	{open}
	side="right"
	width="w-full md:w-[32rem]"
	{onclose}
	ariaLabel="Agent details"
>
	<div
		class="agent-detail-panel flex h-full flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
	>
		<!-- Header -->
		<div
			class="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3"
		>
			<div class="flex items-center gap-2">
				<span
					class="h-2.5 w-2.5 rounded-full"
					style:background-color={color}
				></span>
				<h2
					class="text-sm font-semibold text-[var(--color-text-primary)]"
				>
					@{agent.agentName}
				</h2>
				{#if isProcessing}
					<span
						class="rounded-full bg-blue-500/20 px-2 py-0.5 text-[10px] text-blue-400"
						>Running</span
					>
				{:else if agent.status === "complete"}
					<span
						class="rounded-full bg-green-500/20 px-2 py-0.5 text-[10px] text-green-400"
						>Complete</span
					>
				{:else if agent.status === "error"}
					<span
						class="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] text-red-400"
						>Failed</span
					>
				{:else}
					<span
						class="rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
						>Idle</span
					>
				{/if}
			</div>
			<button
				type="button"
				onclick={onclose}
				aria-label="Close"
				class="rounded p-1 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
			>
				<svg
					class="h-4 w-4"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M6 18L18 6M6 6l12 12"
					/>
				</svg>
			</button>
		</div>

		<!-- Task bar -->
		{#if agent.task}
			<div class="border-b border-[var(--color-border)] px-4 py-2">
				<div
					class="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]"
				>
					Task
				</div>
				<p class="mt-1 text-xs text-[var(--color-text-secondary)]">
					{agent.task}
				</p>
			</div>
		{/if}

		<!-- Shared thread: full main-chat parity, panel chrome. -->
		{#if agent.subConversationId}
			<ChatThread
				conversationId={agent.subConversationId}
				{projectId}
				variant="panel"
				refreshEventName="agent:complete"
				persistModel={(provider, model) => {
					if (!agent.subConversationId) return;
					// Same call the main chat page makes — persists the
					// pick on the sub-conv row so the next idle
					// agent-chat send picks it up via the server-side
					// `subConv.model` fallback and queued auto-continue
					// runs drain on it.
					updateConversation(agent.subConversationId, {
						provider,
						model,
					}).catch(() => {});
				}}
			/>
		{/if}
	</div>
</SwipeDrawer>
