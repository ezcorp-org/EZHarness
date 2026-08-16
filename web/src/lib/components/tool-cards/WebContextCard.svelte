<!--
	WebContextCard — source disclosure for the bundled `web-search`
	extension's two tools.

	It answers one question the generic tool card could not: *what did the
	model actually read?* The collapsed header always names the query (or
	the page), how many sources came back, and which domains they came
	from; expanding reveals every title as a real link plus the snippet
	text verbatim, and the footer states plainly that this text entered
	the conversation context.

	Template-only — every string, count and link-safety decision is
	precomputed in `web-context-card-logic.ts`, so the parsing rules are
	unit-testable without a renderer. `view.href === ""` means the logic
	module refused the URL (not http/https); the raw string is still shown,
	inert, because hiding a hostile URL discloses less than showing it.
-->
<script lang="ts">
	import type { WebContextView } from "./web-context-card-logic.js";
	import CopyButton from "./CopyButton.svelte";
	import MarkdownRenderer from "../MarkdownRenderer.svelte";
	import { slide } from "svelte/transition";

	let { view, expanded = $bindable(false) }: { view: WebContextView; expanded?: boolean } = $props();
</script>

<div
	data-testid="web-context-card"
	data-kind={view.kind}
	class="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)]"
>
	<button
		data-testid="web-context-toggle"
		onclick={() => (expanded = !expanded)}
		aria-expanded={expanded}
		class="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-secondary)]/50"
	>
		{#if view.kind === "search"}
			<!-- globe -->
			<svg class="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<circle cx="12" cy="12" r="9" />
				<path stroke-linecap="round" d="M3 12h18M12 3a15 15 0 010 18 15 15 0 010-18z" />
			</svg>
		{:else}
			<!-- document -->
			<svg class="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
			</svg>
		{/if}

		<span class="min-w-0 flex-1">
			<span class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
				<span class="shrink-0 text-sm font-medium text-[var(--color-text-secondary)]">
					{view.kind === "search" ? "Web search" : "Read page"}
				</span>
				{#if view.kind === "search"}
					{#if view.query}
						<span data-testid="web-context-query" class="min-w-0 truncate text-sm text-[var(--color-text-primary)]">“{view.query}”</span>
					{/if}
				{:else}
					<span data-testid="web-context-page-title" class="min-w-0 truncate text-sm text-[var(--color-text-primary)]">{view.title}</span>
				{/if}
			</span>

			<!-- Always-visible provenance: the sources exist even when collapsed. -->
			<span class="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--color-text-muted)]">
				{#if view.kind === "search"}
					<span data-testid="web-context-count">{view.countText}</span>
					{#each view.hostChips as host (host)}
						<span class="rounded bg-[var(--color-surface-secondary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]" data-testid="web-context-host-chip">{host}</span>
					{/each}
					{#if view.extraHostCount > 0}
						<span data-testid="web-context-host-more">+{view.extraHostCount}</span>
					{/if}
				{:else}
					{#if view.host}
						<span class="rounded bg-[var(--color-surface-secondary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]" data-testid="web-context-host-chip">{view.host}</span>
					{/if}
					<span data-testid="web-context-count">{view.charText} pulled into context</span>
				{/if}
			</span>
		</span>

		<span class="ml-auto flex shrink-0 items-center gap-1 pt-0.5">
			{#if view.durationText}
				<span data-testid="web-context-duration" class="text-xs text-[var(--color-text-muted)]">{view.durationText}</span>
			{/if}
			<svg
				class="h-3.5 w-3.5 text-[var(--color-text-muted)] transition-transform {expanded ? 'rotate-180' : ''}"
				fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
			>
				<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
			</svg>
		</span>
	</button>

	{#if expanded}
		<div transition:slide={{ duration: 150 }} class="border-t border-[var(--color-border)]">
			{#if view.kind === "search"}
				{#if view.empty}
					<p data-testid="web-context-empty" class="px-3 py-3 text-xs italic text-[var(--color-text-muted)]">
						The search returned no results, so nothing was added to the context.
					</p>
				{:else}
					<ol class="max-h-96 overflow-y-auto">
						{#each view.sources as source (source.rank)}
							<li
								data-testid="web-context-source"
								class="flex gap-2 border-b border-[var(--color-border)] px-3 py-2 last:border-b-0 hover:bg-[var(--color-surface-secondary)]/30"
							>
								<span class="w-4 shrink-0 pt-0.5 text-right font-mono text-[10px] text-[var(--color-text-muted)] select-none">{source.rank}</span>
								<span class="min-w-0 flex-1">
									<span class="flex flex-wrap items-baseline gap-x-2">
										{#if source.href}
											<a
												data-testid="web-context-source-link"
												href={source.href}
												target="_blank"
												rel="noopener noreferrer"
												class="min-w-0 text-xs font-medium text-[var(--color-accent)] hover:underline"
											>{source.title}</a>
										{:else}
											<span data-testid="web-context-source-unlinked" class="min-w-0 text-xs font-medium text-[var(--color-text-secondary)]">{source.title}</span>
										{/if}
										{#if source.host}
											<span class="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{source.host}</span>
										{/if}
									</span>
									{#if source.snippet}
										<span data-testid="web-context-snippet" class="mt-0.5 block text-xs leading-relaxed text-[var(--color-text-muted)]">{source.snippet}</span>
									{/if}
									{#if !source.href}
										<span data-testid="web-context-source-raw" class="mt-0.5 block font-mono text-[10px] break-all text-[var(--color-text-muted)]">{source.rawUrl}</span>
									{/if}
								</span>
							</li>
						{/each}
					</ol>
				{/if}
			{:else}
				{#if view.href}
					<a
						data-testid="web-context-source-link"
						href={view.href}
						target="_blank"
						rel="noopener noreferrer"
						class="block border-b border-[var(--color-border)] px-3 py-1.5 font-mono text-[10px] break-all text-[var(--color-accent)] hover:underline"
					>{view.rawUrl}</a>
				{:else if view.rawUrl}
					<span data-testid="web-context-source-raw" class="block border-b border-[var(--color-border)] px-3 py-1.5 font-mono text-[10px] break-all text-[var(--color-text-muted)]">{view.rawUrl}</span>
				{/if}
				<div data-testid="web-context-page-body" class="page-body max-h-96 overflow-y-auto px-3 py-2">
					<MarkdownRenderer content={view.markdown} />
				</div>
			{/if}

			<div class="flex items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface-secondary)]/40 px-3 py-1.5">
				<svg class="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="9" />
					<path stroke-linecap="round" d="M12 11v5m0-8h.01" />
				</svg>
				<span data-testid="web-context-footer" class="text-[10px] text-[var(--color-text-muted)]">
					This text was added to the conversation context.
				</span>
				<span class="ml-auto">
					<CopyButton text={view.raw} />
				</span>
			</div>
		</div>
	{/if}
</div>

<style>
	/* The fetched page is a disclosure EXCERPT inside a compact card, not an
	   article. MarkdownRenderer hard-sets `text-sm` on itself, so a wrapper
	   class cannot shrink it — re-base the scale here instead. Every size
	   downstream (headings, code, tables) is em-relative, so this single
	   declaration keeps their proportions intact. */
	.page-body :global(.markdown-body) {
		font-size: 0.75rem;
	}

	/* A leading `# Heading` carries `margin-top: 1em`, which reads as a gap
	   between the source URL and the page body. */
	.page-body :global(.markdown-body > :first-child) {
		margin-top: 0;
	}
</style>
