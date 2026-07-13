<script lang="ts">
	/**
	 * `<TopicsPopover>` — the header Topics dropdown: the full topic list with
	 * type badges, the Analyze/Refresh trigger (the ONLY thing that runs the
	 * detection LLM — never auto-run on open), and the stage-2 extract result
	 * panel (content preview + copied badge / manual Copy fallback + library
	 * deep-link). Positioning + backdrop clone ChatHeader's tools-popover.
	 *
	 * Rendered inside ChatHeader's `relative` Topics-button wrapper; owns no
	 * fetch/state — ChatThread drives everything through props.
	 */
	import {
		type Topic,
		type ContextType,
		type ExtractState,
		refreshLabel,
		typeBadgeLabel,
		typeBadgeClass,
		extractResult,
		isCopied,
		needsManualCopy,
		extractError,
		CONTEXTS_LIBRARY_HREF,
	} from "$lib/topic-contexts-logic";

	let {
		topics,
		stale,
		analyzedAt,
		newCount = 0,
		analyzing = false,
		analyzeError = null,
		extractState,
		busyId = null,
		typeMap,
		onclose,
		onanalyze,
		onextract,
		onmanualcopy,
	}: {
		topics: Topic[];
		stale: boolean;
		analyzedAt: string | null;
		newCount?: number;
		analyzing?: boolean;
		/** Detection 503 / network error, shown as a banner under the header. */
		analyzeError?: string | null;
		extractState: ExtractState;
		busyId?: string | null;
		typeMap: Map<string, ContextType>;
		onclose: () => void;
		onanalyze: () => void;
		onextract: (topicId: string) => void;
		onmanualcopy: (content: string) => void;
	} = $props();

	let label = $derived(refreshLabel({ analyzedAt, stale, newCount }));
	let result = $derived(extractResult(extractState));
	let error = $derived(extractError(extractState));

	function clickTopic(id: string) {
		if (busyId !== null) return;
		onextract(id);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div data-testid="topics-backdrop" class="fixed inset-0 z-40" onclick={onclose} onkeydown={() => {}}></div>
<!-- `fixed` below md keeps the popover pinned to the viewport edge (the badge
     sits far from the right edge on mobile); `absolute` from md anchors it
     under the button — identical rationale to the tools popover. -->
<div
	data-testid="topics-popover"
	class="fixed md:absolute right-4 md:right-0 md:top-full z-50 mt-1 w-[calc(100vw-2rem)] md:w-80 max-w-[22rem] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-lg max-h-[70vh] overflow-y-auto"
>
	<div class="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2">
		<span class="text-xs font-bold text-[var(--color-text-secondary)]">Topics</span>
		<button
			type="button"
			data-testid="topics-analyze-btn"
			onclick={onanalyze}
			disabled={analyzing}
			class="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-60"
		>
			{#if analyzing}
				<svg class="h-3 w-3 animate-spin" data-testid="topics-analyze-spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
				</svg>
				Analyzing…
			{:else}
				{label.text}
			{/if}
		</button>
	</div>

	{#if analyzeError}
		<div data-testid="topics-analyze-error" class="border-b border-red-800 bg-red-900/30 px-3 py-1.5 text-[11px] text-red-300" role="alert">
			{analyzeError}
		</div>
	{:else if stale && !analyzing}
		<div data-testid="topics-stale-banner" class="border-b border-[var(--color-border)] bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300">
			New messages since the last analysis — {label.text} to refresh the topics.
		</div>
	{/if}

	{#if topics.length === 0}
		<p data-testid="topics-empty" class="px-3 py-4 text-xs text-[var(--color-text-muted)]">
			{#if analyzedAt === null}
				No topics yet — click Analyze to detect the topics in this conversation.
			{:else}
				No topics were detected in this conversation.
			{/if}
		</p>
	{:else}
		<ul class="py-1">
			{#each topics as topic (topic.id)}
				<li>
					<button
						type="button"
						data-testid="topic-pill-{topic.id}"
						onclick={() => clickTopic(topic.id)}
						disabled={busyId !== null}
						class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
					>
						<span class="min-w-0 flex-1 truncate">{topic.label}</span>
						<span class="shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase {typeBadgeClass(topic.typeId)}" data-testid="topic-type-badge">
							{typeBadgeLabel(topic.typeId, typeMap)}
						</span>
						{#if busyId === topic.id}
							<svg class="h-3 w-3 shrink-0 animate-spin text-[var(--color-accent)]" data-testid="topic-row-spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true">
								<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
								<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
							</svg>
						{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	{#if result}
		<div data-testid="topic-extract-result" class="border-t border-[var(--color-border)] px-3 py-2">
			<div class="mb-1 flex items-center justify-between gap-2">
				<span class="min-w-0 flex-1 truncate text-xs font-bold text-[var(--color-text-primary)]">{result.title}</span>
				{#if isCopied(extractState)}
					<span data-testid="topic-copied-badge" class="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-900/50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
						<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
						Copied
					</span>
				{/if}
			</div>
			<div class="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] p-2 text-[11px] text-[var(--color-text-secondary)]">{result.content}</div>
			<div class="mt-2 flex items-center justify-between gap-2">
				{#if needsManualCopy(extractState)}
					<button
						type="button"
						data-testid="topic-copy-btn"
						onclick={() => onmanualcopy(result.content)}
						class="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500"
					>
						<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
						Copy
					</button>
				{:else}
					<span></span>
				{/if}
				<a
					href={CONTEXTS_LIBRARY_HREF}
					data-testid="topic-library-link"
					class="text-xs font-medium text-[var(--color-accent)] hover:underline"
				>
					Saved to Library →
				</a>
			</div>
		</div>
	{/if}

	{#if error}
		<div data-testid="topic-extract-error" class="border-t border-red-800 bg-red-900/30 px-3 py-2 text-xs text-red-300" role="alert">
			{error}
		</div>
	{/if}
</div>
