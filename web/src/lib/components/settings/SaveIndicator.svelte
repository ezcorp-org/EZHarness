<script lang="ts">
	/**
	 * Inline auto-save confirmation (locked decision 5). Pair with
	 * `createSaveFlash()` — renders nothing when idle.
	 */
	let { saving = false, saved = false }: { saving?: boolean; saved?: boolean } = $props();
</script>

{#if saving}
	<span class="text-xs text-[var(--color-text-muted)]" data-testid="save-indicator-saving" role="status">Saving...</span>
{:else if saved}
	<span class="text-xs text-green-400" data-testid="save-indicator-saved" role="status">Saved ✓</span>
{/if}
