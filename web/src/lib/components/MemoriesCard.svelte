<script lang="ts">
	import { slide } from "svelte/transition";
	import Brain from "lucide-svelte/icons/brain";

	type Memory = { id: string; content: string; category: string };

	let { memories }: { memories: Memory[] } = $props();

	let expanded = $state(false);

	let previewText = $derived.by((): string => {
		const first = memories[0]?.content ?? "";
		const flat = first.slice(0, 80).replace(/\n/g, " ").trim();
		return first.length > 80 ? flat + "..." : flat;
	});

	let countLabel = $derived(`${memories.length} ${memories.length === 1 ? "memory" : "memories"}`);
</script>

<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] overflow-hidden">
	<!-- Collapsed header -->
	<button
		onclick={() => (expanded = !expanded)}
		class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-secondary)]/50 transition-colors"
		aria-expanded={expanded}
	>
		<!-- Brain icon (lucide) — matches other "memory/thinking" affordances in the chat UI. -->
		<Brain class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" strokeWidth={1.5} />

		<!-- Label + preview/count -->
		<span class="shrink-0 text-[var(--color-text-secondary)] font-medium">Memories</span>
		{#if !expanded}
			<span class="truncate text-[var(--color-text-muted)] text-xs font-normal">{previewText}</span>
			<span class="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{countLabel}</span>
		{/if}

		<!-- Expand indicator -->
		<svg
			class="{expanded ? 'ml-2' : 'ml-1'} h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] transition-transform {expanded ? 'rotate-180' : ''}"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			stroke-width="2"
		>
			<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
		</svg>
	</button>

	<!-- Expanded content -->
	{#if expanded}
		<div
			transition:slide={{ duration: 150 }}
			class="border-t border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)] max-h-96 overflow-y-auto"
		>
			<ul class="space-y-0.5">
				{#each memories as mem (mem.id)}
					<li>
						<a
							href="/memories?focus={mem.id}"
							class="flex gap-2 rounded px-1.5 py-1 -mx-1.5 hover:bg-[var(--color-surface-secondary)]/60 transition-colors"
							title="Open in Memories"
						>
							<span class="shrink-0 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] mt-0.5">[{mem.category}]</span>
							<span class="min-w-0 break-words">{mem.content}</span>
						</a>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
