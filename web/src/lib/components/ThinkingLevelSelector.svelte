<script lang="ts">
	import { handleComboboxKeydown } from "$lib/combobox-nav";

	type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

	let {
		selected = "medium",
		onselect,
	}: {
		selected: ThinkingLevel;
		onselect: (level: ThinkingLevel) => void;
	} = $props();

	let open = $state(false);
	let search = $state("");
	let highlightIndex = $state(-1);
	let searchInput: HTMLInputElement | undefined = $state();

	const LEVELS: { value: ThinkingLevel; label: string; hint: string }[] = [
		{ value: "off", label: "Off", hint: "No extended thinking" },
		{ value: "minimal", label: "Minimal", hint: "Quick checks only" },
		{ value: "low", label: "Low", hint: "Light reasoning" },
		{ value: "medium", label: "Medium", hint: "Balanced depth" },
		{ value: "high", label: "High", hint: "Deep analysis" },
		{ value: "xhigh", label: "Max", hint: "Maximum reasoning" },
	];

	let filteredLevels = $derived.by(() => {
		if (!search.trim()) return LEVELS;
		const q = search.toLowerCase();
		return LEVELS.filter(l => l.label.toLowerCase().includes(q) || l.hint.toLowerCase().includes(q));
	});

	$effect(() => { search; highlightIndex = 0; });

	let displayLabel = $derived(LEVELS.find((l) => l.value === selected)?.label ?? "Medium");

	function select(level: ThinkingLevel) {
		onselect(level);
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
			itemCount: filteredLevels.length,
			highlightIndex,
			onSelect: (i) => {
				const l = filteredLevels[i];
				if (l) select(l.value);
			},
			onClose: close,
		});
		if (result !== null) highlightIndex = result;
	}

	function handleClickOutside(e: MouseEvent) {
		if (!(e.target as HTMLElement).closest(".thinking-selector")) close();
	}
</script>

<svelte:window onclick={handleClickOutside} />

<div class="thinking-selector relative">
	<button
		onclick={toggleOpen}
		class="flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
		title="Thinking depth — how long the model reasons before responding"
	>
		<svg class="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
		</svg>
		<span>{displayLabel}</span>
		<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
		</svg>
	</button>

	{#if open}
		<div class="absolute bottom-full left-0 mb-1 w-52 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] py-1 shadow-xl z-50">
			<div class="px-3 py-1.5 border-b border-[var(--color-border)] mb-1">
				<div class="text-xs font-medium text-[var(--color-text-primary)]">Thinking depth</div>
				<div class="text-[10px] text-[var(--color-text-muted)] mb-1.5">Higher = slower but smarter</div>
				<input
					bind:this={searchInput}
					bind:value={search}
					onkeydown={handleKeydown}
					type="text"
					placeholder="Search..."
					class="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
					role="combobox"
					aria-expanded={open}
					aria-activedescendant={highlightIndex >= 0 ? `thinking-option-${highlightIndex}` : undefined}
				/>
			</div>
			<div role="listbox">
				{#each filteredLevels as level, i}
					<button
						id="thinking-option-{i}"
						onclick={() => select(level.value)}
						onmouseenter={() => { highlightIndex = i; }}
						role="option"
						aria-selected={selected === level.value}
						class="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition-colors
							{i === highlightIndex ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' :
							selected === level.value ? 'text-[var(--color-text-primary)] bg-[var(--color-surface-tertiary)]/50' : 'text-[var(--color-text-secondary)]'}"
					>
						<span>{level.label}</span>
						<span class="text-[10px] text-[var(--color-text-muted)]">{level.hint}</span>
					</button>
				{/each}
				{#if filteredLevels.length === 0}
					<div class="px-3 py-2 text-xs text-[var(--color-text-muted)]">No match</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
