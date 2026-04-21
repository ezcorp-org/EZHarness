<script lang="ts">
	import type { InlineToolCall } from "$lib/inline-tool-store.svelte.js";
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import MarkdownRenderer from "./MarkdownRenderer.svelte";
	import InfoTooltip from "./InfoTooltip.svelte";
	import ToolCardRouter from "./tool-cards/ToolCardRouter.svelte";
	import { slide } from "svelte/transition";

	let {
		call,
		onretry,
		oneditretry,
		oncancel,
		onsendmessage,
		historical = false,
		source,
	}: {
		call: InlineToolCall;
		onretry: (call: InlineToolCall) => void;
		oneditretry: (call: InlineToolCall) => void;
		oncancel: (call: InlineToolCall) => void;
		onsendmessage?: (message: string) => void;
		historical?: boolean;
		source?: "user" | "agent";
	} = $props();

	let expanded = $state(false);
	let elapsed = $state(0);
	let intervalId: ReturnType<typeof setInterval> | undefined;
	let fullOutput = $state<string | null>(null);
	let loadingOutput = $state(false);

	// Live elapsed timer for running state
	$effect(() => {
		if (call.status === 'running' && call.startedAt) {
			elapsed = Math.floor((Date.now() - call.startedAt) / 1000);
			intervalId = setInterval(() => {
				elapsed = Math.floor((Date.now() - call.startedAt!) / 1000);
			}, 100);
		} else {
			clearInterval(intervalId);
			intervalId = undefined;
		}
		return () => { clearInterval(intervalId); };
	});

	let summaryLine = $derived.by(() => {
		if ((call.status !== 'complete' && call.status !== 'error') || !call.output) {
			if (call.status === 'complete' || call.status === 'error') {
				const dur = call.duration != null ? ` (${(call.duration / 1000).toFixed(1)}s)` : '';
				return `${call.extensionName} > ${call.toolName}${dur}`;
			}
			return '';
		}
		const firstLine = call.output.split('\n')[0] ?? '';
		const truncated = firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine;
		const dur = call.duration != null ? ` (${(call.duration / 1000).toFixed(1)}s)` : '';
		return `${call.extensionName} > ${call.toolName} -- ${truncated}${dur}`;
	});

	let isInterrupted = $derived(call.status === 'error' && call.error === 'interrupted');

	/** When cardType is set, delegate to the specialized card router */
	let useSpecializedCard = $derived(!!call.cardType && call.status === 'complete');

	/** Adapt InlineToolCall to ToolCallState for the router */
	let toolCallState = $derived.by((): ToolCallState => ({
		id: call.id,
		toolName: call.toolName,
		status: call.status === 'complete' ? 'complete' : call.status === 'error' ? 'error' : 'running',
		input: call.input,
		output: call.output,
		error: call.error,
		startedAt: call.startedAt,
		duration: call.duration,
		extensionId: call.extensionName,
		cardType: call.cardType,
	}));

	async function fetchFullOutput() {
		if (loadingOutput || fullOutput !== null || !call.id) return;
		loadingOutput = true;
		try {
			const res = await fetch(`/api/tool-calls/${call.id}/output`);
			if (res.ok) {
				const data = await res.json();
				fullOutput = data.output != null ? (typeof data.output === 'string' ? data.output : JSON.stringify(data.output, null, 2)) : null;
			}
		} catch { /* silent */ }
		loadingOutput = false;
	}

	async function handleExpand() {
		expanded = !expanded;
		if (expanded && historical) {
			await fetchFullOutput();
		}
	}
</script>

