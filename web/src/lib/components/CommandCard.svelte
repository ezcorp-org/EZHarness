<script lang="ts">
	import type { UserCommand } from "$lib/api.js";

	let {
		command,
		onedit,
		ondelete,
	}: {
		command: UserCommand;
		onedit?: () => void;
		ondelete?: () => void;
	} = $props();

	// The popover renders the description as the row's secondary line.
	// Empty descriptions get a placeholder dash so the card height
	// stays uniform across the grid.
	let descriptionText = $derived(command.description || "—");

	// "Saved" label matches the source = "user:db" badge surfaced by
	// the registry (src/runtime/commands/registry.ts maps DB rows to
	// `source: "user:db"`). The label is the human-readable form;
	// data-source carries the raw value for tests.
</script>

<div
	class="flex h-full flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-5 transition-colors hover:border-[var(--color-border)]"
	data-testid="command-card"
	data-source="user:db"
>
	<div class="mb-3 min-w-0">
		<div class="flex flex-wrap items-center gap-2">
			<h3 class="truncate text-lg font-semibold text-[var(--color-text-primary)]">/{command.name}</h3>
			<span class="shrink-0 rounded bg-blue-900 px-1.5 py-0.5 text-xs text-blue-300" title="Stored in your account">
				Saved
			</span>
		</div>
	</div>
	<p class="mb-3 line-clamp-2 text-sm text-[var(--color-text-secondary)]" data-testid="command-card-description">
		{descriptionText}
	</p>
	<div class="mt-auto flex flex-wrap gap-2 pt-4">
		{#if onedit}
			<button
				type="button"
				onclick={onedit}
				class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
				data-testid="command-card-edit"
			>
				Edit
			</button>
		{/if}
		{#if ondelete}
			<button
				type="button"
				onclick={ondelete}
				class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-border)]"
				data-testid="command-card-delete"
			>
				Delete
			</button>
		{/if}
	</div>
</div>
