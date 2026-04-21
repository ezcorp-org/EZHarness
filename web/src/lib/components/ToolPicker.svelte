<script lang="ts">
	import type { ToolDefinition } from '../../../../src/extensions/types';

	let {
		tools,
		extensionName,
		onselect,
		onclose,
	}: {
		tools: ToolDefinition[];
		extensionName: string;
		onselect: (tool: ToolDefinition) => void;
		onclose: () => void;
	} = $props();

	let highlightedIndex = $state(0);
	let listboxEl = $state<HTMLDivElement | null>(null);

	// Auto-select if single tool
	$effect(() => {
		if (tools.length === 1) {
			onselect(tools[0]);
		}
	});

	// Scroll highlighted item into view
	$effect(() => {
		if (!listboxEl) return;
		const el = listboxEl.querySelector(`#tool-item-${highlightedIndex}`);
		el?.scrollIntoView({ block: 'nearest' });
	});

	function handleWrapperClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onclose();
	}

	export function handleKeydown(e: KeyboardEvent) {
		const total = tools.length;
		if (total <= 1) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			e.stopPropagation();
			highlightedIndex = (highlightedIndex + 1) % total;
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			e.stopPropagation();
			highlightedIndex = highlightedIndex <= 0 ? total - 1 : highlightedIndex - 1;
			return;
		}
		if (e.key === 'Enter' || e.key === 'Tab') {
			e.preventDefault();
			e.stopPropagation();
			if (highlightedIndex >= 0 && highlightedIndex < total) {
				onselect(tools[highlightedIndex]);
			}
			return;
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			onclose();
			return;
		}
	}
</script>

{#if tools.length > 1}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="absolute bottom-full left-0 right-0 z-50 mb-2" onclick={handleWrapperClick}>
		<div
			bind:this={listboxEl}
			role="listbox"
			aria-label="Tools for {extensionName}"
			class="max-h-[240px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-lg"
		>
			<div class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
				{extensionName} Tools
			</div>
			{#each tools as tool, i}
				<button
					id="tool-item-{i}"
					role="option"
					aria-selected={i === highlightedIndex}
					class="flex w-full items-baseline gap-2 px-4 py-2 text-left transition-colors {i === highlightedIndex
						? 'bg-[var(--color-surface-tertiary)]'
						: 'hover:bg-[var(--color-surface-tertiary)]/50'}"
					onclick={() => onselect(tool)}
					onmouseenter={() => (highlightedIndex = i)}
				>
					<span class="text-sm font-medium text-[var(--color-text-primary)]">{tool.name}</span>
					<span class="truncate text-xs text-[var(--color-text-muted)]">{tool.description}</span>
				</button>
			{/each}
		</div>
	</div>
{/if}
