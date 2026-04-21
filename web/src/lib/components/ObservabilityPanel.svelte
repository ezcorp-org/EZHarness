<script lang="ts">
	import { browser } from "$app/environment";
	import SwipeDrawer from "./SwipeDrawer.svelte";
	import WaterfallTimeline from "./WaterfallTimeline.svelte";
	import { store, getStreamingToolCalls, getActiveRunIdForConversation, type TaskSnapshot } from "$lib/stores.svelte.js";

	interface ObsEvent {
		id: string;
		eventType: string;
		data: Record<string, unknown>;
		durationMs: number | null;
		createdAt: string;
	}

	interface ConvStats {
		totalInputTokens: number;
		totalOutputTokens: number;
		totalToolCalls: number;
		avgDurationMs: number;
		turnCount: number;
	}

	let {
		conversationId,
		open = false,
		onclose,
		taskSnapshot,
	}: {
		conversationId: string;
		open: boolean;
		onclose: () => void;
		taskSnapshot?: TaskSnapshot;
	} = $props();

	// Build lookup from subConversationId → real assignment status to override obs event types
	let assignmentStatusBySubConvo = $derived.by(() => {
		const map = new Map<string, "completed" | "failed" | "running" | "assigned">();
		if (!taskSnapshot) return map;
		for (const task of taskSnapshot.tasks) {
			for (const a of task.assignments ?? []) {
				if (a.subConversationId) map.set(a.subConversationId, a.status);
			}
		}
		return map;
	});

	let events = $state<ObsEvent[]>([]);
	let stats = $state<ConvStats | null>(null);
	let loading = $state(false);

	async function loadData() {
		if (!conversationId || !open) return;
		loading = true;
		try {
			const res = await fetch(`/api/observability/${conversationId}`);
			if (!res.ok) return;
			const data = await res.json();
			events = data.events;
			stats = data.stats;
		} catch {
			// silent
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (browser && open && conversationId) loadData();
	});

	function formatMs(ms: number): string {
		if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
		return ms + "ms";
	}

	function formatTokens(n: number): string {
		if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
		if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
		return String(n);
	}

	let toolEvents = $derived(events.filter((e) => e.eventType === "tool_call" || e.eventType === "tool_error"));
	// Sub-agent invocations — populated by the collector's agent:complete subscriber. One row
	// per invocation with status inferred from eventType (agent_call = green, agent_error = red).
	let agentEvents = $derived(
		events
			.filter((e) => e.eventType === "agent_call" || e.eventType === "agent_error")
			.slice()
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
	);
	// Top-level run errors (including watchdog timeouts and force-cancels).
	let runErrorEvents = $derived(events.filter((e) => e.eventType === "run_error"));

	// Streaming awareness
	let activeRunId = $derived(getActiveRunIdForConversation(conversationId));
	let isStreaming = $derived(!!activeRunId);
	let liveToolCalls = $derived(activeRunId ? getStreamingToolCalls(activeRunId) : []);
</script>

