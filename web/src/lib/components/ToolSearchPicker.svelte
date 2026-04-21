<script lang="ts">
	import { inputClass } from "$lib/styles.js";
	import { onMount } from "svelte";
	import SelectedPill from "$lib/components/SelectedPill.svelte";

	interface ToolItem {
		name: string;
		description: string;
		extension: string;
		extensionType: string;
	}

	let {
		selected = [],
		placeholder = "Search tools...",
		onchange,
	}: {
		selected?: string[];
		placeholder?: string;
		onchange: (toolNames: string[]) => void;
	} = $props();

	const CATEGORY_COLORS: Record<string, string> = {
		extension: "bg-blue-600",
		mcp: "bg-purple-600",
	};

	let tools = $state<ToolItem[]>([]);
	let inputEl: HTMLInputElement | undefined = $state();
	let query = $state("");
	let open = $state(false);
	let highlightIdx = $state(-1);
	let dropdownStyle = $state("");

	onMount(async () => {
		try {
			const res = await fetch("/api/tools");
			if (res.ok) {
				const data = await res.json();
				tools = Array.isArray(data.tools) ? data.tools : [];
			}
		} catch { /* non-fatal */ }
	});

	let filtered = $derived(() => {
		if (!query.trim()) return tools;
		const lq = query.toLowerCase();
		return tools.filter(
			(t) =>
				t.name.toLowerCase().includes(lq) ||
				t.description.toLowerCase().includes(lq) ||
				t.extension.toLowerCase().includes(lq),
		);
	});

	function isSelected(toolName: string): boolean {
		return selected.includes(toolName);
	}

	function removeSelected(toolName: string) {
		onchange(selected.filter((n) => n !== toolName));
	}

	function toggleTool(tool: ToolItem) {
		const fullName = `${tool.extension}__${tool.name}`;
		if (selected.includes(fullName)) {
			onchange(selected.filter((n) => n !== fullName));
		} else {
			onchange([...selected, fullName]);
		}
	}

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
		if (!open || items.length === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			highlightIdx = Math.min(highlightIdx + 1, items.length - 1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			highlightIdx = Math.max(highlightIdx - 1, 0);
		} else if (e.key === "Enter" && highlightIdx >= 0) {
			e.preventDefault();
			toggleTool(items[highlightIdx]!);
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

<!-- Combobox chrome — input keeps its original full width on its own row;
     selected pills wrap on a row above the input inside the same chrome.
     This prevents the input from shrinking horizontally as more pills are
     added (users reported the cursor getting pushed off to the right). -->
<div
	class="{inputClass} flex w-full flex-col gap-1 p-2 text-sm"
	data-testid="tool-picker-combobox"
>
	{#if selected.length > 0}
		<div class="flex flex-wrap gap-1">
			{#each selected as toolName (toolName)}
				<SelectedPill label={toolName} onremove={() => removeSelected(toolName)} />
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
			aria-controls="tool-picker-listbox"
			aria-haspopup="listbox"
			aria-autocomplete="list"
			aria-activedescendant={highlightIdx >= 0 ? `tool-picker-item-${highlightIdx}` : undefined}
			autocomplete="off"
			class="w-full border-0 bg-transparent pl-6 pr-0 py-0 text-sm outline-none focus:ring-0"
		/>
	</div>
</div>

{#if open}
	{@const items = filtered()}
	<div style={dropdownStyle}>
		<ul
			id="tool-picker-listbox"
			class="max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-lg"
			role="listbox"
			aria-label="Available tools"
			aria-multiselectable="true"
		>
			{#if items.length === 0}
				<li role="option" aria-selected="false" class="px-3 py-3 text-center text-xs text-[var(--color-text-muted)]">
					{query ? "No matching tools" : "No tools available"}
				</li>
			{:else}
				{#each items as tool, i (tool.extension + tool.name)}
					{@const fullName = `${tool.extension}__${tool.name}`}
					{@const checked = selected.includes(fullName)}
					<li
						id="tool-picker-item-{i}"
						role="option"
						aria-selected={checked}
					>
						<button
							type="button"
							tabindex="-1"
							class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors {i === highlightIdx
								? 'bg-[var(--color-surface-tertiary)]'
								: 'bg-[var(--color-surface-secondary)] hover:bg-[var(--color-surface-tertiary)]'}"
							onmousedown={() => toggleTool(tool)}
							onmouseenter={() => (highlightIdx = i)}
						>
							<!-- Checkbox indicator -->
							<span class="flex h-4 w-4 shrink-0 items-center justify-center rounded border {checked
								? 'border-blue-500 bg-blue-600 text-white'
								: 'border-[var(--color-border)] text-transparent'}">
								{#if checked}
									<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
									</svg>
								{/if}
							</span>
							<span class="flex h-5 shrink-0 items-center rounded px-1 text-[10px] font-medium text-white {CATEGORY_COLORS[tool.extensionType] ?? 'bg-gray-600'}">
								{tool.extensionType === "mcp" ? "MCP" : tool.extension}
							</span>
							<div class="min-w-0 flex-1">
								<span class="text-sm font-medium text-[var(--color-text-primary)]">{tool.name}</span>
								{#if i === highlightIdx && tool.description}
									<p class="mt-0.5 text-xs text-[var(--color-text-muted)]">{tool.description}</p>
								{/if}
							</div>
						</button>
					</li>
				{/each}
			{/if}
		</ul>
	</div>
{/if}
