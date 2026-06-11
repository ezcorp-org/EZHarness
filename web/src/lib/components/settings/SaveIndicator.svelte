<script lang="ts">
	/**
	 * Inline auto-save confirmation (locked decision 5). Pair with
	 * `createSaveFlash()` — renders nothing when idle.
	 */
	let {
		saving = false,
		saved = false,
		error = false,
	}: { saving?: boolean; saved?: boolean; error?: boolean } = $props();
</script>

{#if saving}
	<span class="text-xs text-[var(--color-text-muted)]" data-testid="save-indicator-saving" role="status">Saving...</span>
{:else if error}
	<span class="text-xs text-red-400" data-testid="save-indicator-error" role="alert">Save failed — try again</span>
{:else if saved}
	<span class="text-xs text-green-400" data-testid="save-indicator-saved" role="status">Saved ✓</span>
{/if}
