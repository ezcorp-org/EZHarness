<script lang="ts">
	import ModalBackdrop from "$lib/components/ui/ModalBackdrop.svelte";
	let {
		open = false,
		extensionName,
		busy = false,
		onconfirm,
		oncancel,
	}: {
		open: boolean;
		/** Manifest name — also names the data directory shown to the user. */
		extensionName: string;
		/** Caller's request is in flight; both buttons lock. */
		busy?: boolean;
		onconfirm: (opts: { purgeData: boolean }) => void;
		oncancel: () => void;
	} = $props();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape" && !busy) oncancel();
	}

	function confirm() {
		if (!busy) onconfirm({ purgeData: false });
	}
</script>

{#if open}
	<ModalBackdrop
		dim={50}
		class="flex items-center justify-center p-4"
		onkeydown={handleKeydown}
		onclose={() => {
			if (!busy) oncancel();
		}}
		role="dialog"
		aria-modal="true"
		aria-labelledby="uninstall-dialog-title"
		data-testid="uninstall-dialog"
		tabindex={-1}
	>
		<div class="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6 shadow-xl">
			<h3 id="uninstall-dialog-title" class="text-base font-semibold text-[var(--color-text-primary)]">
				Uninstall {extensionName}
			</h3>
			<p class="mt-2 text-sm text-[var(--color-text-secondary)]">
				This stops the extension and removes its tools and permissions.
				Its release history, settings, secrets, stored data and files are kept.
			</p>
			<p class="mt-3 text-xs text-[var(--color-text-muted)]">
				Uninstall does not delete data. Data deletion requires a separate review.
			</p>

			<div class="mt-6 flex justify-end gap-2">
				<button
					onclick={oncancel}
					disabled={busy}
					class="rounded-md px-3 py-1.5 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					onclick={confirm}
					disabled={busy}
					class="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
					data-testid="uninstall-confirm"
				>
					{busy ? "Uninstalling…" : "Uninstall"}
				</button>
			</div>
		</div>
	</ModalBackdrop>
{/if}
