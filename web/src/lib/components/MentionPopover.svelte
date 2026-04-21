<script lang="ts" module>
	export type MentionItem = {
		name: string;
		description: string;
		/**
		 * Concrete kind. `dir-target` is a synthetic entry (not from the API)
		 * the popover injects at the top of the list when the user is in a
		 * descended folder view — selecting it commits the current folder as
		 * a `@[dir:…]` token instead of descending further.
		 */
		kind: 'agent' | 'extension' | 'team' | 'file' | 'dir' | 'dir-target' | 'command';
		/**
		 * For `command` kind: origin namespace, e.g. `"project:claude-commands"`,
		 * `"user:codex-prompts"`, `"user:db"`. Rendered as a scope + folder
		 * badge so users can tell where the command was loaded from.
		 */
		source?: string;
	};
</script>

<script lang="ts">
	import { formatPathDisplay } from "$lib/mention-logic";
	import { commandSourceLabel } from "$lib/command-source-label";

	let {
		items,
		open,
		loading,
		triggerQuery = "",
		onselect,
		ondismiss,
	}: {
		items: MentionItem[];
		open: boolean;
		loading: boolean;
		/**
		 * The current `@`/`!` trigger query (everything after the sigil up to
		 * the cursor). When this ends with `/` we inject a synthetic
		 * "Use this folder as path" entry at the top so the user can commit
		 * the current descent root without navigating further.
		 */
		triggerQuery?: string;
		onselect: (item: MentionItem) => void;
		ondismiss: () => void;
	} = $props();

	let highlightedIndex = $state(0);
	let listboxEl = $state<HTMLDivElement | null>(null);

	// Group items. The `@` sigil surfaces both files AND dirs (mutually
	// exclusive with agent/ext/team results). Folders come before files so
	// the "navigate into" target is surfaced first.
	let teams = $derived(items.filter((i) => i.kind === 'team'));
	let agents = $derived(items.filter((i) => i.kind === 'agent'));
	let extensions = $derived(items.filter((i) => i.kind === 'extension'));
	let commands = $derived(items.filter((i) => i.kind === 'command'));
	let dirs = $derived(items.filter((i) => i.kind === 'dir'));
	let files = $derived(items.filter((i) => i.kind === 'file'));

	// Synthetic "Use this folder as path" entry — only shown when the user
	// is in a descended view (trigger query ends with `/`). Its `name` is
	// the current descent path (trailing slashes stripped) so a parent can
	// insert `@[dir:<name>]` directly.
	let targetPath = $derived.by(() => {
		if (!triggerQuery.endsWith("/")) return "";
		return triggerQuery.replace(/\/+$/, "");
	});
	let dirTarget = $derived<MentionItem[]>(
		targetPath
			? [{
				name: targetPath,
				description: `Use this folder as path: ${targetPath}`,
				kind: "dir-target",
			}]
			: [],
	);

	// `dir-target` always leads the list so the commit action is the most
	// prominent thing when the user is in a descended view.
	let flatItems = $derived([
		...dirTarget,
		...commands,
		...teams,
		...agents,
		...extensions,
		...dirs,
		...files,
	]);

	// Reset highlight when items change
	$effect(() => {
		items; // track
		highlightedIndex = 0;
	});

	// Scroll highlighted item into view
	$effect(() => {
		if (!listboxEl) return;
		const el = listboxEl.querySelector(`#mention-item-${highlightedIndex}`);
		el?.scrollIntoView({ block: 'nearest' });
	});

	// Click outside detection
	function handleWrapperClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			ondismiss();
		}
	}

	export function handleKeydown(e: KeyboardEvent) {
		if (!open) return;
		const total = flatItems.length;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			e.stopPropagation();
			if (total > 0) highlightedIndex = (highlightedIndex + 1) % total;
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			e.stopPropagation();
			if (total > 0) highlightedIndex = highlightedIndex <= 0 ? total - 1 : highlightedIndex - 1;
			return;
		}
		if (e.key === 'Enter' || e.key === 'Tab') {
			e.preventDefault();
			e.stopPropagation();
			if (highlightedIndex >= 0 && highlightedIndex < total) {
				onselect(flatItems[highlightedIndex]);
			}
			return;
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			ondismiss();
			return;
		}
	}

	// Expose highlightedIndex for parent ARIA attributes
	export function getHighlightedIndex() {
		return highlightedIndex;
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="absolute bottom-full left-0 right-0 z-50 mb-2" onclick={handleWrapperClick}>
		<div
			bind:this={listboxEl}
			id="mention-listbox"
			role="listbox"
			aria-label="Mentions"
			class="max-h-[240px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-lg"
		>
			{#if loading}
				<div class="px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">Searching...</div>
			{:else if flatItems.length === 0}
				<div class="px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">No matches found</div>
			{:else}
				{#if dirTarget.length > 0}
					{@const target = dirTarget[0]}
					<div class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
						Current folder
					</div>
					<button
						id="mention-item-0"
						role="option"
						aria-selected={0 === highlightedIndex}
						class="flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors border-l-2 border-amber-500/60 {0 === highlightedIndex
							? 'bg-[var(--color-surface-tertiary)]'
							: 'hover:bg-[var(--color-surface-tertiary)]/50'}"
						onclick={() => onselect(target)}
						onmouseenter={() => (highlightedIndex = 0)}
					>
						<span class="text-sm font-medium text-amber-300">📁 Use this folder as path</span>
						<span class="truncate text-xs text-[var(--color-text-muted)]">{target.name}/</span>
					</button>
				{/if}

				{#if commands.length > 0}
					<div class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
						Slash commands
					</div>
					{#each commands as item, i}
						{@const idx = dirTarget.length + i}
						{@const label = commandSourceLabel(item.source)}
						<button
							id="mention-item-{idx}"
							data-source={item.source}
							role="option"
							aria-selected={idx === highlightedIndex}
							class="flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors border-l-2 border-pink-500/60 {idx === highlightedIndex
								? 'bg-[var(--color-surface-tertiary)]'
								: 'hover:bg-[var(--color-surface-tertiary)]/50'}"
							onclick={() => onselect(item)}
							onmouseenter={() => (highlightedIndex = idx)}
						>
							<div class="flex items-baseline gap-2">
								<span class="text-sm font-medium text-pink-300">/{item.name}</span>
								{#if label}
									<span
										class="shrink-0 rounded-sm border border-pink-500/30 bg-pink-500/10 px-1 py-0 text-[10px] font-normal uppercase tracking-wide text-pink-200/90"
										title="Source: {item.source}"
									>
										<span class="font-semibold">{label.scope}</span>
										<span class="mx-0.5 opacity-50">·</span>
										<span class="font-mono opacity-90">{label.folder}</span>
									</span>
								{/if}
							</div>
							<span class="truncate text-xs text-[var(--color-text-muted)]">{item.description}</span>
						</button>
					{/each}
				{/if}

				{#if teams.length > 0}
					<div class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
						Teams
					</div>
					{#each teams as item, i}
						{@const idx = dirTarget.length + commands.length + i}
						<button
							id="mention-item-{idx}"
							role="option"
							aria-selected={idx === highlightedIndex}
							class="flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors {idx === highlightedIndex
								? 'bg-[var(--color-surface-tertiary)]'
								: 'hover:bg-[var(--color-surface-tertiary)]/50'}"
							onclick={() => onselect(item)}
							onmouseenter={() => (highlightedIndex = idx)}
						>
							<span class="text-sm font-medium text-[var(--color-text-primary)]">{item.name}</span>
							<span class="truncate text-xs text-[var(--color-text-muted)]">{item.description}</span>
						</button>
					{/each}
				{/if}

				{#if agents.length > 0}
					<div class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
						Agents
					</div>
					{#each agents as item, i}
						{@const idx = dirTarget.length + commands.length + teams.length + i}
						<button
							id="mention-item-{idx}"
							role="option"
							aria-selected={idx === highlightedIndex}
							class="flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors {idx === highlightedIndex
								? 'bg-[var(--color-surface-tertiary)]'
								: 'hover:bg-[var(--color-surface-tertiary)]/50'}"
							onclick={() => onselect(item)}
							onmouseenter={() => (highlightedIndex = idx)}
						>
							<span class="text-sm font-medium text-[var(--color-text-primary)]">{item.name}</span>
							<span class="truncate text-xs text-[var(--color-text-muted)]">{item.description}</span>
						</button>
					{/each}
				{/if}

				{#if extensions.length > 0}
					<div class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
						Extensions
					</div>
					{#each extensions as item, i}
						{@const idx = dirTarget.length + commands.length + teams.length + agents.length + i}
						<button
							id="mention-item-{idx}"
							role="option"
							aria-selected={idx === highlightedIndex}
							class="flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors {idx === highlightedIndex
								? 'bg-[var(--color-surface-tertiary)]'
								: 'hover:bg-[var(--color-surface-tertiary)]/50'}"
							onclick={() => onselect(item)}
							onmouseenter={() => (highlightedIndex = idx)}
						>
							<span class="text-sm font-medium text-[var(--color-text-primary)]">{item.name}</span>
							<span class="truncate text-xs text-[var(--color-text-muted)]">{item.description}</span>
						</button>
					{/each}
				{/if}

				{#if dirs.length > 0}
					<div class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
						Folders
					</div>
					{#each dirs as item, i}
						{@const idx = dirTarget.length + commands.length + teams.length + agents.length + extensions.length + i}
						<button
							id="mention-item-{idx}"
							role="option"
							aria-selected={idx === highlightedIndex}
							title={item.description}
							class="flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors {idx === highlightedIndex
								? 'bg-[var(--color-surface-tertiary)]'
								: 'hover:bg-[var(--color-surface-tertiary)]/50'}"
							onclick={() => onselect(item)}
							onmouseenter={() => (highlightedIndex = idx)}
						>
							<span class="text-sm font-medium text-[var(--color-text-primary)]">{formatPathDisplay(item.name)}/</span>
							<span class="truncate text-xs text-[var(--color-text-muted)]">{item.description}</span>
						</button>
					{/each}
				{/if}

				{#if files.length > 0}
					<div class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
						Files
					</div>
					{#each files as item, i}
						{@const idx = dirTarget.length + commands.length + teams.length + agents.length + extensions.length + dirs.length + i}
						<button
							id="mention-item-{idx}"
							role="option"
							aria-selected={idx === highlightedIndex}
							title={item.description}
							class="flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors {idx === highlightedIndex
								? 'bg-[var(--color-surface-tertiary)]'
								: 'hover:bg-[var(--color-surface-tertiary)]/50'}"
							onclick={() => onselect(item)}
							onmouseenter={() => (highlightedIndex = idx)}
						>
							<span class="text-sm font-medium text-[var(--color-text-primary)]">{formatPathDisplay(item.name)}</span>
							<span class="truncate text-xs text-[var(--color-text-muted)]">{item.description}</span>
						</button>
					{/each}
				{/if}
			{/if}
		</div>
	</div>
{/if}
