<!--
  DockOpenPill — tiny inline placeholder rendered in a chat message bubble
  in place of a docked tool card. Clicking re-opens the dock for that
  toolCallId. If the dock is showing a different toolCallId, this click
  REPLACES it (auto-replace path, plan §7.4).
-->
<script lang="ts">
	import { openDock } from "$lib/stores.svelte.js";

	let {
		toolCallId,
		conversationId,
		label,
	}: {
		toolCallId: string;
		conversationId: string;
		/** Optional label override; defaults to "Canvas open ↗". */
		label?: string;
	} = $props();

	function handleClick(e: MouseEvent): void {
		e.preventDefault();
		e.stopPropagation();
		if (toolCallId && conversationId) {
			openDock(conversationId, toolCallId);
		}
	}
</script>

<button
	type="button"
	onclick={handleClick}
	class="dock-open-pill"
	data-testid="dock-open-pill"
	data-tool-call-id={toolCallId}
	aria-label={label ?? "Open canvas dock"}
>
	<span class="pill-icon" aria-hidden="true">⧉</span>
	<span class="pill-label">{label ?? "Canvas open"}</span>
	<span class="pill-arrow" aria-hidden="true">↗</span>
</button>

<style>
	.dock-open-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.35rem 0.7rem;
		border-radius: 999px;
		border: 1px solid var(--color-border, #2a2a2a);
		background: var(--color-surface-secondary, #141414);
		color: var(--color-text-secondary, #bcbcbc);
		font-size: 0.8125rem;
		cursor: pointer;
		transition: background-color 0.15s, color 0.15s;
	}
	.dock-open-pill:hover {
		background: var(--color-surface-tertiary, #1c1c1c);
		color: var(--color-text-primary, #f0f0f0);
	}
	.dock-open-pill:focus-visible {
		outline: 2px solid var(--color-accent, #4a72ff);
		outline-offset: 2px;
	}
	.pill-icon {
		font-size: 0.9rem;
	}
	.pill-arrow {
		font-size: 0.85rem;
		opacity: 0.7;
	}
</style>
