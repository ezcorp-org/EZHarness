<script lang="ts">
	import type { Mode } from "$lib/api";
	import { handleComboboxKeydown } from "$lib/combobox-nav";

	let {
		selected = null,
		modes = [],
		onselect,
		oncreate,
	}: {
		selected: Mode | null;
		modes: Mode[];
		onselect: (mode: Mode | null) => void;
		oncreate?: () => void;
	} = $props();

	let open = $state(false);
	let search = $state("");
	let highlightIndex = $state(-1);
	let searchInput: HTMLInputElement | undefined = $state();

	const TOOL_RESTRICTION_LABELS: Record<string, string> = {
		"read-only": "read-only",
		"none": "no tools",
	};

	let filteredModes = $derived.by(() => {
		if (!search.trim()) return modes;
		const q = search.toLowerCase();
		return modes.filter(m => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q));
	});

	// Items list for keyboard nav: Default (null) + filtered modes when not searching,
	// just filtered modes when searching
	let navItems = $derived.by((): (Mode | null)[] => {
		if (search.trim()) return filteredModes;
		return [null, ...filteredModes];
	});

	$effect(() => { search; highlightIndex = 0; });

	function select(mode: Mode | null) {
		onselect(mode);
		open = false;
		search = "";
		highlightIndex = -1;
	}

	function toggleOpen() {
		open = !open;
		if (open) {
			search = "";
			highlightIndex = 0;
			requestAnimationFrame(() => searchInput?.focus());
		}
	}

	function close() {
		open = false;
		search = "";
		highlightIndex = -1;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!open) return;
		const result = handleComboboxKeydown(e, {
			itemCount: navItems.length,
			highlightIndex,
			onSelect: (i) => { select(navItems[i] ?? null); },
			onClose: close,
		});
		if (result !== null) highlightIndex = result;
	}

	function handleClickOutside(e: MouseEvent) {
		if (!(e.target as HTMLElement).closest(".mode-selector")) close();
	}
</script>

<svelte:window onclick={handleClickOutside} />

<div class="mode-selector relative">
	<button
		onclick={toggleOpen}
		class="flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
		title="Chat mode — controls AI behavior, tool access, and system prompt"
	>
		{#if selected}
			<span>{selected.icon ?? ''}</span>
			<span>{selected.name}</span>
		{:else}
			<svg class="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
			</svg>
			<span>Default</span>
		{/if}
		<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
		</svg>
	</button>

	{#if open}
		<div class="absolute bottom-full left-0 mb-1 w-56 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] py-1 shadow-xl z-50">
			<div class="px-3 py-1.5 border-b border-[var(--color-border)] mb-1">
				<div class="text-xs font-medium text-[var(--color-text-primary)]">Chat mode</div>
				<div class="text-[10px] text-[var(--color-text-muted)] mb-1.5">Change how the AI behaves and which tools it can use</div>
				<input
					bind:this={searchInput}
					bind:value={search}
					onkeydown={handleKeydown}
					type="text"
					placeholder="Search modes..."
					class="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
					role="combobox"
					aria-expanded={open}
					aria-activedescendant={highlightIndex >= 0 ? `mode-option-${highlightIndex}` : undefined}
				/>
			</div>

			<div role="listbox">
				<!-- Default (no mode) — hidden when searching -->
				{#if !search.trim()}
					<button
						id="mode-option-0"
						onclick={() => select(null)}
						onmouseenter={() => { highlightIndex = 0; }}
						role="option"
						aria-selected={!selected}
						class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors
							{highlightIndex === 0 ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' :
							!selected ? 'text-[var(--color-text-primary)] bg-[var(--color-surface-tertiary)]/50' : 'text-[var(--color-text-secondary)]'}"
					>
						<span class="w-5 text-center">-</span>
						<div class="min-w-0 flex-1">
							<div class="font-medium">Default</div>
							<div class="text-[10px] text-[var(--color-text-muted)] truncate">Normal chat, full capabilities</div>
						</div>
					</button>
				{/if}

				{#each filteredModes as mode, i}
					{@const idx = search.trim() ? i : i + 1}
					<button
						id="mode-option-{idx}"
						onclick={() => select(mode)}
						onmouseenter={() => { highlightIndex = idx; }}
						role="option"
						aria-selected={selected?.id === mode.id}
						class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors
							{idx === highlightIndex ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' :
							selected?.id === mode.id ? 'text-[var(--color-text-primary)] bg-[var(--color-surface-tertiary)]/50' : 'text-[var(--color-text-secondary)]'}"
					>
						<span class="w-5 text-center">{mode.icon ?? ''}</span>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-1.5">
								<span class="font-medium">{mode.name}</span>
								{#if TOOL_RESTRICTION_LABELS[mode.toolRestriction]}
									<span class="rounded bg-[var(--color-surface-tertiary)] px-1 py-0.5 text-[10px] text-[var(--color-text-muted)]">
										{TOOL_RESTRICTION_LABELS[mode.toolRestriction]}
									</span>
								{/if}
							</div>
							{#if mode.description}
								<div class="text-[10px] text-[var(--color-text-muted)] truncate">{mode.description}</div>
							{/if}
						</div>
					</button>
				{/each}

				{#if search.trim() && filteredModes.length === 0}
					<div class="px-3 py-2 text-xs text-[var(--color-text-muted)]">No modes match your search</div>
				{/if}
			</div>

			<!-- Footer: create + manage -->
			<div class="border-t border-[var(--color-border)] mt-1 pt-1 flex items-center">
				{#if oncreate}
					<button
						onclick={() => { close(); oncreate?.(); }}
						class="flex items-center gap-1.5 px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors flex-1"
					>
						<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
						</svg>
						New mode
					</button>
				{/if}
				<a
					href="/settings#modes"
					onclick={() => { close(); }}
					class="px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors {oncreate ? '' : 'flex-1'}"
				>
					Manage
				</a>
			</div>
		</div>
	{/if}
</div>
