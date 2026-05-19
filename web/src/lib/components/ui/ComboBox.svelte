<script lang="ts">
	import { inputClass } from "$lib/styles.js";
	import { debounce, filterOptions } from "./helpers.js";
	import type { ComponentSize } from "./types.js";

	let {
		value = $bindable(""),
		size = "sm" as ComponentSize,
		disabled = false,
		placeholder = "Select or type...",
		options = {} as Record<string, unknown>,
		onchange,
	}: {
		value: string;
		size?: ComponentSize;
		disabled?: boolean;
		placeholder?: string;
		options?: Record<string, unknown>;
		onchange?: (value: string | string[]) => void;
	} = $props();

	let inputEl: HTMLInputElement | undefined = $state();
	let open = $state(false);
	let highlightIdx = $state(-1);
	let inputText = $state(value);
	let asyncItems: string[] = $state([]);
	let loading = $state(false);
	let abortCtrl: AbortController | undefined;
	let dropdownStyle = $state("");

	const sizeClass = $derived(size === "sm" ? "py-1 text-xs" : "py-2 text-sm");
	const dropdownItemSize = $derived(size === "sm" ? "px-3 py-1 text-xs" : "px-3 py-1.5 text-sm");
	const isAsync = $derived(options?.async === true);
	const staticOptions = $derived(
		Array.isArray(options?.options) ? (options.options as string[]) : [],
	);
	const allowCustom = $derived(!!options?.allowCustom);
	const debounceMs = $derived(
		typeof options?.debounce === "number" ? (options.debounce as number) : 300,
	);
	const fetchUrl = $derived(
		typeof options?.fetchUrl === "string" ? (options.fetchUrl as string) : "",
	);

	const filteredStatic = $derived(filterOptions(staticOptions, inputText));

	const items = $derived(isAsync ? asyncItems : filteredStatic);

	// Sync external value changes
	$effect(() => {
		inputText = value;
	});

	const debouncedFetch = $derived(
		debounce(async (q: string) => {
			if (!fetchUrl) return;
			abortCtrl?.abort();
			abortCtrl = new AbortController();
			loading = true;
			try {
				const res = await fetch(
					`${fetchUrl}?q=${encodeURIComponent(q)}`,
					{ signal: abortCtrl.signal },
				);
				const data = await res.json();
				asyncItems = Array.isArray(data) ? data : [];
			} catch (e: any) {
				if (e?.name !== "AbortError") asyncItems = [];
			} finally {
				loading = false;
			}
		}, debounceMs),
	);

	function computeDropdownPosition() {
		if (!inputEl) return;
		const rect = inputEl.getBoundingClientRect();
		dropdownStyle = `position:fixed;left:${rect.left}px;top:${rect.bottom + 2}px;width:${rect.width}px;z-index:9999;`;
	}

	function openDropdown() {
		if (disabled) return;
		open = true;
		highlightIdx = -1;
		computeDropdownPosition();
	}

	function closeDropdown() {
		open = false;
		highlightIdx = -1;
	}

	function selectItem(item: string) {
		value = item;
		inputText = item;
		onchange?.(item);
		closeDropdown();
	}

	function onInput() {
		inputText = inputEl?.value ?? "";
		highlightIdx = -1;
		if (!open) openDropdown();
		else computeDropdownPosition();
		if (isAsync) debouncedFetch(inputText);
	}

	function onFocus() {
		if (!open) openDropdown();
	}

	function onBlur() {
		setTimeout(() => {
			if (!allowCustom && !isAsync) {
				if (!staticOptions.includes(inputText)) {
					inputText = value;
				}
			} else if (allowCustom && inputText !== value) {
				value = inputText;
				onchange?.(inputText);
			}
			closeDropdown();
		}, 150);
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			highlightIdx = Math.min(highlightIdx + 1, items.length - 1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			highlightIdx = Math.max(highlightIdx - 1, 0);
		} else if (e.key === "Enter" && highlightIdx >= 0) {
			e.preventDefault();
			selectItem(items[highlightIdx]!);
		} else if (e.key === "Escape") {
			closeDropdown();
		}
	}

	function onClickOutside(e: MouseEvent) {
		if (!open) return;
		const target = e.target as Node;
		if (inputEl?.contains(target)) return;
		closeDropdown();
	}
</script>

<svelte:document onclick={onClickOutside} />

<div>
	<input
		type="text"
		bind:this={inputEl}
		value={inputText}
		oninput={onInput}
		onfocus={onFocus}
		onblur={onBlur}
		onkeydown={onKeydown}
		{placeholder}
		{disabled}
		class="{inputClass} w-full {sizeClass}"
	/>
</div>

{#if open}
	<div style={dropdownStyle}>
		<ul
			class="max-h-52 overflow-y-auto rounded-md border border-[var(--color-border,#4b5563)] bg-[var(--color-surface-primary,#111827)] shadow-lg"
		>
			{#if loading}
				<li class="px-3 py-2 text-xs text-[var(--color-text-muted,#6b7280)]">Loading...</li>
			{:else if items.length === 0}
				<li class="px-3 py-2 text-xs text-[var(--color-text-muted,#6b7280)]">No results</li>
			{:else}
				{#each items as item, i}
					<li>
						<button
							type="button"
							class="w-full text-left {dropdownItemSize} {i === highlightIdx
								? 'bg-blue-600 text-white'
								: 'text-[var(--color-text-primary,#e5e7eb)] hover:bg-[var(--color-surface-hover,#1f2937)]'}"
							onmousedown={() => selectItem(item)}
							onmouseenter={() => (highlightIdx = i)}
						>
							{item}
						</button>
					</li>
				{/each}
			{/if}
		</ul>
	</div>
{/if}
