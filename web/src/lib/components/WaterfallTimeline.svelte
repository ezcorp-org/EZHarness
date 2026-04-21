<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";

	interface ObsEvent {
		id: string;
		eventType: string;
		data: Record<string, unknown>;
		durationMs: number | null;
		createdAt: string;
	}

	interface WaterfallBar {
		type: "llm" | "tool";
		label: string;
		extensionId?: string;
		startOffset: number;
		width: number;
		duration: number;
		status: "running" | "complete" | "error";
		tokens?: { input: number; output: number };
		input?: unknown;
		output?: unknown;
		error?: string;
	}

	let {
		toolCalls = [],
		events = [],
		streaming = false,
	}: {
		toolCalls?: ToolCallState[];
		events?: ObsEvent[];
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

	function computeBarsFromToolCalls(calls: ToolCallState[], _tick: number): WaterfallBar[] {
		if (calls.length === 0) return [];

		const now = Date.now();
		const sorted = [...calls].sort((a, b) => a.startedAt - b.startedAt);
		const timelineStart = sorted[0]!.startedAt;
		const timelineEnd = sorted.reduce((max, tc) => {
			const end = tc.startedAt + (tc.duration ?? now - tc.startedAt);
			return end > max ? end : max;
		}, timelineStart);
		const totalDuration = timelineEnd - timelineStart;
		if (totalDuration <= 0) return [];

		const bars: WaterfallBar[] = [];

		for (let i = 0; i < sorted.length; i++) {
			const tc = sorted[i]!;
			const prevEnd = i === 0
				? timelineStart
				: sorted[i - 1]!.startedAt + (sorted[i - 1]!.duration ?? now - sorted[i - 1]!.startedAt);

			const gap = tc.startedAt - prevEnd;
			if (gap > 100) {
				bars.push({
					type: "llm",
					label: "Thinking",
					startOffset: ((prevEnd - timelineStart) / totalDuration) * 100,
					width: (gap / totalDuration) * 100,
					duration: gap,
					status: "complete",
				});
			}

			const duration = tc.duration ?? now - tc.startedAt;
			bars.push({
				type: "tool",
				label: tc.toolName,
				extensionId: tc.extensionId,
				startOffset: ((tc.startedAt - timelineStart) / totalDuration) * 100,
				width: Math.max((duration / totalDuration) * 100, 0.5),
				duration,
				status: tc.status,
				input: tc.input,
				output: tc.output,
				error: tc.error,
			});
		}

		return bars;
	}

	function computeBarsFromEvents(evts: ObsEvent[]): WaterfallBar[] {
		if (evts.length === 0) return [];

		const toolEvts = evts.filter(
			(e) => e.eventType === "tool_call" || e.eventType === "tool_error",
		);
		if (toolEvts.length === 0) return [];

		const sorted = [...toolEvts].sort(
			(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
		);
		const timelineStart = new Date(sorted[0]!.createdAt).getTime();
		const timelineEnd = sorted.reduce((max, ev) => {
			const t = new Date(ev.createdAt).getTime() + (ev.durationMs ?? 0);
			return t > max ? t : max;
		}, timelineStart);
		const totalDuration = timelineEnd - timelineStart;
		if (totalDuration <= 0) return [];

		const bars: WaterfallBar[] = [];

		for (let i = 0; i < sorted.length; i++) {
			const ev = sorted[i]!;
			const d = ev.data as Record<string, unknown>;
			const evStart = new Date(ev.createdAt).getTime();
			const evDuration = ev.durationMs ?? 0;

			const prevEnd = i === 0
				? timelineStart
				: new Date(sorted[i - 1]!.createdAt).getTime() + (sorted[i - 1]!.durationMs ?? 0);

			const gap = evStart - prevEnd;
			if (gap > 100) {
				bars.push({
					type: "llm",
					label: "Thinking",
					startOffset: ((prevEnd - timelineStart) / totalDuration) * 100,
					width: (gap / totalDuration) * 100,
					duration: gap,
					status: "complete",
				});
			}

			bars.push({
				type: "tool",
				label: (d.toolName as string) ?? "unknown",
				extensionId: d.extensionId as string | undefined,
				startOffset: ((evStart - timelineStart) / totalDuration) * 100,
				width: Math.max((evDuration / totalDuration) * 100, 0.5),
				duration: evDuration,
				status: ev.eventType === "tool_error" ? "error" : "complete",
				input: d.input,
				output: d.output ?? d.result,
				error: d.error as string | undefined,
			});
		}

		return bars;
	}

	let bars = $derived(
		toolCalls.length > 0
			? computeBarsFromToolCalls(toolCalls, tick)
			: computeBarsFromEvents(events),
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
