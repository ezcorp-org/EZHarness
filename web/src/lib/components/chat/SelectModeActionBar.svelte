<script lang="ts">
	import MessageToolbar from "$lib/components/MessageToolbar.svelte";
	import type { ExtensionAction } from "$lib/chat/extension-toolbar-action.js";

	interface Props {
		selectedCount: number;
		isStreaming: boolean;
		selectCloning: boolean;
		bulkBusy: boolean;
		allSelectedExcluded: boolean;
		bulkCopyContent: string;
		selectError: string | null;
		bulkStatus: string | null;
		oncancel: () => void;
		onfork: () => void | Promise<void>;
		oncopy: () => void;
		onexclude: () => void | Promise<void>;
		onsavememory: () => void | Promise<void>;
		/** Re-run the LAST selected user message as a sibling branch
		 *  (mirrors the per-message Re-run). Other rows in the selection
		 *  are ignored — fan-out would create N invisible parallel
		 *  branches. */
		onrerun?: () => void | Promise<void>;
		/**
		 * Extension `messageToolbar[]` contributions whose
		 * `appliesToSelection` is `"bulk"` or `"both"`. The chat page
		 * builds these from `extensionToolbarStore` filtered by
		 * `selectBulkApplicableContributions`, with onclicks bound to
		 * POST a bulk-shaped event (messageIds[] + concatenated content)
		 * to the standard extension events route. Empty array (default)
		 * keeps the bar identical to its pre-bulk-SDK shape.
		 */
		extensionActions?: ExtensionAction[];
	}

	let {
		selectedCount,
		isStreaming,
		selectCloning,
		bulkBusy,
		allSelectedExcluded,
		bulkCopyContent,
		selectError,
		bulkStatus,
		oncancel,
		onfork,
		oncopy,
		onexclude,
		onsavememory,
		onrerun,
		extensionActions = [],
	}: Props = $props();
</script>

<!-- Select-mode action bar replaces the composer so bulk actions stay
     visible and un-confused with a normal send. Shift+click a row to
     extend the selection to the previously-clicked turn. -->
<div class="border-t border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-4 py-3" data-testid="select-action-bar">
	<div class="mx-auto flex max-w-3xl flex-col gap-2">
		<div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-3">
			<div class="text-sm text-[var(--color-text-primary)]">
				<span data-testid="selected-count" class="font-medium">{selectedCount}</span>
				{selectedCount === 1 ? 'turn' : 'turns'} selected
				<span class="ml-2 hidden text-xs text-[var(--color-text-muted)] md:inline">— shift+click or long-press to select a range</span>
			</div>
			<div class="flex flex-wrap items-center justify-end gap-2">
				<button
					onclick={() => oncancel()}
					disabled={selectCloning || bulkBusy}
					class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-primary)] px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
				>
					Cancel
				</button>
				<!-- Reuses the per-message MessageToolbar in `inline` variant so
				     the bulk actions share the exact icons/tooltips users see on
				     hover. The toolbar's internal copy uses our concatenated
				     `bulkCopyContent`; exclude / include flow through our bulk
				     handler which fans out one PATCH per selected row. -->
				{#if selectedCount > 0}
					<MessageToolbar
						variant="inline"
						role="user"
						content={bulkCopyContent}
						oncopy={oncopy}
						onexclude={isStreaming || bulkBusy ? undefined : onexclude}
						excluded={allSelectedExcluded}
						onsavememory={bulkBusy ? undefined : onsavememory}
						onrerun={onrerun && !isStreaming && !bulkBusy ? onrerun : undefined}
						{extensionActions}
						testid="bulk-toolbar"
					/>
				{/if}
				<button
					onclick={() => onfork()}
					disabled={selectedCount === 0 || selectCloning || bulkBusy}
					class="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
					data-testid="new-chat-from-selection"
					aria-label="Fork chat from selection"
				>
					<!-- Same branch glyph used by MessageToolbar's "Branch from here"
					     button — signals this fork action ties back to the selected
					     turns instead of just creating an empty chat. -->
					<svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<line x1="6" y1="3" x2="6" y2="15" />
						<circle cx="18" cy="6" r="3" />
						<circle cx="6" cy="18" r="3" />
						<path d="M18 9a9 9 0 0 1-9 9" />
					</svg>
					{selectCloning ? "Creating…" : "Fork Chat"}
				</button>
			</div>
		</div>
		{#if selectError}
			<div class="text-xs text-red-400" role="alert">{selectError}</div>
		{/if}
		{#if bulkStatus && !selectError}
			<div class="text-xs text-[var(--color-text-muted)]" role="status" aria-live="polite" data-testid="bulk-status">{bulkStatus}</div>
		{/if}
	</div>
</div>
