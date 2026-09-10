<script lang="ts">
	import { inputClass } from "$lib/styles.js";

	let {
		value,
		placeholder,
		ariaLabel,
		controls,
		activeDescendant,
		oninput,
		onkeydown,
	}: {
		value: string;
		placeholder: string;
		ariaLabel: string;
		controls: string;
		activeDescendant?: string;
		oninput: (event: Event) => void;
		onkeydown: (event: KeyboardEvent) => void;
	} = $props();
</script>

<div class="relative border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
	<svg class="pointer-events-none absolute left-6 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
		<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
	</svg>
	<input
		type="text"
		value={value}
		{placeholder}
		role="combobox"
		aria-label={ariaLabel}
		aria-expanded={true}
		aria-controls={controls}
		aria-haspopup="listbox"
		aria-autocomplete="list"
		aria-activedescendant={activeDescendant}
		autocomplete="off"
		oninput={oninput}
		onkeydown={onkeydown}
		class="{inputClass} w-full pl-8 text-sm"
	/>
</div>
