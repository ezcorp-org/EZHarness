<script lang="ts">
	import { tick } from "svelte";
	import type { AgentCallState } from "$lib/stores.svelte.js";
	import { store } from "$lib/stores.svelte.js";
	import SwipeDrawer from "./SwipeDrawer.svelte";
	import { agentColor } from "$lib/agent-color.js";
	import MarkdownRenderer from "./MarkdownRenderer.svelte";
	import { timeAgo, timeDelta } from "$lib/format-duration.js";
	import { toolStatusIcon, toolStatusColor, formatInput } from "$lib/tool-display.js";
	import PanelChatInput from "./PanelChatInput.svelte";
	import { backgroundFetch, userFetch } from "$lib/utils/fetch-policy.js";

	let {
		agent,
		open = false,
		onclose,
	}: {
		agent: AgentCallState;
		open: boolean;
		onclose: () => void;
	} = $props();

	interface ToolCallInfo {
		id: string;
		toolName: string;
		input: Record<string, unknown> | null;
		outputSummary: string | null;
		success: boolean;
		durationMs: number;
		status: string;
	}

	interface DetailMessage {
		id: string;
		role: string;
		content: string;
		createdAt: string;
		toolCalls: ToolCallInfo[];
	}

	let color = $derived(agentColor(agent.agentName));

	// Check if this agent is currently processing — check both the streaming
	// AgentCallState AND the task snapshot (for runs started via agent-chat)
	let isProcessing = $derived.by(() => {
		if (agent.status === 'running') return true;
		// Check task snapshots for any assignment with this sub-conversation running
		for (const snapshot of Object.values(store.taskSnapshots)) {
			for (const task of snapshot.tasks) {
				for (const a of task.assignments) {
					if (a.subConversationId === agent.subConversationId && a.status === 'running') return true;
				}
			}
		}
		return false;
	});

	let rawMessages = $state<DetailMessage[]>([]);
	// Only assistant messages (skip the initial user/task message for turn display)
	let assistantMessages = $derived(rawMessages.filter(m => m.role === 'assistant'));
	let taskMessage = $derived(rawMessages.find(m => m.role === 'user'));
	let totalToolCalls = $derived(assistantMessages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0));
	let loading = $state(false);
	let loaded = $state(false);

	let scrollContainer: HTMLDivElement | undefined = $state();

	// Track which tool calls are expanded
	let expandedTools = $state(new Set<string>());
	function toggleTool(id: string) {
		const next = new Set(expandedTools);
		if (next.has(id)) next.delete(id); else next.add(id);
		expandedTools = next;
	}

	// Feed messages: all messages except the initial task (first user message)
	let feedMessages = $derived(rawMessages.filter((m, i) => !(i === 0 && m.role === 'user')));

	async function sendMessage(content: string) {
		if (!agent.subConversationId) throw new Error("No sub-conversation");
		const res = await userFetch(`/api/conversations/${agent.subConversationId}/agent-chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content }),
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({ error: 'Failed to send' }));
			throw new Error(err.error ?? 'Failed to send');
		}
		// Re-fetch messages and scroll to bottom
		loaded = false;
		await loadMessages();
		scrollToBottom();
	}

	let sentinel: HTMLDivElement | undefined = $state();

	function scrollToBottom(behavior: ScrollBehavior = 'instant') {
		tick().then(() => {
			requestAnimationFrame(() => {
				sentinel?.scrollIntoView({ behavior });
			});
		});
	}

	async function loadMessages() {
		if (loaded || loading || !agent.subConversationId) return;
		loading = true;
		try {
			// One-shot load on panel open — not spammed by reactive effects.
			// Routed through userFetch to document intent and to bypass the
			// background throttle so the panel actually hydrates when opened
			// within 4.5s of the last background refresh.
			const res = await userFetch(`/api/conversations/${agent.subConversationId}/messages?withToolCalls=true`);
			if (res.ok) {
				const data = await res.json();
				rawMessages = data.messages ?? data;
				loaded = true;
			}
		} catch { /* silent */ }
		loading = false;
	}

	// Reset when agent changes
	let prevAgentId = $state('');
	$effect(() => {
		if (agent.subConversationId !== prevAgentId) {
			prevAgentId = agent.subConversationId;
			rawMessages = [];
			loaded = false;
			initialScrollDone = false;
			expandedTools = new Set();
		}
		if (open && !loaded) loadMessages();
	});

	// Auto-scroll to bottom when messages first load
	let initialScrollDone = $state(false);
	$effect(() => {
		if (!open || !loaded || rawMessages.length === 0) return;
		if (initialScrollDone) return;
		initialScrollDone = true;
		scrollToBottom();
	});

	// Auto-refresh while agent is processing (poll every 5s like TeamChatPanel)
	$effect(() => {
		if (!open || !isProcessing) return;
		const interval = setInterval(async () => {
			if (!agent.subConversationId) return;
			try {
				const res = await backgroundFetch(
					`agent-detail:${agent.subConversationId}`,
					`/api/conversations/${agent.subConversationId}/messages?withToolCalls=true`,
					{},
					{ minIntervalMs: 4500 },
				);
				if (res && res.ok) {
					const data = await res.json();
					rawMessages = data.messages ?? data;
				}
			} catch { /* silent */ }
		}, 5000);
		return () => clearInterval(interval);
	});

	// Live-updating "time ago" ticker
	let now = $state(Date.now());
	$effect(() => {
		if (!open) return;
		const interval = setInterval(() => { now = Date.now(); }, 1000);
		return () => clearInterval(interval);
	});

</script>

<SwipeDrawer {open} side="right" width="w-full md:w-[32rem]" {onclose} ariaLabel="Agent details">
	<div class="agent-detail-panel flex h-full flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
		<!-- Header -->
		<div class="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
			<div class="flex items-center gap-2">
				<span class="h-2.5 w-2.5 rounded-full" style:background-color={color}></span>
				<h2 class="text-sm font-semibold text-[var(--color-text-primary)]">@{agent.agentName}</h2>
				{#if agent.status === 'running'}
					<span class="rounded-full bg-blue-500/20 px-2 py-0.5 text-[10px] text-blue-400">Running</span>
				{:else if agent.status === 'complete'}
					<span class="rounded-full bg-green-500/20 px-2 py-0.5 text-[10px] text-green-400">Complete</span>
				{:else}
					<span class="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] text-red-400">Failed</span>
				{/if}
			</div>
			<button
				onclick={onclose}
				class="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
			>
				<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>

		<!-- Task + Stats bar -->
		<div class="border-b border-[var(--color-border)] px-4 py-2">
			{#if agent.task}
				<div class="flex items-center justify-between">
					<div class="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">Task</div>
					{#if taskMessage?.createdAt}
						<span class="text-[10px] text-[var(--color-text-muted)] opacity-60" title={taskMessage.createdAt}>{timeAgo(taskMessage.createdAt, now)}</span>
					{/if}
				</div>
				<p class="mt-1 text-xs text-[var(--color-text-secondary)]">{agent.task}</p>
			{/if}
			{#if loaded && assistantMessages.length > 0}
				{@const firstTime = taskMessage?.createdAt ?? assistantMessages[0]?.createdAt}
				{@const lastTime = assistantMessages[assistantMessages.length - 1]?.createdAt}
				<div class="mt-2 flex gap-3 text-[10px] text-[var(--color-text-muted)]">
					<span>{assistantMessages.length} turn{assistantMessages.length !== 1 ? 's' : ''}</span>
					<span>{totalToolCalls} tool call{totalToolCalls !== 1 ? 's' : ''}</span>
					{#if firstTime && lastTime && firstTime !== lastTime}
						<span>total {timeDelta(firstTime, lastTime)}</span>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Turn-by-turn activity with interleaved user messages -->
		<div class="flex-1 overflow-y-auto p-4 space-y-2" bind:this={scrollContainer}>
			{#if loading}
				<div class="text-xs text-[var(--color-text-muted)]">Loading agent activity...</div>
			{:else if rawMessages.length === 0}
				<div class="text-xs text-[var(--color-text-muted)]">
					{agent.status === 'running' ? 'Agent is working...' : 'No activity recorded'}
				</div>
			{:else}
				{@const turnCounter = { n: 0 }}
				{#each feedMessages as msg (msg.id)}
					{#if msg.role === 'user'}
						<!-- User chat bubble -->
						<div class="flex justify-end pt-2">
							<div class="max-w-[85%] rounded-lg bg-[var(--color-accent)]/15 border border-[var(--color-accent)]/20 px-3 py-2">
								<div class="flex items-center justify-between gap-2 mb-1">
									<span class="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-accent)]">You</span>
									<span class="text-[10px] text-[var(--color-text-muted)] opacity-60" title={msg.createdAt}>{timeAgo(msg.createdAt, now)}</span>
								</div>
								<div class="text-sm text-[var(--color-text-primary)]">{msg.content}</div>
							</div>
						</div>
					{:else if msg.role === 'assistant'}
						{@const turnIdx = turnCounter.n++}
						{@const hasText = msg.content?.trim()}
						{@const hasTools = msg.toolCalls?.length > 0}

						<!-- Turn header -->
						<div class="flex items-center gap-2 pt-1" data-msg-id={msg.id}>
							<span class="text-[10px] font-medium text-[var(--color-text-muted)]">Turn {turnIdx + 1}</span>
							<div class="flex-1 border-t border-[var(--color-border)]"></div>
							<span class="text-[10px] text-[var(--color-text-muted)] opacity-60" title={msg.createdAt}>{timeAgo(msg.createdAt, now)}</span>
							{#if hasTools && !hasText}
								<span class="text-[10px] text-[var(--color-text-muted)]">{msg.toolCalls.length} tool{msg.toolCalls.length !== 1 ? 's' : ''}</span>
							{/if}
						</div>

						<!-- Tool calls -->
						{#if hasTools}
							<div class="space-y-0.5">
								{#each msg.toolCalls as tc (tc.id)}
									<button
										class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs font-mono transition-colors hover:bg-white/5"
										onclick={() => toggleTool(tc.id)}
									>
										<span class="{toolStatusColor(tc.status)} text-[10px]">{toolStatusIcon(tc.status)}</span>
										<span class="text-[var(--color-text-secondary)]">{tc.toolName}</span>
										{#if tc.input}
											<span class="truncate text-[var(--color-text-muted)] max-w-[200px]">{formatInput(tc.input)}</span>
										{/if}
										{#if tc.durationMs > 0}
											<span class="ml-auto text-[var(--color-text-muted)]">{tc.durationMs}ms</span>
										{/if}
									</button>

									{#if expandedTools.has(tc.id)}
										<div class="ml-5 rounded border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-2 text-xs">
											{#if tc.input}
												<div class="mb-1">
													<span class="text-[var(--color-text-muted)]">Input:</span>
													<pre class="mt-0.5 whitespace-pre-wrap text-[var(--color-text-secondary)] max-h-40 overflow-y-auto">{JSON.stringify(tc.input, null, 2)}</pre>
												</div>
											{/if}
											{#if tc.outputSummary}
												<div>
													<span class="text-[var(--color-text-muted)]">Output:</span>
													<pre class="mt-0.5 whitespace-pre-wrap text-[var(--color-text-secondary)] max-h-40 overflow-y-auto">{tc.outputSummary}</pre>
												</div>
											{/if}
										</div>
									{/if}
								{/each}
							</div>
						{/if}

						<!-- Text response -->
						{#if hasText}
							<div class="text-sm rounded bg-[var(--color-surface-secondary)] p-3">
								<div class="mb-1 text-[10px] font-semibold uppercase tracking-wider" style:color={color}>
									Response
								</div>
								<div class="text-[var(--color-text-primary)] prose-sm">
									<MarkdownRenderer content={msg.content} />
								</div>
							</div>
						{/if}
					{/if}
				{/each}
			{/if}

			<div bind:this={sentinel} class="h-1"></div>
		</div>

		{#if agent.subConversationId}
			<PanelChatInput
				placeholder="Send a message to @{agent.agentName}..."
				processing={isProcessing}
				agentName={agent.agentName}
				agentColor={color}
				scrollSentinel={sentinel}
				{scrollContainer}
				onsubmit={sendMessage}
			/>
		{/if}
	</div>
</SwipeDrawer>

