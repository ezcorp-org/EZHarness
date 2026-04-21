<script lang="ts">
	/**
	 * SelectedPill — a compact chip showing a selected value, with an × button
	 * on the right to remove it. Shared across every combo box picker
	 * (ToolSearchPicker, ExtensionSearchPicker, ModelSearchPicker,
	 * ModeSearchPicker) so the look, keyboard handling, and remove-semantics
	 * stay identical across the app.
	 */
	let {
		label,
		title,
		onremove,
	}: {
		label: string;
		title?: string;
		/** Called when the user clicks × or presses Enter/Space on it. */
		onremove: () => void;
	} = $props();

	function handleKey(e: KeyboardEvent) {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onremove();
		}
	}

	// Stop mousedown from propagating so focusing/clicking the × doesn't also
	// close the containing picker's dropdown (which reacts to input blur).
	function handleMouseDown(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		onremove();
	}
</script>

<span
	data-testid="selected-pill"
	class="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]"
	{title}
>
	<span class="truncate">{label}</span>
	<button
		type="button"
		aria-label="Remove {label}"
		class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[var(--color-text-muted)] transition-colors hover:bg-red-900/30 hover:text-red-300"
		onmousedown={handleMouseDown}
		onkeydown={handleKey}
	>
		<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12" />
		</svg>
	</button>
</span>
