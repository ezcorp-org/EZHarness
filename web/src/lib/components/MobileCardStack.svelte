<script lang="ts">
	import type { Snippet } from "svelte";

	interface Column {
		key: string;
		label: string;
		class?: string;
	}

	interface Props {
		columns: Column[];
		rows: Record<string, any>[];
		keyField?: string;
		actions?: Snippet<[{ row: Record<string, any> }]>;
		cell?: Snippet<[{ row: Record<string, any>; column: Column; value: any }]>;
	}

	let { columns, rows, keyField = "id", actions, cell }: Props = $props();
</script>

<!-- Desktop: standard table -->
<div class="hidden md:block">
	<table class="w-full text-sm">
		<thead>
			<tr class="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
				{#each columns as col}
					<th class="px-3 py-2 font-medium {col.class ?? ''}">{col.label}</th>
				{/each}
				{#if actions}
					<th class="px-3 py-2 font-medium">Actions</th>
				{/if}
			</tr>
		</thead>
		<tbody>
			{#each rows as row (row[keyField])}
				<tr class="border-b border-[var(--color-border)] hover:bg-[var(--color-surface-tertiary)] transition-colors">
					{#each columns as col}
						<td class="px-3 py-2 {col.class ?? ''}">
							{#if cell}
								{@render cell({ row, column: col, value: row[col.key] })}
							{:else}
								{row[col.key] ?? ""}
							{/if}
						</td>
					{/each}
					{#if actions}
						<td class="px-3 py-2">
							{@render actions({ row })}
						</td>
					{/if}
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<!-- Mobile: card stack -->
<div class="md:hidden space-y-3">
	{#each rows as row (row[keyField])}
		<div class="rounded-lg border border-[var(--color-border)] p-3">
			{#each columns as col}
				<div class="flex justify-between py-1 text-sm">
					<span class="text-[var(--color-text-muted)]">{col.label}</span>
					<span class="text-right {col.class ?? ''}">
						{#if cell}
							{@render cell({ row, column: col, value: row[col.key] })}
						{:else}
							{row[col.key] ?? ""}
						{/if}
					</span>
				</div>
			{/each}
			{#if actions}
				<div class="mt-2 border-t border-[var(--color-border)] pt-2">
					{@render actions({ row })}
				</div>
			{/if}
		</div>
	{/each}
</div>
