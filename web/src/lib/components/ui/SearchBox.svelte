<script lang="ts">
	import { inputClass } from "$lib/styles.js";
	import { debounce } from "./helpers.js";
	import type { ComponentSize } from "./types.js";

	let {
		value = $bindable(""),
		size = "sm" as ComponentSize,
		disabled = false,
		placeholder = "Search...",
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

	const sizeClass = $derived(size === "sm" ? "py-1 text-xs" : "py-2 text-sm");
	const debounceMs = $derived(
		typeof options?.debounce === "number" ? (options.debounce as number) : 300,
	);

	let internalValue = $state(value);

	const debouncedUpdate = $derived(
		debounce((v: string) => {
			value = v;
			onchange?.(v);
		}, debounceMs),
	);

	function onInput(e: Event) {
		const target = e.target as HTMLInputElement;
		internalValue = target.value;
		debouncedUpdate(internalValue);
	}

	function clear() {
		internalValue = "";
		value = "";
		onchange?.("");
	}

	// Sync external value changes to internal
	$effect(() => {
		internalValue = value;
	});
</script>

<div class="relative">
	<!-- Search icon -->
	<svg
		class="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]"
		fill="none"
		stroke="currentColor"
		viewBox="0 0 24 24"
	>
		<circle cx="11" cy="11" r="8" stroke-width="2" />
		<path d="m21 21-4.35-4.35" stroke-width="2" stroke-linecap="round" />
	</svg>

	<input
		type="text"
		value={internalValue}
		oninput={onInput}
		{placeholder}
		{disabled}
		class="{inputClass} pl-8 pr-8 {sizeClass}"
	/>

	<!-- Clear button -->
	{#if internalValue}
		<button
			type="button"
			onclick={clear}
			{disabled}
			class="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed"
			title="Clear"
		>
			<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path d="M6 18 18 6M6 6l12 12" stroke-width="2" stroke-linecap="round" />
			</svg>
		</button>
	{/if}
</div>
