<script lang="ts">
	import { inputClass } from "$lib/styles.js";
	import { formatDateForInput, parseDateFromInput } from "./helpers.js";
	import type { ComponentSize } from "./types.js";

	let {
		value = $bindable(""),
		size = "sm" as ComponentSize,
		disabled = false,
		placeholder = "",
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
	const isDatetime = $derived(options?.format === "datetime" || options?.format === "datetime-local");
	const inputType = $derived(isDatetime ? "datetime-local" : "date");

	const displayValue = $derived(formatDateForInput(value, isDatetime));

	function onChange(e: Event) {
		const raw = (e.target as HTMLInputElement).value;
		value = parseDateFromInput(raw, isDatetime);
		onchange?.(value);
	}
</script>

<input
	type={inputType}
	value={displayValue}
	onchange={onChange}
	{disabled}
	class="{inputClass} w-full {sizeClass} color-scheme-dark"
	style="color-scheme: dark;"
/>
