<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { sendToolKill } from "$lib/stores.svelte.js";
	import { stripAnsi } from "./utils.js";
	import CopyButton from "./CopyButton.svelte";
	import { AnsiUp } from "ansi_up";

	let { toolCall }: { toolCall: ToolCallState } = $props();

	const ansiUp = new AnsiUp();
	ansiUp.use_classes = true;

	let command = $derived.by((): string => {
		if (!toolCall.input || typeof toolCall.input !== 'object') return '';
		const inp = toolCall.input as Record<string, unknown>;
		return typeof inp.command === 'string' ? inp.command : '';
	});

	let rawOutput = $derived.by((): string => {
		if (toolCall.output == null) return '';
		return typeof toolCall.output === 'string' ? toolCall.output : JSON.stringify(toolCall.output, null, 2);
	});

	let htmlOutput = $derived(ansiUp.ansi_to_html(rawOutput));
	let plainOutput = $derived(stripAnsi(rawOutput));

	let exitCode = $derived.by((): number | undefined => {
		if (toolCall.status !== 'complete' || !toolCall.output || typeof toolCall.output !== 'object') return undefined;
		const out = toolCall.output as Record<string, unknown>;
		return typeof out.exitCode === 'number' ? out.exitCode : undefined;
	});

	function handleKill() {
		if (toolCall.id) sendToolKill(toolCall.id);
	}
</script>

<div data-testid="tool-card-terminal" class="rounded-md border border-[var(--color-border)] overflow-hidden bg-[var(--color-surface)]">
	<!-- Header bar -->
	<div class="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-surface-secondary)] border-b border-[var(--color-border)]">
		<span class="text-green-400 text-xs font-mono shrink-0">$</span>
		<span class="text-[var(--color-text-primary)] text-xs font-mono truncate flex-1">{command}</span>

		<div class="flex items-center gap-1 ml-auto">
			{#if toolCall.status === 'complete' && exitCode !== undefined}
				<span class="rounded px-1.5 py-0.5 text-[10px] font-medium {exitCode === 0 ? 'bg-green-700/50 text-green-300' : 'bg-red-700/50 text-red-300'}">
					exit {exitCode}
				</span>
			{/if}

			{#if toolCall.duration != null}
				<span class="text-[10px] text-[var(--color-text-muted)]">{(toolCall.duration / 1000).toFixed(1)}s</span>
			{/if}

			{#if plainOutput}
				<CopyButton text={plainOutput} />
			{/if}

			{#if toolCall.status === 'running'}
				<button
					onclick={handleKill}
					class="rounded p-1 text-red-400 hover:bg-red-900/30 hover:text-red-300 transition-colors"
					title="Kill process"
					aria-label="Kill process"
				>
					<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			{/if}
		</div>
	</div>

	<!-- Output area -->
	<div class="p-3 max-h-96 overflow-y-auto font-mono text-xs text-[var(--color-text-primary)] whitespace-pre-wrap break-all terminal-output">
		{@html htmlOutput}
		{#if toolCall.status === 'running'}
			<span class="inline-block w-2 h-4 bg-green-400 animate-pulse ml-0.5 align-text-bottom"></span>
		{/if}
	</div>
</div>

<style>
	/* ANSI color classes from ansi_up with use_classes=true */
	.terminal-output :global(.ansi-black-fg) { color: #3f3f3f; }
	.terminal-output :global(.ansi-red-fg) { color: #ef4444; }
	.terminal-output :global(.ansi-green-fg) { color: #22c55e; }
	.terminal-output :global(.ansi-yellow-fg) { color: #eab308; }
	.terminal-output :global(.ansi-blue-fg) { color: #3b82f6; }
	.terminal-output :global(.ansi-magenta-fg) { color: #a855f7; }
	.terminal-output :global(.ansi-cyan-fg) { color: #06b6d4; }
	.terminal-output :global(.ansi-white-fg) { color: #e5e7eb; }
	.terminal-output :global(.ansi-bright-black-fg) { color: #6b7280; }
	.terminal-output :global(.ansi-bright-red-fg) { color: #f87171; }
	.terminal-output :global(.ansi-bright-green-fg) { color: #4ade80; }
	.terminal-output :global(.ansi-bright-yellow-fg) { color: #facc15; }
	.terminal-output :global(.ansi-bright-blue-fg) { color: #60a5fa; }
	.terminal-output :global(.ansi-bright-magenta-fg) { color: #c084fc; }
	.terminal-output :global(.ansi-bright-cyan-fg) { color: #22d3ee; }
	.terminal-output :global(.ansi-bright-white-fg) { color: #f9fafb; }
	.terminal-output :global(.ansi-bold) { font-weight: 700; }
	.terminal-output :global(.ansi-dim) { opacity: 0.7; }
	.terminal-output :global(.ansi-italic) { font-style: italic; }
	.terminal-output :global(.ansi-underline) { text-decoration: underline; }
</style>