{#if useSpecializedCard}
	<div class="ml-4">
		<ToolCardRouter toolCall={toolCallState} conversationId={call.conversationId} messageId={call.messageId} {onsendmessage} />
	</div>
{:else}
<div class="ml-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] overflow-hidden">
	{#if isInterrupted}
		<!-- Interrupted state -->
		<div class="flex items-center gap-2 px-3 py-2 text-sm">
			<svg class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
			<span class="h-2 w-2 shrink-0 rounded-full bg-[var(--color-text-muted)]"></span>
			<span class="text-[var(--color-text-muted)]">
				{call.extensionName} &rsaquo; {call.toolName} -- Interrupted
			</span>
			{#if source === 'agent'}
				<span class="text-xs text-[var(--color-text-muted)] italic">via agent</span>
			{/if}
		</div>
	{:else if call.status === 'running' || call.status === 'pending'}
		<!-- Running / Pending header -->
		<div class="flex items-center gap-2 px-3 py-2 text-sm">
			<svg class="h-4 w-4 shrink-0 text-[var(--color-accent)] animate-spin" fill="none" viewBox="0 0 24 24">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
			</svg>
			<span class="h-2 w-2 shrink-0 rounded-full bg-purple-500"></span>
			<span class="text-[var(--color-text-secondary)]">
				{call.extensionName} &rsaquo; {call.toolName}
			</span>
			<InfoTooltip key="chat.inline-tools" />
			<span class="text-xs text-[var(--color-text-muted)]">Running... {elapsed}s</span>
			{#if source === 'agent'}
				<span class="text-xs text-[var(--color-text-muted)] italic">via agent</span>
			{/if}
			{#if !historical}
				<button
					onclick={() => oncancel(call)}
					class="ml-auto rounded px-2 py-0.5 text-xs text-red-400 hover:bg-red-900/30 hover:text-red-300 transition-colors"
				>
					Cancel
				</button>
			{/if}
		</div>
	{:else if call.status === 'complete'}
		<!-- Complete header -->
		<button
			onclick={handleExpand}
			class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-secondary)]/50 transition-colors"
			aria-expanded={expanded}
		>
			<svg class="h-4 w-4 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
			</svg>
			<span class="h-2 w-2 shrink-0 rounded-full bg-purple-500"></span>
			<span class="truncate text-[var(--color-text-secondary)]">{summaryLine}</span>
			{#if source === 'agent'}
				<span class="shrink-0 text-xs text-[var(--color-text-muted)] italic">via agent</span>
			{/if}
			<svg
				class="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] transition-transform {expanded ? 'rotate-180' : ''}"
				fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
			>
				<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
			</svg>
		</button>

		{#if expanded}
			<div transition:slide={{ duration: 150 }} class="border-t border-[var(--color-border)] px-3 py-2 text-xs">
				{#if loadingOutput}
					<span class="text-[var(--color-text-muted)]">Loading...</span>
				{:else if fullOutput !== null}
					<MarkdownRenderer content={fullOutput} />
				{:else if call.output}
					<MarkdownRenderer content={call.output} />
				{/if}
			</div>
		{/if}
	{:else if call.status === 'error'}
		<!-- Error state -->
		<div class="px-3 py-2">
			<div class="flex items-center gap-2 text-sm">
				<svg class="h-4 w-4 shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
				</svg>
				<span class="h-2 w-2 shrink-0 rounded-full bg-purple-500"></span>
				<span class="text-red-400">
					{call.retryCount > 0 ? `Failed after ${call.retryCount} ${call.retryCount === 1 ? 'retry' : 'retries'}` : 'Failed'}
				</span>
				{#if source === 'agent'}
					<span class="text-xs text-[var(--color-text-muted)] italic">via agent</span>
				{/if}
			</div>
			{#if call.error}
				<pre class="mt-1 overflow-x-auto rounded bg-red-900/20 p-2 text-xs text-red-300 whitespace-pre-wrap break-all">{call.error}</pre>
			{/if}
			{#if !historical}
				<div class="mt-2 flex gap-2">
					<button
						onclick={() => onretry(call)}
						class="rounded bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] transition-colors"
					>
						Retry
					</button>
					<button
						onclick={() => oneditretry(call)}
						class="rounded bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)] transition-colors"
					>
						Edit & Retry
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>
{/if}
