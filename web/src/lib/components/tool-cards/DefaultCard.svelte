<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { slide } from "svelte/transition";
	import CopyButton from "./CopyButton.svelte";
	import MarkdownRenderer from "../MarkdownRenderer.svelte";
	import { extractInputSummary, formatOutputPreview } from "./utils.js";

	let { toolCall }: { toolCall: ToolCallState } = $props();
	let expanded = $state(false);
	let fullOutput = $state<string | null>(null);
	let loadingOutput = $state(false);

	let durationText = $derived(
		toolCall.duration != null ? `${(toolCall.duration / 1000).toFixed(1)}s` : undefined,
	);

	let inputSummary = $derived(extractInputSummary(toolCall.input));

	let displayOutput = $derived.by((): string | undefined => {
		if (fullOutput != null) return fullOutput;
		if (toolCall.output == null) return undefined;
		return typeof toolCall.output === 'string' ? toolCall.output : JSON.stringify(toolCall.output, null, 2);
	});

	let outputPreview = $derived(toolCall.status === 'complete' ? formatOutputPreview(toolCall.output) : undefined);

	// Tools like openai-image-gen-2 return markdown with `![alt](url)` — render via
	// MarkdownRenderer so images appear inline regardless of whether the model echoed
	// the markdown into its reply. Plain text/JSON outputs stay in <pre> to preserve
	// monospace/whitespace.
	let outputHasImage = $derived(!!displayOutput && /!\[[^\]]*\]\([^\)]+\)/.test(displayOutput));

	// If the tool output contains an image, fetch the full output eagerly so truncated
	// previews don't chop the URL. Runs once per tool call when it reaches complete+image.
	let imageOutputLoaded = $state(false);
	$effect(() => {
		if (
			toolCall.status === 'complete' &&
			outputHasImage &&
			fullOutput == null &&
			!imageOutputLoaded &&
			toolCall.id
		) {
			imageOutputLoaded = true;
			fetch(`/api/tool-calls/${toolCall.id}/output`)
				.then((r) => (r.ok ? r.json() : null))
				.then((data) => {
					if (data?.output != null) {
						fullOutput = typeof data.output === 'string' ? data.output : JSON.stringify(data.output, null, 2);
					}
				})
				.catch(() => { /* non-critical */ });
		}
	});

	async function handleExpand() {
		expanded = !expanded;
		if (expanded && fullOutput == null && toolCall.id && toolCall.status !== 'running') {
			loadingOutput = true;
			try {
				const res = await fetch(`/api/tool-calls/${toolCall.id}/output`);
				if (res.ok) {
					const data = await res.json();
					if (data.output != null) {
						fullOutput = typeof data.output === 'string' ? data.output : JSON.stringify(data.output, null, 2);
					}
				}
			} catch { /* non-critical */ }
			loadingOutput = false;
		}
	}
</script>

<div data-testid="tool-card-default" class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] overflow-hidden">
	<button
		onclick={handleExpand}
		class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-secondary)]/50 transition-colors"
		aria-expanded={expanded}
	>
		{#if toolCall.status === 'running'}
			<svg class="h-4 w-4 shrink-0 text-[var(--color-accent)] animate-spin" fill="none" viewBox="0 0 24 24">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
			</svg>
		{:else if toolCall.status === 'complete'}
			<svg class="h-4 w-4 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
			</svg>
		{:else}
			<svg class="h-4 w-4 shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
			</svg>
		{/if}

		<span class="shrink-0 text-[var(--color-text-secondary)] font-medium">{toolCall.toolName}</span>
		{#if inputSummary}
			<span class="truncate text-[var(--color-text-muted)] text-xs font-normal">{inputSummary}</span>
		{:else if outputPreview && !inputSummary}
			<span class="truncate text-[var(--color-text-muted)] text-xs font-normal italic">{outputPreview}</span>
		{/if}

		<div class="ml-auto flex items-center gap-1">
			{#if displayOutput && expanded}
				<CopyButton text={displayOutput} />
			{/if}
			{#if durationText}
				<span class="shrink-0 text-xs text-[var(--color-text-muted)]">{durationText}</span>
			{/if}
			<svg
				class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] transition-transform {expanded ? 'rotate-180' : ''}"
				fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
			>
				<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
			</svg>
		</div>
	</button>

	{#if outputHasImage && displayOutput}
		<div class="border-t border-[var(--color-border)] px-3 py-2">
			<MarkdownRenderer content={displayOutput} />
		</div>
	{/if}

	{#if expanded}
		<div transition:slide={{ duration: 150 }} class="border-t border-[var(--color-border)] px-3 py-2 text-xs">
			{#if toolCall.input != null}
				<div class="mb-2">
					<p class="font-medium text-[var(--color-text-muted)] mb-1">Input</p>
					<pre class="overflow-x-auto rounded bg-[var(--color-surface-secondary)] p-2 text-[var(--color-text-secondary)] whitespace-pre-wrap break-all max-h-60 overflow-y-auto">{JSON.stringify(toolCall.input, null, 2)}</pre>
				</div>
			{/if}

			{#if toolCall.status === 'error' && toolCall.error}
				<div>
					<p class="font-medium text-red-400 mb-1">Error</p>
					<pre class="overflow-x-auto rounded bg-red-900/20 p-2 text-red-300 whitespace-pre-wrap break-all max-h-60 overflow-y-auto">{toolCall.error}</pre>
				</div>
			{:else if loadingOutput}
				<div>
					<p class="font-medium text-[var(--color-text-muted)] mb-1">Output</p>
					<p class="text-[var(--color-text-muted)] italic">Loading full output...</p>
				</div>
			{:else if displayOutput != null}
				<div>
					<p class="font-medium text-[var(--color-text-muted)] mb-1">{outputHasImage ? 'Raw output' : 'Output'}</p>
					<pre class="overflow-x-auto rounded bg-[var(--color-surface-secondary)] p-2 text-[var(--color-text-secondary)] whitespace-pre-wrap break-all max-h-96 overflow-y-auto">{displayOutput}</pre>
				</div>
			{/if}

			{#if durationText}
				<p class="mt-2 text-[var(--color-text-muted)]">Duration: {durationText}</p>
			{/if}
		</div>
	{/if}
</div>
