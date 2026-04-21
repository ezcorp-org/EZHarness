<script lang="ts">
	let {
		open = false,
		conversationTitle,
		onconfirm,
		oncancel,
	}: {
		open: boolean;
		conversationTitle: string;
		onconfirm: () => void;
		oncancel: () => void;
	} = $props();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") oncancel();
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) oncancel();
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
		onkeydown={handleKeydown}
		onclick={handleBackdropClick}
	>
		<div class="w-full max-w-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6 shadow-xl">
			<h3 class="text-sm font-semibold text-[var(--color-text-primary)]">Delete conversation</h3>
			<p class="mt-2 text-sm text-[var(--color-text-secondary)]">
				Delete "<span class="text-[var(--color-text-primary)]">{conversationTitle}</span>"? This can't be undone.
			</p>
			<div class="mt-4 flex justify-end gap-2">
				<button
					onclick={oncancel}
					class="rounded-md px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors"
				>
					Cancel
				</button>
				<button
					onclick={onconfirm}
					class="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 transition-colors"
				>
					Delete
				</button>
			</div>
		</div>
	</div>
{/if}
