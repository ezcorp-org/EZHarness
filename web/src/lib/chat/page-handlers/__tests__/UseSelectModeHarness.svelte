<script lang="ts">
	/**
	 * Test harness for `useSelectMode`. Mirrors the reactive bindings used
	 * by the chat page: reads `state.selectedIds.has(id)` per row and
	 * `derived.selectedCount` for the bulk-action label, and wires
	 * `toggleSelectedMessage` to the row click. If the rune-wrapper's
	 * `selectedIds` ever falls back to a non-reactive `Set`, the count and
	 * `aria-checked` here will stop updating — which is exactly the
	 * regression `useSelectMode.reactivity.component.test.ts` watches for.
	 */
	import { untrack } from "svelte";
	import { useSelectMode } from "../useSelectMode.svelte.js";
	import type { Message } from "$lib/api.js";

	interface Props {
		messages: Message[];
	}

	let { messages: initial }: Props = $props();
	// Local copy so bulk handlers that rewrite the list re-render the rows.
	let messages = $state(untrack(() => initial));

	const selectMode = useSelectMode({
		convId: () => "conv-1",
		projectId: () => "proj-1",
		allMessages: { get: () => messages, set: (v) => { messages = v; } },
		visibleMessages: () => messages,
		savedMemories: { get: () => new Map(), set: () => {} },
		isStreaming: () => false,
		getHistoricalToolCalls: () => [],
	});

	// Drop the user into select-mode immediately so the harness mirrors
	// the post-toggle state the chat page enters before clicks land.
	selectMode.toggleSelectMode();
</script>

<div data-testid="selected-count">{selectMode.derived.selectedCount}</div>
{#each messages as msg (msg.id)}
	<!-- Mirrors the chat row: `role="checkbox"` + click toggle. The real
	     row uses a `<div>` for the same reason — the toolbar/links inside
	     don't survive being nested in a real `<button>`. -->
	<div
		role="checkbox"
		tabindex="0"
		data-testid="row-{msg.id}"
		aria-checked={selectMode.state.selectedIds.has(msg.id)}
		onclick={(e) => selectMode.toggleSelectedMessage(msg.id, e)}
		onkeydown={(e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				selectMode.toggleSelectedMessage(msg.id, e);
			}
		}}
	>{msg.id}</div>
{/each}

<button data-testid="bulk-exclude" onclick={() => selectMode.handleBulkExclude()}>Exclude</button>
<div data-testid="bulk-status">{selectMode.state.bulkStatus ?? ""}</div>
<div data-testid="select-error">{selectMode.state.selectError ?? ""}</div>
<div data-testid="excluded-ids">{messages.filter((m) => m.excluded).map((m) => m.id).join(",")}</div>
