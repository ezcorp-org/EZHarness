<script lang="ts">
	const CATEGORIES = [
		{ name: "Productivity", icon: "\u{1F4CB}" },
		{ name: "Development", icon: "\u{1F4BB}" },
		{ name: "Writing", icon: "\u{270F}\u{FE0F}" },
		{ name: "Research", icon: "\u{1F50D}" },
		{ name: "Education", icon: "\u{1F393}" },
		{ name: "Creative", icon: "\u{1F3A8}" },
		{ name: "Data & Analysis", icon: "\u{1F4CA}" },
		{ name: "Communication", icon: "\u{1F4AC}" },
		{ name: "Modes", icon: "\u{1F3AF}" },
		{ name: "Other", icon: "\u{2699}\u{FE0F}" },
	] as const;

	let {
		selected = null,
		onselect,
	}: {
		selected?: string | null;
		onselect: (category: string | null) => void;
	} = $props();

	function toggle(name: string) {
		onselect(selected === name ? null : name);
	}
</script>

<div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
	{#each CATEGORIES as cat}
		<button
			onclick={() => toggle(cat.name)}
			class="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors
				{selected === cat.name
				? 'border-blue-500 bg-blue-900/40 text-blue-300'
				: 'border-[var(--color-border)] bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface-tertiary)]'}"
		>
			<span class="text-base">{cat.icon}</span>
			<span class="truncate">{cat.name}</span>
		</button>
	{/each}
</div>
