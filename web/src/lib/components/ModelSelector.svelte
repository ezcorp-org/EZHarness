<script lang="ts">
	import { onMount } from "svelte";
	import { handleComboboxKeydown } from "$lib/combobox-nav";
	import { addToast } from "$lib/toast.svelte.js";
	import ProviderIcon from "./ProviderIcon.svelte";

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
	}: {
		selected: { provider: string; model: string } | null;
		onselect: (provider: string, model: string) => void;
		onreasoningchange?: (reasoning: boolean) => void;
		oncontextwindowchange?: (contextWindow: number | null) => void;
		onautoselect?: (provider: string, model: string) => void;
	} = $props();

	let models = $state<ModelOption[]>([]);
	let open = $state(false);
	let search = $state("");
	let highlightIndex = $state(-1);
	let searchInput: HTMLInputElement | undefined = $state();


	const TIER_ORDER = ["powerful", "balanced", "fast"] as const;
	const TIER_LABELS: Record<string, string> = { fast: "Fast", balanced: "Balanced", powerful: "Powerful" };
	const COST_LABELS: Record<string, string> = { low: "$", medium: "$$", high: "$$$" };

	// Group models by their non-numeric prefix (e.g., "claude-opus" for
	// "claude-opus-4-6"), preserve first-seen family order, and within each
	// family put newer versions (higher numbers) first.
	function sortNewestFirst(list: ModelOption[]): ModelOption[] {
		const familyOrder: string[] = [];
		const byFamily = new Map<string, ModelOption[]>();
		for (const m of list) {
			const leading = m.model.match(/^[^\d]+/)?.[0] ?? m.model;
			const key = leading.replace(/[-_.\s]+$/, "").toLowerCase();
			if (!byFamily.has(key)) {
				byFamily.set(key, []);
				familyOrder.push(key);
			}
			byFamily.get(key)!.push(m);
		}
		for (const arr of byFamily.values()) {
			arr.sort((a, b) => b.model.localeCompare(a.model, undefined, { numeric: true }));
		}
		return familyOrder.flatMap((k) => byFamily.get(k)!);
	}

	async function loadModels(attempt = 0) {
		try {
			const res = await fetch("/api/models");
			if (res.ok) {
				const data: ModelOption[] = await res.json();
				models = data.filter((m) => m.available);
				if (selected) {
					const m = models.find((m) => m.provider === selected!.provider && m.model === selected!.model);
					onreasoningchange?.(!!m?.reasoning);
					oncontextwindowchange?.(m?.contextWindow ?? null);
				} else if (models.length > 0) {
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

	let groupedModels = $derived.by(() => {
		const groups: { tier: string; label: string; models: ModelOption[] }[] = [];
		for (const tier of TIER_ORDER) {
			const tierModels = filteredModels.filter((m) => m.tier === tier);
			if (tierModels.length > 0) groups.push({ tier, label: TIER_LABELS[tier] ?? tier, models: sortNewestFirst(tierModels) });
		}
		const knownTiers = new Set(TIER_ORDER);
		const otherModels = filteredModels.filter((m) => !knownTiers.has(m.tier as (typeof TIER_ORDER)[number]));
		if (otherModels.length > 0) groups.push({ tier: "other", label: "Other", models: sortNewestFirst(otherModels) });
		return groups;
	});

	// Flat list for keyboard nav — must match the rendered (group-sorted) order
	let flatFiltered = $derived(groupedModels.flatMap((g) => g.models));

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
			itemCount: flatFiltered.length,
			highlightIndex,
			onSelect: (i) => {
				const m = flatFiltered[i];
				if (m) selectModel(m.provider, m.model);
			},
			onClose: close,
		});
		if (result !== null) highlightIndex = result;
	}

	// Compute flat index for a model to check highlight
	function flatIndex(m: ModelOption): number {
		return flatFiltered.indexOf(m);
	}

	let displayLabel = $derived(() => {
		if (!selected) return "Select model";
		const m = models.find((m) => m.provider === selected!.provider && m.model === selected!.model);
		const name = m?.displayName ?? selected.model;
		return name.length > 24 ? name.slice(0, 24) + "..." : name;
	});


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
		{#if selected}
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
