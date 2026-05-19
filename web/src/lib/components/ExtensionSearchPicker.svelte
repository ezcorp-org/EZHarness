<script lang="ts">
	import { inputClass } from "$lib/styles.js";
	import { onMount } from "svelte";
	import SelectedPill from "$lib/components/SelectedPill.svelte";
	// Phase 57 UX-04 — drag-reorderable extension chip row.
	// `use:dndzone` MUST attach to a native <div> (Pitfall 1 — Svelte
	// actions don't attach to components), so the action lives inside
	// this picker on the chip-row div, not on <ExtensionSearchPicker>
	// from the parent.
	import { dndzone } from "svelte-dnd-action";
	import BottomSheet from "$lib/components/BottomSheet.svelte";
	import { useBreakpoint } from "$lib/use-breakpoint.svelte";

	interface ExtensionItem {
		id: string;
		name: string;
		description?: string | null;
	}

	let {
		selected = [],
		placeholder = "Search extensions...",
		onchange,
	}: {
		selected?: string[];
		placeholder?: string;
		onchange: (ids: string[]) => void;
	} = $props();

	// svelte-dnd-action requires `{ id: string, ...rest }` shape on each
	// item (the `id` is the stable key it tracks DOM nodes by). `selected`
	// is already a string[] of extension IDs — wrap each entry into the
	// expected shape.
	function chipItems(): Array<{ id: string }> {
		return selected.map((id) => ({ id }));
	}

	// Drop event — persist the new order. svelte-dnd-action wires this as
	// a `finalize` CustomEvent on the dndzone container; the existing
	// `onchange` callback (already wired in AgentConfigForm.svelte:177)
	// writes the array to `extensions` which the existing PATCH
	// /api/agents/:name route serializes to agentConfigs.extensions JSONB.
	function handleFinalize(e: CustomEvent<{ items: Array<{ id: string }> }>) {
		onchange(e.detail.items.map((it) => it.id));
	}

	// In-flight drag event — emit the live reorder so parent's $state
	// mirrors the drag visually (svelte-dnd-action requires the items
	// reference to mutate during drag, otherwise the reorder snaps back).
	function handleConsider(e: CustomEvent<{ items: Array<{ id: string }> }>) {
		onchange(e.detail.items.map((it) => it.id));
	}

	// Phase 57 UX-01 Wave 2: wrap picker body in BottomSheet on <lg.
	const bp = useBreakpoint("lg");

	let extensions = $state<ExtensionItem[]>([]);
	let inputEl: HTMLInputElement | undefined = $state();
	let query = $state("");
	let open = $state(false);
	let highlightIdx = $state(-1);
	let dropdownStyle = $state("");

	onMount(async () => {
		try {
			const res = await fetch("/api/extensions");
			if (res.ok) {
				const data = await res.json();
				// Endpoint can respond as either a bare array or {extensions: [...]}
				const list: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.extensions) ? data.extensions : [];
				extensions = list.map((e: any) => ({ id: e.id, name: e.name ?? e.id, description: e.description }));
			}
		} catch { /* non-fatal */ }
	});

	let filtered = $derived(() => {
		if (!query.trim()) return extensions;
		const lq = query.toLowerCase();
		return extensions.filter(
			(e) =>
				e.name.toLowerCase().includes(lq) ||
				(e.description ?? "").toLowerCase().includes(lq),
		);
	});

	function nameFor(id: string): string {
		return extensions.find((e) => e.id === id)?.name ?? id;
	}

	function toggle(ext: ExtensionItem) {
		if (selected.includes(ext.id)) {
			onchange(selected.filter((id) => id !== ext.id));
		} else {
			onchange([...selected, ext.id]);
		}
	}

	function computePosition() {
		if (!inputEl) return;
		const rect = inputEl.getBoundingClientRect();
		dropdownStyle = `position:fixed;left:${rect.left}px;top:${rect.bottom + 2}px;width:${Math.max(rect.width, 320)}px;z-index:9999;`;
	}

	function openDropdown() { open = true; highlightIdx = -1; computePosition(); }
	function closeDropdown() { open = false; highlightIdx = -1; }
	function onInput() {
		query = inputEl?.value ?? "";
		highlightIdx = -1;
		if (!open) openDropdown(); else computePosition();
	}
	function onFocus() { if (!open) openDropdown(); }
	function onBlur() { setTimeout(closeDropdown, 150); }
	function onKeydown(e: KeyboardEvent) {
		const items = filtered();
		if (!open || items.length === 0) return;
		if (e.key === "ArrowDown") { e.preventDefault(); highlightIdx = Math.min(highlightIdx + 1, items.length - 1); }
		else if (e.key === "ArrowUp") { e.preventDefault(); highlightIdx = Math.max(highlightIdx - 1, 0); }
		else if (e.key === "Enter" && highlightIdx >= 0) { e.preventDefault(); toggle(items[highlightIdx]!); }
		else if (e.key === "Escape") { closeDropdown(); }
	}
	function onClickOutside(e: MouseEvent) {
		if (!open) return;
		if (inputEl?.contains(e.target as Node)) return;
		closeDropdown();
	}
