<script lang="ts">
	import { inputClass } from "$lib/styles.js";
	import { onMount } from "svelte";
	import ProviderIcon from "./ProviderIcon.svelte";
	import SelectedPill from "./SelectedPill.svelte";
	import { PROVIDER_META, canonicalProvider } from "$lib/provider-meta.js";
	import { CURRENT_MODEL_SENTINEL } from "$lib/api";

	interface ModelOption {
		provider: string;
		model: string;
		tier: string;
		costTier: string;
		reasoning?: boolean;
		displayName?: string;
		available: boolean;
	}

	let {
		selected = null,
		placeholder = "Search models...",
		onselect,
		onclear,
	}: {
		selected?: { provider: string; model: string } | null;
		placeholder?: string;
		onselect: (provider: string, model: string) => void;
		/** Optional: when set, the selected-model pill shows an × that calls
		 *  this. Callers choose their own clear semantic (e.g. reset to
		 *  CURRENT_MODEL_SENTINEL vs. wipe to undefined). If omitted, the
		 *  pill still renders but without the × button. */
		onclear?: () => void;
	} = $props();


	const COST_LABELS: Record<string, string> = { low: "$", medium: "$$", high: "$$$" };

	const CURRENT_OPTION: ModelOption = {
		provider: CURRENT_MODEL_SENTINEL,
		model: CURRENT_MODEL_SENTINEL,
		tier: "",
		costTier: "",
		displayName: "Current Chat Model",
		available: true,
	};

	function isCurrent(m: { provider: string; model: string } | null): boolean {
		return m?.provider === CURRENT_MODEL_SENTINEL && m?.model === CURRENT_MODEL_SENTINEL;
	}

	let models = $state<ModelOption[]>([]);
	let inputEl: HTMLInputElement | undefined = $state();
	let query = $state("");
	let open = $state(false);
	let highlightIdx = $state(-1);
	let dropdownStyle = $state("");

	onMount(async () => {
		try {
			const res = await fetch("/api/models");
			if (res.ok) {
				const data: ModelOption[] = await res.json();
				models = data.filter((m) => m.available);
			}
		} catch { /* non-fatal */ }
	});

	let filtered = $derived(() => {
		const lq = query.trim().toLowerCase();
		const realModels = lq
			? models.filter(
				(m) =>
					m.model.toLowerCase().includes(lq) ||
					(m.displayName?.toLowerCase().includes(lq)) ||
					m.provider.toLowerCase().includes(lq) ||
					m.tier.toLowerCase().includes(lq),
			)
			: models;
		// Prepend the "Current Chat Model" option when query is empty or matches
		if (!lq || "current chat model".includes(lq) || "current".includes(lq)) {
			return [CURRENT_OPTION, ...realModels];
		}
		return realModels;
	});

	let displayText = $derived(() => {
		if (!selected) return "";
		if (isCurrent(selected)) return "Current Chat Model";
		const m = models.find((m) => m.provider === selected!.provider && m.model === selected!.model);
		return m?.displayName ?? selected!.model;
	});

	function computePosition() {
		if (!inputEl) return;
		const rect = inputEl.getBoundingClientRect();
		dropdownStyle = `position:fixed;left:${rect.left}px;top:${rect.bottom + 2}px;width:${Math.max(rect.width, 360)}px;z-index:9999;`;
	}

	function openDropdown() {
		open = true;
		highlightIdx = -1;
		query = "";
		computePosition();
	}

	function closeDropdown() {
		open = false;
		highlightIdx = -1;
	}

	function selectModel(m: ModelOption) {
		onselect(m.provider, m.model);
		query = "";
		closeDropdown();
		inputEl?.blur();
	}

	function onInput() {
		query = inputEl?.value ?? "";
		highlightIdx = -1;
		if (!open) openDropdown();
		else computePosition();
	}

	function onFocus() {
		if (!open) openDropdown();
	}

	function onBlur() {
		setTimeout(closeDropdown, 150);
	}

	function onKeydown(e: KeyboardEvent) {
		const items = filtered();
		if (!open || items.length === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			highlightIdx = Math.min(highlightIdx + 1, items.length - 1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			highlightIdx = Math.max(highlightIdx - 1, 0);
		} else if (e.key === "Enter" && highlightIdx >= 0) {
			e.preventDefault();
			selectModel(items[highlightIdx]!);
		} else if (e.key === "Escape") {
			closeDropdown();
		}
	}

	function onClickOutside(e: MouseEvent) {
		if (!open) return;
		if (inputEl?.contains(e.target as Node)) return;
		closeDropdown();
	}
</script>

<svelte:document onclick={onClickOutside} />

<!-- Combobox chrome — single-select. Pill sits on its own row above the
     input so the input keeps its full chrome width. The pill's × fires
     onclear (if provided) to clear the selection. -->
<div
	class="{inputClass} flex w-full flex-col gap-1 p-2 text-sm"
	data-testid="model-picker-combobox"
>
	{#if selected && !open}
		<div class="flex flex-wrap gap-1">
			{#if onclear}
				<SelectedPill label={displayText()} onremove={onclear} />
			{:else}
				<span class="inline-flex max-w-full items-center rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]" data-testid="selected-pill-readonly">
					{displayText()}
				</span>
			{/if}
		</div>
	{/if}
	<div class="relative">
		<svg class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
		</svg>
		<input
			type="text"
			bind:this={inputEl}
			value={open ? query : ""}
			oninput={onInput}
			onfocus={onFocus}
			onblur={onBlur}
			onkeydown={onKeydown}
			placeholder={selected && !open ? "" : placeholder}
			role="combobox"
			aria-label="Search models"
			aria-expanded={open}
			aria-controls="model-picker-listbox"
			aria-haspopup="listbox"
			aria-autocomplete="list"
			aria-activedescendant={highlightIdx >= 0 ? `model-picker-item-${highlightIdx}` : undefined}
			autocomplete="off"
			class="w-full border-0 bg-transparent pl-6 pr-0 py-0 text-sm outline-none focus:ring-0"
		/>
	</div>
</div>

{#if open}
	{@const items = filtered()}
	<div style={dropdownStyle}>
		<ul
			id="model-picker-listbox"
			class="max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-lg"
			role="listbox"
			aria-label="Available models"
		>
			{#if items.length === 0}
				<li role="option" aria-selected="false" class="px-3 py-3 text-center text-xs text-[var(--color-text-muted)]">
					{query ? "No matching models" : "Loading models..."}
				</li>
			{:else}
				{#each items as m, i (m.provider + m.model)}
					<li
						id="model-picker-item-{i}"
						role="option"
						aria-selected={i === highlightIdx}
					>
						<button
							type="button"
							tabindex="-1"
							class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors {i === highlightIdx
								? 'bg-[var(--color-surface-tertiary)]'
								: 'bg-[var(--color-surface-secondary)] hover:bg-[var(--color-surface-tertiary)]'}"
							onmousedown={() => selectModel(m)}
							onmouseenter={() => (highlightIdx = i)}
						>
							{#if isCurrent(m)}
								<svg class="h-4 w-4 shrink-0 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
								</svg>
							{:else}
								<ProviderIcon provider={m.provider} size="sm" />
							{/if}
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-1.5">
									<span class="text-sm font-medium text-[var(--color-text-primary)]">{m.displayName ?? m.model}</span>
									{#if !isCurrent(m)}
										<span class="text-[10px] text-[var(--color-text-muted)]">{COST_LABELS[m.costTier] ?? ""}</span>
										{#if m.reasoning}
											<span class="rounded bg-purple-500/20 px-1 py-0.5 text-[9px] text-purple-300">reasoning</span>
										{/if}
									{:else}
										<span class="text-[10px] text-[var(--color-text-muted)]">Uses the model selected in chat</span>
									{/if}
								</div>
								{#if i === highlightIdx && !isCurrent(m)}
									<div class="mt-0.5 flex gap-2 text-[10px] text-[var(--color-text-muted)]">
										<span>{PROVIDER_META[canonicalProvider(m.provider)]?.shortName ?? m.provider}</span>
										<span class="capitalize">{m.tier}</span>
										<span>{m.model}</span>
									</div>
								{/if}
							</div>
						</button>
					</li>
				{/each}
			{/if}
		</ul>
	</div>
{/if}
