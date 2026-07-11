<script lang="ts">
	import type { SuggestedTool, Enhancement } from "$lib/composer-suggest-logic";

	let {
		open,
		tools,
		enhancement,
		enhanceLoading,
		applied,
		onselecttool,
		onapply,
		onundo,
		ondismiss,
	}: {
		open: boolean;
		tools: SuggestedTool[];
		enhancement: Enhancement | null;
		/** True while a rewrite is being generated — renders a subtle shimmer
		 *  INSIDE an already-open popover (tool chips), never alone. */
		enhanceLoading: boolean;
		/** True after the rewrite was applied — the Apply button becomes Undo. */
		applied: boolean;
		onselecttool: (tool: SuggestedTool) => void;
		onapply: () => void;
		onundo: () => void;
		ondismiss: () => void;
	} = $props();

	// Short tool names can collide across extensions (live: three weather
	// extensions each expose "weather-now", rendering look-alike triplicate
	// chips) — suffix the extension name only when a collision exists. Compute
	// the collision set and every chip's label in ONE pass keyed to `tools`, so
	// the label always reflects the current tool list; a label derived that read
	// a *separate* collision derived could render before that read was tracked
	// and leave the suffix off on the async-populate path.
	let labeledTools = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
		return tools.map((tool) => ({
			tool,
			label: (counts.get(tool.name) ?? 0) > 1 ? `${tool.name} · ${tool.extension}` : tool.name,
		}));
	});
</script>

{#if open}
	<!-- Sits where MentionPopover does (absolute above the composer) but at
	     z-40: the mention popover (z-50) always wins when both could show,
	     and the parent additionally suppresses suggestions while any mention
	     or inline-tool UI is open. Non-modal, never steals focus. -->
	<div class="absolute bottom-full left-0 right-0 z-40 mb-2" data-testid="suggestion-popover">
		<div
			role="region"
			aria-label="Suggestions"
			aria-live="polite"
			class="flex flex-col gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2.5 py-2 shadow-lg"
		>
			<div class="flex flex-wrap items-center gap-1.5">
				<span class="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
					✦ Suggested
				</span>
				{#each labeledTools as { tool, label } (tool.extension + "__" + tool.name)}
					{#if tool.extensionType === "built-in"}
						<!-- Built-ins are always wired — informational chip, no action. -->
						<span
							data-testid="suggestion-tool-chip"
							data-tool={tool.name}
							title={tool.description}
							class="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]"
						>
							{label}
						</span>
					{:else}
						<button
							type="button"
							data-testid="suggestion-tool-chip"
							data-tool={tool.name}
							title="{tool.description} — click to add {tool.extension} to your message"
							class="rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-xs text-indigo-300 transition-colors hover:bg-indigo-500/25"
							onclick={() => onselecttool(tool)}
						>
							🔧 {label}
						</button>
					{/if}
				{/each}
				<button
					type="button"
					data-testid="suggestion-dismiss"
					aria-label="Dismiss suggestions"
					title="Dismiss (Esc)"
					class="ml-auto rounded px-1.5 text-sm leading-none text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
					onclick={ondismiss}
				>
					×
				</button>
			</div>

			{#if enhanceLoading}
				<div
					data-testid="suggestion-enhance-loading"
					class="animate-pulse text-xs text-[var(--color-text-muted)]"
				>
					✨ Improving prompt…
				</div>
			{:else if enhancement}
				<div class="flex items-start gap-2" data-testid="suggestion-enhance-row">
					<span class="text-xs leading-5">✨</span>
					<p
						class="min-w-0 flex-1 text-xs italic leading-5 text-[var(--color-text-secondary)]"
						title={enhancement.reason}
					>
						{enhancement.enhanced}
					</p>
					{#if applied}
						<button
							type="button"
							data-testid="suggestion-undo"
							class="shrink-0 rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)]"
							onclick={onundo}
						>
							Undo
						</button>
					{:else}
						<button
							type="button"
							data-testid="suggestion-apply"
							title={enhancement.reason}
							class="shrink-0 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300 transition-colors hover:bg-emerald-500/25"
							onclick={onapply}
						>
							Apply
						</button>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}
