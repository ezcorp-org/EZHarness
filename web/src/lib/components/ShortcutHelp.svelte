<script lang="ts">
	import { loadCustomShortcuts, formatShortcut } from "$lib/shortcuts.js";
	import { createFocusTrap } from "$lib/focus-trap.js";

	let {
		open,
		onclose,
	}: {
		open: boolean;
		onclose: () => void;
	} = $props();

	let shortcuts = $derived(open ? loadCustomShortcuts() : []);
	let dialogEl = $state<HTMLElement | null>(null);
	let cleanupTrap: (() => void) | null = null;

	$effect(() => {
		if (open && dialogEl) {
			cleanupTrap = createFocusTrap(dialogEl);
		}
		if (!open) {
			cleanupTrap?.();
			cleanupTrap = null;
		}
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.stopPropagation();
			onclose();
		}
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onclose();
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
		onclick={handleBackdropClick}
		onkeydown={handleKeydown}
	>
		<div
			bind:this={dialogEl}
			class="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl max-w-md w-full mx-4"
			role="dialog"
			aria-modal="true"
			aria-label="Keyboard shortcuts"
		>
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
				<h2 class="text-base font-semibold text-[var(--color-text-primary)]">Keyboard Shortcuts</h2>
				<button
					onclick={onclose}
					class="rounded-md p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
					aria-label="Close"
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>

			<!-- Shortcut list -->
			<div class="px-5 py-3">
				{#each shortcuts as binding}
					<div class="flex items-center justify-between py-2.5 border-b border-[var(--color-border)]/30 last:border-0">
						<span class="text-sm text-[var(--color-text-secondary)]">{binding.label}</span>
						<kbd class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-xs font-mono text-[var(--color-text-muted)]">
							{formatShortcut(binding)}
						</kbd>
					</div>
				{/each}
			</div>

			<!-- Footer hint -->
			<div class="border-t border-[var(--color-border)] px-5 py-3">
				<p class="text-xs text-[var(--color-text-muted)]">
					Tip: Shift+Click the Copy button on messages to copy rich text
				</p>
			</div>
		</div>
	</div>
{/if}
