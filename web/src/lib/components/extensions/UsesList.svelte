<!--
  UsesList — Phase 4 §5.3.

  Read-only "Uses" chip list on the extension detail page, rendered from
  `manifest.dependencies` (a Record<name, {source, version}>). Surfaces
  the ext-to-ext composition an extension declares. No write affordance
  here — authoring happens in the author draft panel.

  Empty / absent dependencies → renders nothing (no empty section).
-->
<script lang="ts">
	/** `manifest.dependencies`: name → { source, version }. */
	let {
		dependencies = {},
	}: {
		dependencies?: Record<string, { source?: string; version?: string }> | null;
	} = $props();

	// Stable, name-sorted list of {name, version} for display.
	const deps = $derived(
		Object.entries(dependencies ?? {})
			.map(([name, spec]) => ({ name, version: spec?.version ?? "" }))
			.sort((a, b) => a.name.localeCompare(b.name)),
	);
</script>

{#if deps.length > 0}
	<div data-testid="extension-uses-list" class="mt-4">
		<h4 class="mb-2 text-sm font-medium text-[var(--color-text-secondary)]">Uses</h4>
		<p class="mb-2 text-xs text-[var(--color-text-muted)]">
			This extension declares it uses the tools of:
		</p>
		<div class="flex flex-wrap gap-2">
			{#each deps as dep (dep.name)}
				<span
					data-testid="extension-uses-chip"
					data-dep-name={dep.name}
					class="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2.5 py-1 text-xs text-[var(--color-text-primary)]"
				>
					<span class="font-medium">{dep.name}</span>
					{#if dep.version}
						<span class="text-[var(--color-text-muted)]">{dep.version}</span>
					{/if}
				</span>
			{/each}
		</div>
	</div>
{/if}
