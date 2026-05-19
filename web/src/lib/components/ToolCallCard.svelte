<script lang="ts">
	import { untrack } from "svelte";
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { openDock, store } from "$lib/stores.svelte.js";
	import { slide } from "svelte/transition";
	import ToolCardRouter from "./tool-cards/ToolCardRouter.svelte";
	import DockOpenPill from "./tool-cards/DockOpenPill.svelte";
	import { shouldRenderInDock } from "./tool-cards/utils.js";
	import MarkdownRenderer from "./MarkdownRenderer.svelte";

	let { toolCall, conversationId, onsendmessage }: { toolCall: ToolCallState; conversationId?: string; onsendmessage?: (message: string) => void } = $props();

	/** Delegate to specialized card renderers when a cardType is set */
	let useSpecializedCard = $derived(!!toolCall.cardType);

	/** Dock-routing: when complete + cardLayout="dock", render a DockOpenPill instead. */
	let routeToDock = $derived(shouldRenderInDock(toolCall.cardLayout, toolCall.status));

	// Auto-open dock when this card's status FLIPS from non-complete to
	// complete DURING THIS PAGE SESSION (i.e. live tool completion). Cards
	// that mount already-complete — scrollback, page reload — don't auto-open
	// here; DockHost handles initial mount restoration by picking the most
	// recently completed dock-mode tool call (avoids cycling through every
	// historical canvas).
	//
	// Each card fires AT MOST ONCE via `firedOnce`. Manual re-opens via the
	// chat-history `DockOpenPill` bypass this effect entirely.
	const initialStatus = untrack(() => toolCall.status);
	let openDockTimer: ReturnType<typeof setTimeout> | undefined;
	let firedOnce = $state(false);
	$effect(() => {
		// Skip cards that mounted already-complete — DockHost picks the latest.
		if (initialStatus === "complete") return;
		if (firedOnce) return;
		if (!routeToDock || !toolCall.id || !conversationId) return;
		if (store.dismissedDocks[conversationId]?.[toolCall.id]) return;
		const existing = store.dockState[conversationId];
		if (existing?.toolCallId === toolCall.id) return;
		clearTimeout(openDockTimer);
		const id = toolCall.id;
		const conv = conversationId;
		openDockTimer = setTimeout(() => {
			openDock(conv, id);
			firedOnce = true;
		}, 500);
		return () => { clearTimeout(openDockTimer); };
	});
	let expanded = $state(false);
	let fullOutput = $state<string | null>(null);
	let loadingOutput = $state(false);

	let durationText = $derived(
		toolCall.duration != null ? `${(toolCall.duration / 1000).toFixed(1)}s` : undefined,
	);

	/** Short summary of the tool's key input arg for the collapsed header */
	let inputSummary = $derived.by((): string | undefined => {
		if (!toolCall.input || typeof toolCall.input !== 'object') return undefined;
		const inp = toolCall.input as Record<string, unknown>;
		const key = inp.file_path ?? inp.path ?? inp.pattern ?? inp.command ?? inp.query ?? inp.url ?? inp.content;
		if (!key) return undefined;
		const s = String(key);
		return s.length > 60 ? s.slice(0, 57) + '...' : s;
	});

	/** Formatted output for display — uses full fetched output or falls back to summary */
	let displayOutput = $derived.by((): string | undefined => {
		if (fullOutput != null) return fullOutput;
		if (toolCall.output == null) return undefined;
		return typeof toolCall.output === 'string' ? toolCall.output : JSON.stringify(toolCall.output, null, 2);
	});

	/** Brief output preview for the collapsed header */
	let outputPreview = $derived.by((): string | undefined => {
		if (toolCall.status !== 'complete') return undefined;
		if (toolCall.output == null) return undefined;
		const s = typeof toolCall.output === 'string' ? toolCall.output : JSON.stringify(toolCall.output);
		if (!s || s === '{}' || s === '""') return undefined;
		return s.length > 50 ? s.slice(0, 47) + '...' : s;
	});

	// Render images from tool output (e.g. openai-image-gen-2 returns `![alt](url)`)
	// inline below the header so they appear regardless of whether the model echoed
	// the markdown into its reply and without requiring the user to expand the card.
	let outputHasImage = $derived(!!displayOutput && /!\[[^\]]*\]\([^\)]+\)/.test(displayOutput));

	async function handleExpand() {
		expanded = !expanded;
		// Lazy-fetch full output from DB on first expand if we have a tool call ID
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

{#if routeToDock && toolCall.id && conversationId}
	<DockOpenPill toolCallId={toolCall.id} conversationId={conversationId} />
{:else if useSpecializedCard}
	<ToolCardRouter {toolCall} {conversationId} {onsendmessage} />
{:else}
<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] overflow-hidden">
	<!-- Collapsed header -->
	<button
		onclick={handleExpand}
		class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-secondary)]/50 transition-colors"
		aria-expanded={expanded}
	>
		<!-- Status icon -->
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

		<!-- Tool name + input summary -->
		<span class="shrink-0 text-[var(--color-text-secondary)] font-medium">{toolCall.toolName}</span>
		{#if inputSummary}
			<span class="truncate text-[var(--color-text-muted)] text-xs font-normal">{inputSummary}</span>
		{:else if outputPreview && !inputSummary}
			<span class="truncate text-[var(--color-text-muted)] text-xs font-normal italic">{outputPreview}</span>
		{/if}

		<!-- Duration -->
		{#if durationText}
			<span class="ml-auto shrink-0 text-xs text-[var(--color-text-muted)]">{durationText}</span>
		{/if}

		<!-- Expand indicator -->
		<svg
			class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] transition-transform {expanded ? 'rotate-180' : ''}"
			fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
		>
			<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
		</svg>
	</button>

	<!-- Inline image preview: always visible when output contains markdown images -->
	{#if outputHasImage && displayOutput}
		<div class="border-t border-[var(--color-border)] px-3 py-2">
			<MarkdownRenderer content={displayOutput} />
		</div>
	{/if}

	<!-- Expanded details -->
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
					<p class="font-medium text-[var(--color-text-muted)] mb-1">Output</p>
					<pre class="overflow-x-auto rounded bg-[var(--color-surface-secondary)] p-2 text-[var(--color-text-secondary)] whitespace-pre-wrap break-all max-h-96 overflow-y-auto">{displayOutput}</pre>
				</div>
			{/if}

			{#if durationText}
				<p class="mt-2 text-[var(--color-text-muted)]">Duration: {durationText}</p>
			{/if}
		</div>
	{/if}
</div>
{/if}
