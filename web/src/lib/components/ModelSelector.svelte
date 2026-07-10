<script lang="ts">
	import { onMount } from "svelte";
	import { handleComboboxKeydown } from "$lib/combobox-nav";
	import { addToast } from "$lib/toast.svelte.js";
	import ProviderIcon from "./ProviderIcon.svelte";
	import {
		AUTO_MODEL,
		AUTO_PROVIDER,
		autoRowVisible,
		displayLabel as computeDisplayLabel,
		filterAvailable,
		groupModels,
		isAutoSelection,
		shouldAutoSelectDefault,
		type ModelSelection,
	} from "$lib/model-selector-logic.js";

	interface ModelOption {
		provider: string;
		model: string;
		tier: string;
		costTier: string;
		reasoning?: boolean;
		displayName?: string;
		available: boolean;
		contextWindow?: number;
	}

	const MAX_RETRIES = 3;

	let {
		selected,
		onselect,
		onreasoningchange,
		oncontextwindowchange,
		onautoselect,
		allowAuto = false,
		autoServed = null,
	}: {
		selected: { provider: string; model: string } | null;
		onselect: (provider: string, model: string) => void;
		onreasoningchange?: (reasoning: boolean) => void;
		oncontextwindowchange?: (contextWindow: number | null) => void;
		onautoselect?: (provider: string, model: string) => void;
		/** Offer the "Auto (smart routing)" row. Opt-in — only chat
		 *  composers that speak the explicit-null wire sentinel should
		 *  enable it (agent-config / board-default pickers must never
		 *  persist the "auto" sentinel strings). */
		allowAuto?: boolean;
		/** The model a routed turn was actually served by, when known —
		 *  renders the button label as "Auto → <model>" while Auto stays
		 *  the active selection. */
		autoServed?: ModelSelection | null;
	} = $props();

	let models = $state<ModelOption[]>([]);
	let open = $state(false);
	let search = $state("");
	let highlightIndex = $state(-1);
	let searchInput: HTMLInputElement | undefined = $state();


	const COST_LABELS: Record<string, string> = { low: "$", medium: "$$", high: "$$$" };

	async function loadModels(attempt = 0) {
		try {
			const res = await fetch("/api/models");
			if (res.ok) {
				const data: ModelOption[] = await res.json();
				models = filterAvailable(data);
				if (selected) {
					const m = models.find((m) => m.provider === selected!.provider && m.model === selected!.model);
					onreasoningchange?.(!!m?.reasoning);
					oncontextwindowchange?.(m?.contextWindow ?? null);
				} else if (shouldAutoSelectDefault(selected, models)) {
					onautoselect?.(models[0]!.provider, models[0]!.model);
				}
				return;
			}
		} catch {}
		if (attempt < MAX_RETRIES - 1) {
			await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
			return loadModels(attempt + 1);
		}
		addToast({ type: "warning", message: "Failed to load models. Check your API keys in Settings." });
	}

	onMount(() => { loadModels(); });

	// Re-evaluate reasoning capability whenever selected model or models list changes
	$effect(() => {
		if (selected && models.length > 0) {
			const m = models.find((m) => m.provider === selected!.provider && m.model === selected!.model);
			onreasoningchange?.(!!m?.reasoning);
			oncontextwindowchange?.(m?.contextWindow ?? null);
		}
	});

	let filteredModels = $derived.by(() => {
		if (!search.trim()) return models;
		const q = search.toLowerCase();
		return models.filter(m =>
			(m.displayName ?? m.model).toLowerCase().includes(q) ||
			m.provider.toLowerCase().includes(q) ||
			m.tier.toLowerCase().includes(q)
		);
	});

	let groupedModels = $derived(groupModels(filteredModels));

	// Flat list for keyboard nav — must match the rendered (group-sorted) order
	let flatFiltered = $derived(groupedModels.flatMap((g) => g.models));

	// The Auto row sits ABOVE the model groups and participates in keyboard
	// nav as index 0 when visible; real models shift down by `navOffset`.
	let showAutoRow = $derived(autoRowVisible(allowAuto, search));
	let navOffset = $derived(showAutoRow ? 1 : 0);
	let autoActive = $derived(isAutoSelection(selected));

	// Reset highlight when search changes
	$effect(() => { search; highlightIndex = 0; });

	function selectModel(provider: string, model: string) {
		onselect(provider, model);
		open = false;
		search = "";
		highlightIndex = -1;
		const m = models.find((m) => m.provider === provider && m.model === model);
		onreasoningchange?.(!!m?.reasoning);
		oncontextwindowchange?.(m?.contextWindow ?? null);
	}

	function selectAuto() {
		onselect(AUTO_PROVIDER, AUTO_MODEL);
		open = false;
		search = "";
		highlightIndex = -1;
		// No concrete model yet — routing picks per-turn capabilities.
		onreasoningchange?.(false);
		oncontextwindowchange?.(null);
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
			itemCount: flatFiltered.length + navOffset,
			highlightIndex,
			onSelect: (i) => {
				if (showAutoRow && i === 0) {
					selectAuto();
					return;
				}
				const m = flatFiltered[i - navOffset];
				if (m) selectModel(m.provider, m.model);
			},
			onClose: close,
		});
		if (result !== null) highlightIndex = result;
	}

	// Compute flat index for a model to check highlight
	function flatIndex(m: ModelOption): number {
		return flatFiltered.indexOf(m) + navOffset;
	}

	let displayLabel = $derived(() => computeDisplayLabel(selected, models, autoServed));


	function handleClickOutside(e: MouseEvent) {
		if (!(e.target as HTMLElement).closest(".model-selector")) close();
	}