</script>

<svelte:document onclick={onClickOutside} />

<!-- Combobox chrome — pills wrap on their own row(s) above the input; the
     input keeps full chrome width on its own row below. -->
<div
	class="{inputClass} flex w-full flex-col gap-1 p-2 text-sm"
	data-testid="extension-picker-combobox"
>
	{#if selected.length > 0}
		<!-- Drag-reorderable chip row (UX-04). svelte-dnd-action stamps
		     aria-roledescription="sortable" + the keyboard handlers
		     (Space-to-grab, arrows-to-move, Enter to drop, Escape to
		     cancel — WCAG 2.1.1 + 2.5.1 satisfied via keyboard mode,
		     NOT separate ↑↓ buttons per RESEARCH Open Question 4).
		     The aria-label below surfaces that hint to screen readers
		     (Pitfall 5). -->
		<div
			data-testid="selected-extension-chips"
			class="flex flex-wrap gap-1"
			use:dndzone={{ items: chipItems(), flipDurationMs: 200, type: "ext-chips" }}
			onconsider={handleConsider}
			onfinalize={handleFinalize}
			role="list"
			aria-roledescription="sortable"
			aria-label="Reorderable extension list — Space to grab, arrows to move, Enter to drop, Escape to cancel"
		>
			{#each chipItems() as item (item.id)}
				<SelectedPill
					chipId={item.id}
					label={nameFor(item.id)}
					onremove={() => onchange(selected.filter((id) => id !== item.id))}
				/>
			{/each}
		</div>
	{/if}
	<div class="relative">
		<svg class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
		</svg>
		<input
			type="text"
			bind:this={inputEl}
			value={query}
			oninput={onInput}
			onfocus={onFocus}
			onblur={onBlur}
			onkeydown={onKeydown}
			{placeholder}
			role="combobox"
			aria-expanded={open}
			aria-controls="extension-picker-listbox"
			aria-haspopup="listbox"
			aria-autocomplete="list"
			autocomplete="off"
			data-testid="open-extension-search-picker"
			class="w-full border-0 bg-transparent pl-6 pr-0 py-0 text-sm outline-none focus:ring-0"
		/>
	</div>
</div>

{#snippet pickerBody()}
	{@const items = filtered()}
	<ul
		id="extension-picker-listbox"
		class="max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-lg"
		role="listbox"
		aria-label="Available extensions"
		aria-multiselectable="true"
	>
		{#if items.length === 0}
			<li role="option" aria-selected="false" class="px-3 py-3 text-center text-xs text-[var(--color-text-muted)]">
				{query ? "No matching extensions" : "No extensions installed"}
			</li>
		{:else}
			{#each items as ext, i (ext.id)}
				{@const checked = selected.includes(ext.id)}
				<li role="option" aria-selected={checked}>
					<button
						type="button"
						tabindex="-1"
						class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors {i === highlightIdx
							? 'bg-[var(--color-surface-tertiary)]'
							: 'bg-[var(--color-surface-secondary)] hover:bg-[var(--color-surface-tertiary)]'}"
						onmousedown={() => toggle(ext)}
						onmouseenter={() => (highlightIdx = i)}
					>
						<span class="flex h-4 w-4 shrink-0 items-center justify-center rounded border {checked
							? 'border-blue-500 bg-blue-600 text-white'
							: 'border-[var(--color-border)] text-transparent'}">
							{#if checked}
								<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
								</svg>
							{/if}
						</span>
						<div class="min-w-0 flex-1">
							<span class="text-sm font-medium text-[var(--color-text-primary)]">{ext.name}</span>
							{#if ext.description}
								<p class="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">{ext.description}</p>
							{/if}
						</div>
					</button>
				</li>
			{/each}
		{/if}
	</ul>
{/snippet}

{#if open && bp.below}
	<BottomSheet open={true} onclose={closeDropdown} ariaLabel="Extension picker">
		{@render pickerBody()}
	</BottomSheet>
{:else if open}
	<div style={dropdownStyle}>
		{@render pickerBody()}
	</div>
{/if}
