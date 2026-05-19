<script lang="ts">
	import { exportConversation } from "$lib/api.js";

	let {
		conversationId,
		leafMessageId,
	}: {
		conversationId: string;
		leafMessageId?: string;
	} = $props();

	let open = $state(false);
	let exporting = $state(false);

	async function handleExport(format: "markdown" | "json") {
		exporting = true;
		open = false;
		try {
			await exportConversation(conversationId, format, leafMessageId);
		} catch (err) {
			console.error("Export failed:", err);
		}
		exporting = false;
	}

	function handleClickOutside(e: MouseEvent) {
		if (!(e.target as HTMLElement).closest(".export-menu")) {
			open = false;
		}
	}
</script>

<svelte:window onclick={handleClickOutside} />

<div class="export-menu relative">
	<button
		onclick={() => (open = !open)}
		disabled={exporting}
		class="rounded p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-50"
		aria-label="Export conversation"
	>
		<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
				d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
		</svg>
	</button>

	{#if open}
		<div class="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] py-1 shadow-lg">
			<button
				onclick={() => handleExport("markdown")}
				class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
			>
				<svg class="h-4 w-4 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
				</svg>
				Export as Markdown
			</button>
			<button
				onclick={() => handleExport("json")}
				class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
			>
				<svg class="h-4 w-4 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
				</svg>
				Export as JSON
			</button>
		</div>
	{/if}
</div>