</script>

<svelte:window onclick={handleClickOutside} />

<div data-testid="model-selector" class="model-selector relative">
	<button
		onclick={toggleOpen}
		class="flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1 text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
		title="AI model — choose which language model powers this conversation"
	>
		{#if autoActive}
			<!-- routing glyph — Auto has no single provider icon -->
			<svg class="h-3 w-3 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
			</svg>
		{:else if selected}
			<ProviderIcon provider={selected.provider} size="xs" />
		{/if}
		<span>{displayLabel()}</span>
		<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
		</svg>
	</button>

	{#if open}
		<div class="absolute bottom-full left-0 mb-1 w-72 max-h-80 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] py-1 shadow-xl z-50 flex flex-col">
			<div class="px-3 py-1.5 border-b border-[var(--color-border)]">
				<div class="text-xs font-medium text-[var(--color-text-primary)]">Choose a model</div>
				<div class="text-[10px] text-[var(--color-text-muted)] mb-1.5">Faster models are cheaper, powerful models are smarter</div>
				<input
					bind:this={searchInput}
					bind:value={search}
					onkeydown={handleKeydown}
					type="text"
					placeholder="Search models..."
					class="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
					role="combobox"
					aria-expanded={open}
					aria-controls="model-selector-listbox"
					aria-activedescendant={highlightIndex >= 0 ? `model-option-${highlightIndex}` : undefined}
				/>
			</div>
			<div id="model-selector-listbox" class="overflow-y-auto flex-1" role="listbox">
				{#if showAutoRow}
					<button
						id="model-option-0"
						data-testid="model-option-auto"
						onclick={selectAuto}
						onmouseenter={() => { highlightIndex = 0; }}
						role="option"
						aria-selected={autoActive}
						class="flex w-full items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 text-left text-xs transition-colors
							{highlightIndex === 0 ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' :
							autoActive ? 'text-[var(--color-text-primary)] bg-[var(--color-surface-tertiary)]/50' : 'text-[var(--color-text-secondary)]'}"
					>
						<svg class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
						</svg>
						<span class="min-w-0 flex-1">
							<span class="block truncate">Auto (smart routing)</span>
							<span class="block truncate text-[10px] text-[var(--color-text-muted)]">Picks a tier-fit model for this conversation</span>
						</span>
					</button>
				{/if}
				{#if filteredModels.length === 0}
					<div class="px-3 py-2 text-xs text-[var(--color-text-muted)]">
						{models.length === 0 ? "No models available. Check API keys." : "No models match your search."}
					</div>
				{:else}
					{#each groupedModels as group}
						<div class="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
							{group.label}
						</div>
						{#each group.models as m}
							{@const idx = flatIndex(m)}
							{@const cost = COST_LABELS[m.costTier] ?? ""}
							<button
								id="model-option-{idx}"
								onclick={() => selectModel(m.provider, m.model)}
								onmouseenter={() => { highlightIndex = idx; }}
								role="option"
								aria-selected={selected?.provider === m.provider && selected?.model === m.model}
								class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors
									{idx === highlightIndex ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' :
									selected?.provider === m.provider && selected?.model === m.model ? 'text-[var(--color-text-primary)] bg-[var(--color-surface-tertiary)]/50' : 'text-[var(--color-text-secondary)]'}"
							>
								<ProviderIcon provider={m.provider} size="sm" />
								<span class="min-w-0 flex-1 truncate">{m.displayName ?? m.model}</span>
								{#if cost}
									<span class="shrink-0 text-[10px] text-[var(--color-text-muted)]">{cost}</span>
								{/if}
							</button>
						{/each}
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>
