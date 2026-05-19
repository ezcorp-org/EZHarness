<script lang="ts">
	let {
		type = 'lines',
		lines = 4,
		count = 6,
		rows = 5,
		statusText,
	}: {
		type?: 'lines' | 'card-grid' | 'list' | 'form';
		lines?: number;
		count?: number;
		rows?: number;
		statusText?: string;
	} = $props();

	const widths = ['100%', '85%', '70%', '50%'];
</script>

<div class="py-1">
	{#if type === 'card-grid'}
		<div class="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
			{#each Array(count) as _, i}
				<div class="rounded-lg border border-[var(--color-border)] p-4 flex flex-col gap-2" style="min-height: 120px; animation-delay: {i * 80}ms">
					<div class="skeleton-line" style="width: 60%; height: 1rem;"></div>
					<div class="skeleton-line" style="width: 90%; animation-delay: 100ms"></div>
					<div class="skeleton-line" style="width: 70%; animation-delay: 200ms"></div>
				</div>
			{/each}
		</div>
	{:else if type === 'list'}
		<div class="flex flex-col gap-2">
			{#each Array(rows) as _, i}
				<div class="flex items-center gap-3 py-1.5" style="animation-delay: {i * 80}ms">
					<div class="skeleton-line shrink-0 !rounded-full" style="width: 2rem; height: 2rem;"></div>
					<div class="flex flex-col gap-1.5 flex-1">
						<div class="skeleton-line" style="width: {65 + (i % 3) * 10}%; height: 0.75rem;"></div>
						<div class="skeleton-line" style="width: {40 + (i % 4) * 8}%; height: 0.5rem; animation-delay: 100ms"></div>
					</div>
				</div>
			{/each}
		</div>
	{:else if type === 'form'}
		<div class="flex flex-col gap-5">
			{#each Array(4) as _, i}
				<div class="flex flex-col gap-1.5" style="animation-delay: {i * 100}ms">
					<div class="skeleton-line" style="width: 30%; height: 0.625rem;"></div>
					<div class="skeleton-line" style="width: 100%; height: 2.5rem; animation-delay: 50ms"></div>
				</div>
			{/each}
		</div>
	{:else}
		<div class="flex flex-col gap-2">
			{#each Array(lines) as _, i}
				<div
					class="skeleton-line"
					style="width: {widths[i % widths.length]}; animation-delay: {i * 100}ms"
				></div>
			{/each}
		</div>
	{/if}
	{#if statusText}
		<p class="mt-2 text-xs text-[var(--color-text-muted)]">{statusText}</p>
	{/if}
</div>
