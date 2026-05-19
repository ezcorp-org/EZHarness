<script lang="ts">
	/**
	 * Test stub used when a parent component imports a heavy child whose
	 * implementation isn't relevant to the assertion. `vi.mock` replaces
	 * the import target with this no-op renderer.
	 */
	let { children } = $props<{ children?: () => unknown }>();
</script>

{#if typeof children === "function"}
	{@render children()}
{/if}
