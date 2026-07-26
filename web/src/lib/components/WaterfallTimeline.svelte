<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	// Normalization + geometry live in a pure module so the chat-graph builder
	// can reuse them instead of re-deriving the same mapping. See
	// $lib/timeline-normalize for the duration-honesty rule (a 0 from any
	// source means UNKNOWN, not instant).
	import {
		buildWaterfallBars,
		normalizeObsEvents,
		normalizeToolCalls,
		type ObsEventLike,
		type WaterfallBar,
	} from "$lib/timeline-normalize.js";

	let {
		toolCalls = [],
		events = [],
		streaming = false,
	}: {
		toolCalls?: ToolCallState[];
		events?: ObsEventLike[];
		streaming?: boolean;
	} = $props();

	const PALETTE = [
		"#3b82f6", "#10b981", "#f59e0b", "#ef4444",
		"#8b5cf6", "#ec4899", "#06b6d4", "#84cc16",
	];

	function hashColor(name: string): string {
		let hash = 0;
		for (let i = 0; i < name.length; i++) {
			hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
		}
		return PALETTE[Math.abs(hash) % PALETTE.length]!;
	}

	function formatMs(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms >= 10000) return `${Math.round(ms / 1000)}s`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function formatTokens(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
		return `${n}`;
	}

	// For streaming: tick state to animate running bars
	let tick = $state(0);

	$effect(() => {
		if (!streaming) return;
		const id = setInterval(() => { tick++; }, 100);
		return () => clearInterval(id);
	});

	/**
	 * `_tick` is an unused reactivity anchor — reading it inside the `$derived`
	 * below is what makes the 100ms timer re-run the derivation so open-ended
	 * (still-running) bars keep growing. `Date.now()` is sampled HERE, at the
	 * component edge, which is why `normalizeToolCalls` can stay pure.
	 */
	function liveBars(calls: ToolCallState[], _tick: number): WaterfallBar[] {
		return buildWaterfallBars(normalizeToolCalls(calls, Date.now()));
	}

	let bars = $derived(
		toolCalls.length > 0
			? liveBars(toolCalls, tick)
			: buildWaterfallBars(normalizeObsEvents(events)),
	);

	let expandedIndex = $state<number | null>(null);

	function toggleExpand(index: number) {
		expandedIndex = expandedIndex === index ? null : index;
	}

	// Auto-scroll to bottom during streaming
	let container: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (!streaming || !container) return;
		const hasRunning = bars.some((b) => b.status === "running");
		if (hasRunning) {
			container.scrollTop = container.scrollHeight;
		}
	});
</script>

<div
	bind:this={container}
	class="max-h-[400px] overflow-y-auto space-y-0.5"
>
	{#if bars.length === 0}
		<p class="text-xs text-[var(--color-text-muted)] py-2">No tool calls recorded.</p>
	{:else}
		{#each bars as bar, i (i)}
			{@const color = bar.type === "llm" ? "var(--color-text-muted)" : hashColor(bar.extensionId ?? bar.label)}
			<button
				class="w-full text-left"
				onclick={() => toggleExpand(i)}
			>
				<div class="flex items-center gap-1 py-0.5">
					<!-- Label column -->
					<span
						class="w-24 shrink-0 truncate text-xs text-[var(--color-text-secondary)]"
						title={bar.label}
					>
						{bar.label}
					</span>

					<!-- Bar area -->
					<div class="relative flex-1 h-5 rounded bg-[var(--color-surface-secondary)]">
						<div
							class="absolute top-0 h-full rounded"
							class:animate-pulse={bar.status === "running"}
							style:left="{bar.startOffset}%"
							style:width="{bar.width}%"
							style:background-color={color}
							style:opacity={bar.status === "running" ? 0.5 : bar.status === "error" ? 0.7 : 0.8}
						></div>
						{#if bar.status === "error"}
							<div
								class="absolute top-0 h-full rounded bg-red-500/30"
								style:left="{bar.startOffset}%"
								style:width="{bar.width}%"
							></div>
						{/if}
					</div>

					<!-- Duration column -->
					<span class="w-16 shrink-0 text-right font-mono text-xs text-[var(--color-text-secondary)]">
						{formatMs(bar.duration)}
					</span>

					<!-- Token column -->
					<span class="w-16 shrink-0 text-right font-mono text-xs text-[var(--color-text-muted)]">
						{#if bar.tokens}
							{formatTokens(bar.tokens.input)}/{formatTokens(bar.tokens.output)}
						{/if}
					</span>
				</div>
			</button>

			<!-- Expanded details -->
			{#if expandedIndex === i && bar.type === "tool"}
				<div class="ml-24 rounded bg-[var(--color-surface-tertiary)] p-2 text-xs mb-1">
					{#if bar.error}
						<p class="text-red-400 mb-1">Error: {bar.error}</p>
					{/if}
					{#if bar.input !== undefined}
						<p class="text-[var(--color-text-muted)] mb-0.5">Input:</p>
						<pre class="max-h-32 overflow-auto rounded bg-[var(--color-surface-secondary)] p-1 text-[var(--color-text-secondary)]"><code>{JSON.stringify(bar.input, null, 2)}</code></pre>
					{/if}
					{#if bar.output !== undefined}
						<p class="text-[var(--color-text-muted)] mt-1 mb-0.5">Output:</p>
						<pre class="max-h-32 overflow-auto rounded bg-[var(--color-surface-secondary)] p-1 text-[var(--color-text-secondary)]"><code>{JSON.stringify(bar.output, null, 2)}</code></pre>
					{/if}
					{#if bar.extensionId}
						<p class="text-[var(--color-text-muted)] mt-1">Extension: {bar.extensionId}</p>
					{/if}
				</div>
			{/if}
		{/each}
	{/if}
</div>
