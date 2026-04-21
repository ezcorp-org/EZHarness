<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { parseGrepOutput, parseGlobOutput, type GrepFileGroup } from "./utils.js";
	import CopyButton from "./CopyButton.svelte";

	let { toolCall }: { toolCall: ToolCallState } = $props();

	let rawOutput = $derived.by((): string => {
		if (toolCall.output == null) return '';
		return typeof toolCall.output === 'string' ? toolCall.output : JSON.stringify(toolCall.output, null, 2);
	});

	let isGlob = $derived(toolCall.toolName === 'glob');

	let grepGroups = $derived.by((): GrepFileGroup[] => {
		if (isGlob) return [];
		return parseGrepOutput(rawOutput);
	});

	let globFiles = $derived.by((): string[] => {
		if (!isGlob) return [];
		return parseGlobOutput(rawOutput);
	});

	let totalMatches = $derived(
		isGlob
			? globFiles.length
			: grepGroups.reduce((sum, g) => sum + g.matches.length, 0),
	);

	// Collapse state per file group: first 3 expanded by default
	let expandedSections = $state<Set<number>>(new Set([0, 1, 2]));

	function toggleSection(idx: number) {
		const next = new Set(expandedSections);
		if (next.has(idx)) next.delete(idx);
		else next.add(idx);
		expandedSections = next;
	}
</script>

<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] overflow-hidden">
	<!-- Header -->
	<div class="flex items-center gap-2 px-3 py-2 bg-[var(--color-surface-secondary)] border-b border-[var(--color-border)]">
		<svg class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
		</svg>
		<span class="text-xs font-medium text-[var(--color-text-secondary)]">{toolCall.toolName}</span>
		<span class="text-[10px] text-[var(--color-text-muted)]">
			{totalMatches} {isGlob ? 'file' : 'match'}{totalMatches !== 1 ? 'es' : ''}
			{#if !isGlob && grepGroups.length > 0}
				in {grepGroups.length} file{grepGroups.length !== 1 ? 's' : ''}
			{/if}
		</span>
		<div class="ml-auto">
			{#if rawOutput}
				<CopyButton text={rawOutput} />
			{/if}
		</div>
	</div>

	<!-- Results -->
	<div class="max-h-96 overflow-y-auto">
		{#if isGlob}
			<!-- Glob: simple file list -->
			{#if globFiles.length === 0}
				<p class="px-3 py-2 text-xs text-[var(--color-text-muted)] italic">No files found</p>
			{:else}
				<div class="py-1">
					{#each globFiles as file}
						<div class="px-3 py-0.5 text-xs font-mono text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-secondary)]/50 truncate">
							{file}
						</div>
					{/each}
				</div>
			{/if}
		{:else}
			<!-- Grep: grouped by file with collapsible sections -->
			{#if grepGroups.length === 0}
				<p class="px-3 py-2 text-xs text-[var(--color-text-muted)] italic">No matches found</p>
			{:else}
				{#each grepGroups as group, i}
					{@const isExpanded = expandedSections.has(i)}
					<div class="border-b border-[var(--color-border)] last:border-b-0">
						<button
							onclick={() => toggleSection(i)}
							class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--color-surface-secondary)]/50 transition-colors"
						>
							<svg class="h-2.5 w-2.5 shrink-0 transition-transform text-[var(--color-text-muted)] {isExpanded ? 'rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
							</svg>
							<span class="font-mono text-[var(--color-text-primary)] truncate">{group.filePath}</span>
							<span class="ml-auto shrink-0 rounded-full bg-[var(--color-surface-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
								{group.matches.length}
							</span>
						</button>
						{#if isExpanded}
							<div class="pb-1">
								{#each group.matches as match}
									<div class="flex px-3 py-0.5 text-xs font-mono hover:bg-[var(--color-surface-secondary)]/30">
										<span class="w-10 shrink-0 text-right pr-2 text-[var(--color-text-muted)] select-none">{match.lineNum}</span>
										<span class="text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">{match.content}</span>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		{/if}
	</div>
</div>
