<script lang="ts">
	import { inputClass } from "$lib/styles.js";
	import { fetchModes, type Mode } from "$lib/api";
	import { onMount } from "svelte";
	import SelectedPill from "./SelectedPill.svelte";

	let {
		selected = null,
		placeholder = "Search modes...",
		onselect,
	}: {
		selected?: string | null;
		placeholder?: string;
		onselect: (mode: Mode | null) => void;
	} = $props();

	const RESTRICTION_BADGES: Record<string, string> = {
		all: "All tools",
		"read-only": "Read-only",
		none: "No tools",
	};

	let modes = $state<Mode[]>([]);
	let inputEl: HTMLInputElement | undefined = $state();
	let query = $state("");
	let open = $state(false);
	let highlightIdx = $state(-1);
	let dropdownStyle = $state("");

	onMount(async () => {
		try { modes = await fetchModes(); } catch { /* non-fatal */ }
	});

	let filtered = $derived(() => {
		if (!query.trim()) return modes;
		const lq = query.toLowerCase();
		return modes.filter(
			(m) =>
				m.name.toLowerCase().includes(lq) ||
				m.description.toLowerCase().includes(lq) ||
				m.slug.toLowerCase().includes(lq),
		);
	});

	let displayText = $derived(() => {
		if (!selected) return "";
		const m = modes.find((m) => m.id === selected);
		return m ? `${m.icon ?? ""} ${m.name}`.trim() : selected;
	});

	function computePosition() {
		if (!inputEl) return;
		const rect = inputEl.getBoundingClientRect();
		dropdownStyle = `position:fixed;left:${rect.left}px;top:${rect.bottom + 2}px;width:${Math.max(rect.width, 320)}px;z-index:9999;`;
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

	function selectMode(m: Mode | null) {
		onselect(m);
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

	function onFocus() { if (!open) openDropdown(); }
	function onBlur() { setTimeout(closeDropdown, 150); }

	function onKeydown(e: KeyboardEvent) {
		const items = filtered();
		const total = items.length + 1; // +1 for "None" option
		if (!open || total === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			highlightIdx = Math.min(highlightIdx + 1, total - 1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			highlightIdx = Math.max(highlightIdx - 1, 0);
		} else if (e.key === "Enter" && highlightIdx >= 0) {
			e.preventDefault();
			if (highlightIdx === 0) selectMode(null);
			else selectMode(items[highlightIdx - 1]!);
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

<!-- Combobox chrome — single-select. Pill (when set) sits on a row above
     the input so the input keeps its full width. × on the pill clears the
     selection via selectMode(null). -->
<div
	class="{inputClass} flex w-full flex-col gap-1 p-2 text-sm"
	data-testid="mode-picker-combobox"
>
	{#if selected && !open}
		<div class="flex flex-wrap gap-1">
			<SelectedPill label={displayText()} onremove={() => selectMode(null)} />
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
			aria-expanded={open}
			aria-controls="mode-picker-listbox"
			aria-haspopup="listbox"
			aria-autocomplete="list"
			aria-activedescendant={highlightIdx >= 0 ? `mode-picker-item-${highlightIdx}` : undefined}
			autocomplete="off"
			class="w-full border-0 bg-transparent pl-6 pr-0 py-0 text-sm outline-none focus:ring-0"
		/>
	</div>
</div>

{#if open}
	{@const items = filtered()}
	<div style={dropdownStyle}>
		<ul
			id="mode-picker-listbox"
			class="max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-lg"
			role="listbox"
			aria-label="Available modes"
		>
			<!-- "None / Inherited" option -->
			<li id="mode-picker-item-0" role="option" aria-selected={highlightIdx === 0}>
				<button
					type="button"
					tabindex="-1"
					class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors {highlightIdx === 0
						? 'bg-[var(--color-surface-tertiary)]'
						: 'bg-[var(--color-surface-secondary)] hover:bg-[var(--color-surface-tertiary)]'}"
					onmousedown={() => selectMode(null)}
					onmouseenter={() => (highlightIdx = 0)}
				>
					<span class="text-sm text-[var(--color-text-secondary)]">Inherited (no override)</span>
				</button>
			</li>

			{#each items as mode, i (mode.id)}
				{@const idx = i + 1}
				<li id="mode-picker-item-{idx}" role="option" aria-selected={idx === highlightIdx}>
					<button
						type="button"
						tabindex="-1"
						class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors {idx === highlightIdx
							? 'bg-[var(--color-surface-tertiary)]'
							: 'bg-[var(--color-surface-secondary)] hover:bg-[var(--color-surface-tertiary)]'}"
						onmousedown={() => selectMode(mode)}
						onmouseenter={() => (highlightIdx = idx)}
					>
						{#if mode.icon}
							<span class="text-base">{mode.icon}</span>
						{/if}
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-1.5">
								<span class="text-sm font-medium text-[var(--color-text-primary)]">{mode.name}</span>
								<span class="rounded bg-[var(--color-surface-primary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">{RESTRICTION_BADGES[mode.toolRestriction] ?? mode.toolRestriction}</span>
								{#if mode.builtin}
									<span class="text-[10px] text-[var(--color-text-muted)]">built-in</span>
								{/if}
							</div>
							{#if idx === highlightIdx && mode.description}
								<p class="mt-0.5 text-xs text-[var(--color-text-muted)]">{mode.description}</p>
							{/if}
						</div>
					</button>
				</li>
			{/each}

			{#if items.length === 0}
				<li class="px-3 py-3 text-center text-xs text-[var(--color-text-muted)]">
					{query ? "No matching modes" : "No modes available"}
				</li>
			{/if}
		</ul>
	</div>
{/if}
