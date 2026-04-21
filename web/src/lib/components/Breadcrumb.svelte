<script lang="ts">
	interface BreadcrumbItem {
		label: string;
		href?: string;
	}

	interface Props {
		items: BreadcrumbItem[];
	}

	let { items }: Props = $props();
</script>

<nav aria-label="Breadcrumb" class="md:hidden mb-3">
	<ol class="flex items-center gap-1 text-sm text-[var(--color-text-muted)]">
		{#each items as item, i}
			{#if i > 0}
				<li aria-hidden="true" class="select-none">/</li>
			{/if}
			<li>
				{#if item.href && i < items.length - 1}
					<a href={item.href} class="text-[var(--color-text)] hover:underline">{item.label}</a>
				{:else}
					<span>{item.label}</span>
				{/if}
			</li>
		{/each}
	</ol>
</nav>
