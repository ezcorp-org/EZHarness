<script lang="ts">
	/**
	 * Chat DAG panel — the drawer shell around `<GraphCanvas>`.
	 *
	 * Surface: `SwipeDrawer side="right"`, exactly like `ObservabilityPanel`
	 * (same trigger location in the header cluster, same `open` + `onclose`
	 * lifecycle owned by the chat page). The drawer supplies focus trap,
	 * topmost-only Esc, swipe-to-dismiss, backdrop and z-index layering —
	 * none of that is re-implemented here, and `DockHost` is not involved.
	 *
	 * The panel owns navigation: a stack of `GraphFrame`s (level 1 → a turn's
	 * level 2 → a sub-agent's own level 1), rendered as a breadcrumb. All of
	 * that logic is pure and lives in `$lib/graph/panel-logic`.
	 */
	import { untrack } from "svelte";
	import SwipeDrawer from "$lib/components/SwipeDrawer.svelte";
	import GraphCanvas from "./GraphCanvas.svelte";
	import { layoutGraph } from "$lib/graph/layout";
	import {
		drillFrame,
		frameTitle,
		graphNotices,
		graphUrl,
		isEmptyGraph,
		popTo,
		rootFrame,
		type GraphFrame,
	} from "$lib/graph/panel-logic";
	import { formatNodeDuration, KIND_LABEL, nodeTitle, STATUS_LABEL } from "$lib/graph/canvas-view";
	import type { ChatGraph, GraphNode } from "$server/runtime/chat-graph/types";

	let {
		conversationId,
		open = false,
		onclose,
	}: {
		conversationId: string;
		open: boolean;
		onclose: () => void;
	} = $props();

	const LOAD_ERROR = "Could not load the graph.";
	const NOT_FOUND_ERROR = "This graph is no longer available.";

	let stack = $state<GraphFrame[]>([]);
	let graph = $state<ChatGraph | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let selected = $state<GraphNode | null>(null);

	/**
	 * Current frame. The stack starts empty and is seeded by the re-root
	 * effect below, so the fallback covers exactly the first flush — after
	 * which `stack` always holds at least the root frame.
	 */
	let frame = $derived(stack[stack.length - 1] ?? rootFrame(conversationId));
	let laid = $derived(graph === null ? null : layoutGraph(graph));
	let notices = $derived(graphNotices(graph, laid?.hasCycle === true));

	/** Discards a stale response when the user drills again mid-flight. */
	let requestSeq = 0;

	function resetTo(id: string) {
		stack = [rootFrame(id)];
		graph = null;
		error = null;
		selected = null;
	}

	// Switching conversations re-roots the whole stack: a frame from the
	// previous conversation would fetch a graph that isn't this chat's.
	$effect(() => {
		const id = conversationId;
		untrack(() => resetTo(id));
	});

	// Fetch on open and on every navigation. Closed drawers don't poll.
	$effect(() => {
		if (!open) return;
		void load(frame);
	});

	async function load(f: GraphFrame) {
		const seq = ++requestSeq;
		loading = true;
		error = null;
		try {
			const res = await fetch(graphUrl(f));
			if (seq !== requestSeq) return;
			if (!res.ok) {
				error = res.status === 404 ? NOT_FOUND_ERROR : LOAD_ERROR;
				graph = null;
				return;
			}
			graph = (await res.json()) as ChatGraph;
		} catch {
			if (seq !== requestSeq) return;
			error = LOAD_ERROR;
			graph = null;
		} finally {
			if (seq === requestSeq) loading = false;
		}
	}

	/**
	 * Every node selects (details show in the footer); a drillable one also
	 * pushes the frame it points at. Nothing here writes — the graph is
	 * strictly read-only, so the session-tree invariant is untouched.
	 */
	function onNodeActivate(node: GraphNode) {
		selected = node;
		const next = drillFrame(node, frame);
		if (next === null) return;
		stack = [...stack, next];
	}

	function goTo(index: number) {
		stack = popTo(stack, index);
		selected = null;
	}
</script>

<SwipeDrawer {open} side="right" width="w-full md:w-[26rem]" {onclose} ariaLabel="Conversation graph panel">
	<div
		data-testid="chat-graph-panel"
		class="flex h-full flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
	>
		<div class="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
			<h2 class="text-sm font-semibold text-[var(--color-text-primary)]">{frameTitle(frame)}</h2>
			<button
				type="button"
				data-testid="chat-graph-close"
				onclick={onclose}
				aria-label="Close"
				class="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
			>
				<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>

		{#if stack.length > 1}
			<nav
				data-testid="chat-graph-breadcrumb"
				aria-label="Graph navigation"
				class="flex items-center gap-1 overflow-x-auto border-b border-[var(--color-border)] px-3 py-2 text-xs"
			>
				<button
					type="button"
					data-testid="chat-graph-back"
					onclick={() => goTo(stack.length - 2)}
					aria-label="Back"
					class="shrink-0 rounded px-1.5 py-0.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
				>←</button>
				{#each stack as crumb, i (i)}
					{#if i > 0}
						<span class="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true">/</span>
					{/if}
					<button
						type="button"
						data-testid="chat-graph-crumb"
						onclick={() => goTo(i)}
						disabled={i === stack.length - 1}
						aria-current={i === stack.length - 1 ? "page" : undefined}
						class="max-w-40 shrink-0 truncate rounded px-1.5 py-0.5 text-[var(--color-text-secondary)] enabled:hover:bg-[var(--color-surface-tertiary)] enabled:hover:text-[var(--color-text-primary)] disabled:cursor-default disabled:font-medium disabled:text-[var(--color-text-primary)] transition-colors"
					>{crumb.label}</button>
				{/each}
			</nav>
		{/if}

		{#each notices as notice (notice)}
			<p
				data-testid="chat-graph-notice"
				class="border-b border-[var(--color-border)] border-l-2 border-l-[var(--color-amber-500)] bg-[var(--color-surface-secondary)] px-4 py-2 text-[11px] text-[var(--color-text-secondary)]"
			>{notice}</p>
		{/each}

		<div class="relative flex-1 overflow-hidden">
			{#if loading}
				<p data-testid="chat-graph-loading" class="p-4 text-xs text-[var(--color-text-muted)]">Loading graph…</p>
			{:else if error !== null}
				<div data-testid="chat-graph-error" class="space-y-2 p-4">
					<p class="text-xs text-[var(--color-text-secondary)]">{error}</p>
					<button
						type="button"
						data-testid="chat-graph-retry"
						onclick={() => void load(frame)}
						class="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
					>Try again</button>
				</div>
			{:else if isEmptyGraph(graph)}
				<p data-testid="chat-graph-empty" class="p-4 text-xs text-[var(--color-text-muted)]">
					Nothing to map yet — this conversation has no messages.
				</p>
			{:else if laid !== null}
				<GraphCanvas layout={laid} selectedId={selected?.id ?? null} onactivate={onNodeActivate} />
			{/if}
		</div>

		{#if selected !== null}
			<div
				data-testid="chat-graph-detail"
				class="space-y-1 border-t border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-4 py-3"
			>
				<p class="break-words text-xs font-semibold text-[var(--color-text-primary)]">{nodeTitle(selected)}</p>
				<p class="text-[11px] text-[var(--color-text-muted)]">
					{KIND_LABEL[selected.kind]} · {STATUS_LABEL[selected.status]} · {formatNodeDuration(selected.durationMs)}
				</p>
			</div>
		{/if}
	</div>
</SwipeDrawer>
