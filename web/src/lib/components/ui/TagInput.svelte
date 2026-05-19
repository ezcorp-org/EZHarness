<script lang="ts">
	import { inputClass } from "$lib/styles.js";
	import { filterSuggestions } from "./helpers.js";
	import type { ComponentSize } from "./types.js";

	let {
		value = $bindable([] as string[]),
		size = "sm" as ComponentSize,
		disabled = false,
		placeholder = "Add tag...",
		options = {} as Record<string, unknown>,
		onchange,
	}: {
		value: string[];
		size?: ComponentSize;
		disabled?: boolean;
		placeholder?: string;
		options?: Record<string, unknown>;
		onchange?: (value: string | string[]) => void;
	} = $props();

	let inputText = $state("");
	let inputEl: HTMLInputElement | undefined = $state();
	let showSuggestions = $state(false);
	let highlightIdx = $state(-1);
	let dropdownStyle = $state("");

	const sizeClass = $derived(size === "sm" ? "py-1 text-xs" : "py-2 text-sm");
	const tagTextSize = $derived(size === "sm" ? "text-xs" : "text-sm");
	const suggestions = $derived(
		Array.isArray(options?.suggestions) ? (options.suggestions as string[]) : [],
	);
	const freeform = $derived(options?.freeform !== false);

	const filteredSuggestions = $derived(filterSuggestions(suggestions, value, inputText));

	function addTag(tag: string) {
		const trimmed = tag.trim();
		if (!trimmed) return;
		if (value.includes(trimmed)) return;
		if (!freeform && suggestions.length > 0 && !suggestions.includes(trimmed)) return;
		value = [...value, trimmed];
		inputText = "";
		showSuggestions = false;
		onchange?.(value);
	}

	function removeTag(idx: number) {
		if (disabled) return;
		value = value.filter((_, i) => i !== idx);
		onchange?.(value);
	}

	function onKeydown(e: KeyboardEvent) {
		if (showSuggestions && filteredSuggestions.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				highlightIdx = Math.min(highlightIdx + 1, filteredSuggestions.length - 1);
				return;
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				highlightIdx = Math.max(highlightIdx - 1, 0);
				return;
			} else if (e.key === "Enter" && highlightIdx >= 0) {
				e.preventDefault();
				addTag(filteredSuggestions[highlightIdx]!);
				highlightIdx = -1;
				return;
			}
		}

		if (e.key === "Enter" || e.key === ",") {
			e.preventDefault();
			addTag(inputText);
		} else if (e.key === "Backspace" && inputText === "" && value.length > 0) {
			removeTag(value.length - 1);
		} else if (e.key === "Escape") {
			showSuggestions = false;
		}
	}

	function computeDropdownPosition() {
		if (!inputEl) return;
		const rect = inputEl.getBoundingClientRect();
		dropdownStyle = `position:fixed;left:${rect.left}px;top:${rect.bottom + 4}px;width:${rect.width}px;z-index:9999;`;
	}

	function onInput() {
		inputText = inputEl?.value ?? "";
		showSuggestions = suggestions.length > 0;
		highlightIdx = -1;
		computeDropdownPosition();
	}

	function onFocus() {
		if (suggestions.length > 0) {
			showSuggestions = true;
			computeDropdownPosition();
		}
	}

	function onBlur() {
		setTimeout(() => {
			showSuggestions = false;
		}, 150);
	}

	function onContainerClick() {
		inputEl?.focus();
	}
</script>

<div>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="flex flex-wrap items-center gap-1 rounded-md border border-[var(--color-border,#4b5563)] bg-[var(--color-surface-primary,#1f2937)] px-2 {sizeClass} focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500 {disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-text'}"
		onclick={onContainerClick}
	>
		{#each value as tag, i}
			<span
				class="inline-flex items-center gap-1 rounded-full bg-blue-600/20 text-blue-400 border border-blue-600/30 px-2 py-0.5 {tagTextSize}"
			>
				{tag}
				{#if !disabled}
					<button
						type="button"
						class="ml-0.5 hover:text-white cursor-pointer"
						onclick={(e) => { e.stopPropagation(); removeTag(i); }}
					>
						&times;
					</button>
				{/if}
			</span>
		{/each}
		<input
			type="text"
			bind:this={inputEl}
			value={inputText}
			oninput={onInput}
			onkeydown={onKeydown}
			onfocus={onFocus}
			onblur={onBlur}
			{placeholder}
			{disabled}
			class="min-w-[60px] flex-1 border-none bg-transparent text-[var(--color-text-primary,#e5e7eb)] outline-none {tagTextSize} placeholder:text-[var(--color-text-muted,#6b7280)]"
		/>
	</div>
</div>

{#if showSuggestions && filteredSuggestions.length > 0}
	<div style={dropdownStyle}>
		<ul
			class="max-h-40 overflow-y-auto rounded-md border border-[var(--color-border,#4b5563)] bg-[var(--color-surface-primary,#111827)] shadow-lg"
		>
			{#each filteredSuggestions as suggestion, i}
				<li>
					<button
						type="button"
						class="w-full text-left px-3 py-1.5 {tagTextSize} {i === highlightIdx
							? 'bg-blue-600 text-white'
							: 'text-[var(--color-text-primary,#e5e7eb)] hover:bg-[var(--color-surface-hover,#1f2937)]'}"
						onmousedown={() => addTag(suggestion)}
						onmouseenter={() => (highlightIdx = i)}
					>
						{suggestion}
					</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}