<SwipeDrawer {open} side="right" width="w-full md:w-80" {onclose} ariaLabel="Observability panel">
	<div class="flex h-full flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
		<div class="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
			<h2 class="text-sm font-semibold text-[var(--color-text-primary)]">Observability</h2>
			<button
				onclick={onclose}
				class="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
			>
				<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>

		<div class="flex-1 overflow-y-auto p-4 space-y-4">
			{#if loading}
				<p class="text-xs text-[var(--color-text-muted)]">Loading...</p>
			{:else if stats}
				<!-- Token Usage Summary -->
				<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3">
					<h3 class="mb-2 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">Token Usage</h3>
					<div class="grid grid-cols-3 gap-2 text-center">
						<div>
							<p class="text-lg font-bold text-[var(--color-text-primary)]">{formatTokens(stats.totalInputTokens)}</p>
							<p class="text-xs text-[var(--color-text-muted)]">Input</p>
						</div>
						<div>
							<p class="text-lg font-bold text-[var(--color-text-primary)]">{formatTokens(stats.totalOutputTokens)}</p>
							<p class="text-xs text-[var(--color-text-muted)]">Output</p>
						</div>
						<div>
							<p class="text-lg font-bold text-[var(--color-text-primary)]">{formatTokens(stats.totalInputTokens + stats.totalOutputTokens)}</p>
							<p class="text-xs text-[var(--color-text-muted)]">Total</p>
						</div>
					</div>
				</div>

				<!-- Timing Breakdown -->
				<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3">
					<h3 class="mb-2 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">Timing</h3>
					<div class="space-y-1 text-xs">
						<div class="flex justify-between text-[var(--color-text-secondary)]">
							<span>Avg response</span>
							<span class="font-mono">{formatMs(stats.avgDurationMs)}</span>
						</div>
						<div class="flex justify-between text-[var(--color-text-secondary)]">
							<span>Turns</span>
							<span class="font-mono">{stats.turnCount}</span>
						</div>
						<div class="flex justify-between text-[var(--color-text-secondary)]">
							<span>Tool calls</span>
							<span class="font-mono">{stats.totalToolCalls}</span>
						</div>
					</div>
				</div>

				<!-- Execution Timeline (replaces old flat Tool Call Trace) -->
				{#if isStreaming || toolEvents.length > 0}
					<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3">
						<h3 class="mb-2 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">Execution Timeline</h3>
						{#if isStreaming}
							<WaterfallTimeline toolCalls={liveToolCalls} streaming={true} />
						{:else}
							<WaterfallTimeline events={toolEvents} streaming={false} />
						{/if}
					</div>
				{/if}

				<!-- Sub-agent Invocations — every agent:complete landed here via the observability
				     collector. Success shows green, failure (incl. timeouts) shows red with the
				     full resultPreview so users can see exactly what went wrong. -->
				{#if agentEvents.length > 0}
					<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3">
						<h3 class="mb-2 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">Sub-agent Invocations</h3>
						<ul class="space-y-2">
							{#each agentEvents as ev (ev.id)}
								{@const d = ev.data as { agentName?: string; resultPreview?: string; subConversationId?: string }}
								{@const assignmentStatus = d.subConversationId ? assignmentStatusBySubConvo.get(d.subConversationId) : undefined}
								{@const isError = assignmentStatus === 'failed' || (!assignmentStatus && ev.eventType === 'agent_error')}
								<li
									class="rounded border px-2 py-1.5 text-xs {isError
										? 'border-red-500 bg-red-500/10'
										: 'border-[var(--color-border)]'}"
								>
									<div class="flex items-center justify-between gap-2">
										<span class="font-medium text-[var(--color-text-primary)] truncate">{d.agentName ?? 'agent'}</span>
										<span
											class="rounded-full px-2 py-0.5 text-[10px] font-medium {isError
												? 'bg-red-500/30 text-red-200'
												: 'bg-green-500/20 text-green-300'}"
										>{isError ? 'Failed' : 'Complete'}</span>
									</div>
									{#if d.resultPreview}
										<p class="mt-1 text-[var(--color-text-muted)] break-words">{d.resultPreview}</p>
									{/if}
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				<!-- Run Errors — top-level run failures including watchdog timeouts and force-cancels.
				     Lets users see why a conversation was interrupted. -->
				{#if runErrorEvents.length > 0}
					<div class="rounded-md border border-red-500 bg-red-500/10 p-3">
						<h3 class="mb-2 text-xs font-semibold text-red-300 uppercase tracking-wide">Run Errors</h3>
						<ul class="space-y-2">
							{#each runErrorEvents as ev (ev.id)}
								{@const d = ev.data as { error?: string; runId?: string }}
								<li class="text-xs">
									<p class="break-words text-[var(--color-text-primary)]">{d.error ?? 'Unknown error'}</p>
									<p class="mt-0.5 text-[10px] text-[var(--color-text-muted)]">{new Date(ev.createdAt).toLocaleTimeString()}{d.runId ? ` — run ${d.runId.slice(0, 8)}` : ''}</p>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				<!-- Empty state -->
				{#if events.length === 0 && !isStreaming}
					<p class="text-center text-xs text-[var(--color-text-muted)]">No observability data for this conversation yet.</p>
				{/if}
			{/if}
		</div>
	</div>
</SwipeDrawer>
