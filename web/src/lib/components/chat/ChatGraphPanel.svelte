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
	import { nodeDetailCard } from "$lib/graph/canvas-view";
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
	import type { ActivationSource } from "$lib/graph/canvas-view";
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
	 * Node under the pointer/focus, reported by the canvas. The footer shows
	 * this in preference to the click-selected node, so hovering previews
	 * without disturbing a selection.
	 *
	 * A grace period covers the pointer's trip from the graph down to the
	 * footer: the card is mouse-overable (you can select text out of it), so
	 * closing the instant the node is left would snatch it away mid-crossing.
	 */
	let hovered = $state<GraphNode | null>(null);
	const HOVER_HIDE_MS = 160;
	let hoverTimer: ReturnType<typeof setTimeout> | null = null;

	function cancelHoverHide() {
		if (hoverTimer !== null) {
			clearTimeout(hoverTimer);
			hoverTimer = null;
		}
	}

	function onNodeHover(node: GraphNode | null) {
		cancelHoverHide();
		if (node !== null) {
			hovered = node;
			return;
		}
		hoverTimer = setTimeout(() => {
			hoverTimer = null;
			hovered = null;
		}, HOVER_HIDE_MS);
	}

	$effect(() => () => cancelHoverHide());

	/** What the footer describes: the hovered node wins over the selected one. */
	let detailNode = $derived(hovered ?? selected);
	let detailCard = $derived(detailNode === null ? null : nodeDetailCard(detailNode));

	/** Local clock for the Time row. Locale-dependent, so not in the pure module. */
	function formatClock(iso: string): string {
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
	}
	/**
	 * Whether the NEXT canvas should take focus as it mounts.
	 *
	 * Navigating swaps this panel to its loading state, which unmounts
	 * `<GraphCanvas>` — so a keyboard user's focused node is destroyed and the
	 * browser drops focus to `<body>`, stranding them outside the graph. Set
	 * only for keyboard-initiated drill-ins; a mouse user has lost nothing and
	 * must not be yanked.
	 */
	let focusGraphOnMount = $state(false);

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
		focusGraphOnMount = false;
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
	function onNodeActivate(node: GraphNode, source: ActivationSource) {
		selected = node;
		const next = drillFrame(node, frame);
		// A leaf only selects: the canvas stays mounted and keeps its focus.
		if (next === null) return;
		focusGraphOnMount = source === "keyboard";
		stack = [...stack, next];
	}

	function goTo(index: number) {
		stack = popTo(stack, index);
		selected = null;
		// Going back is driven from the breadcrumb, so focus is on a button
		// outside the canvas either way — nothing was lost, so nothing moves.
		focusGraphOnMount = false;
	}
</script>

<!-- 75vw from `md` up: a two-level DAG is wide before it is tall, and at the
     old 26rem the layout engine's ranks wrapped almost immediately. Stays
     `w-full` below `md` — 75% of a phone viewport is narrower than the panel's
     own minimum useful width, so full-bleed is the better small-screen answer
     (same breakpoint the drawer already used). -->
<SwipeDrawer {open} side="right" width="w-full md:w-[75vw]" {onclose} ariaLabel="Conversation graph panel">
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
				<GraphCanvas
					layout={laid}
					selectedId={selected?.id ?? null}
					focusOnMount={focusGraphOnMount}
					onactivate={onNodeActivate}
					onnodehover={onNodeHover}
				/>
			{/if}
		</div>

		<!-- Detail card. Lives BELOW the canvas, never over it: it is
		     mouse-overable (so text can be selected out of it), and an
		     interactive overlay inside the graph covers the neighbouring nodes
		     and swallows their hover. Its own hover cancels the pending close
		     so the pointer can travel here from a node. -->
		{#if detailNode !== null && detailCard !== null}
			<div
				data-testid="chat-graph-detail"
				data-detail-for={detailNode.id}
				class="detail-card border-t border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-4 py-3"
				onmouseenter={cancelHoverHide}
				onmouseleave={() => onNodeHover(null)}
				role="status"
				aria-live="polite"
			>
				<p class="detail-glance" data-testid="chat-graph-detail-glance">
					<span class="detail-kind" data-kind={detailCard.kind}>{detailCard.kindLabel}</span>
					<span class="detail-meta">· {detailCard.meta}</span>
				</p>
				<p class="detail-title">{detailCard.title}</p>
				{#if detailCard.body}
					<p class="detail-body">{detailCard.body}</p>
				{/if}
				<dl class="detail-rows">
					{#each detailCard.rows as row (row.term)}
						<div class="detail-row">
							<dt>{row.term}</dt>
							<dd>{row.term === "Time" ? formatClock(row.value) : row.value}</dd>
						</div>
					{/each}
				</dl>
				{#if detailCard.hint}
					<p class="detail-hint">{detailCard.hint}</p>
				{/if}
			</div>
		{/if}
	</div>
</SwipeDrawer>

<style>
	/* Kind hues, mirrored from GraphCanvas: the heading is drawn in the same
	   colour as that kind's node accent and legend swatch, so all three move
	   together. Declared here too because Svelte styles are scoped per
	   component and this card lives in the panel, outside the canvas. */
	.detail-card {
		--ez-kind-prompt: var(--color-blue-600);
		--ez-kind-assistant: var(--color-emerald-600);
		--ez-kind-thinking: var(--color-purple-500);
		--ez-kind-tool: var(--color-amber-600);
		--ez-kind-subagent: var(--color-pink-600);
		--ez-kind-error: var(--color-red-600);
		max-height: 40%;
		overflow-y: auto;
		font-size: 11px;
		line-height: 1.45;
	}
	:global(.dark) .detail-card {
		--ez-kind-prompt: var(--color-blue-400);
		--ez-kind-assistant: var(--color-emerald-400);
		--ez-kind-thinking: var(--color-purple-400);
		--ez-kind-tool: var(--color-amber-400);
		--ez-kind-subagent: var(--color-pink-400);
		--ez-kind-error: var(--color-red-400);
	}
	.detail-glance {
		margin: 0;
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.detail-kind {
		color: var(--ez-kind-prompt);
	}
	.detail-kind[data-kind="assistant"] { color: var(--ez-kind-assistant); }
	.detail-kind[data-kind="thinking"] { color: var(--ez-kind-thinking); }
	.detail-kind[data-kind="tool"] { color: var(--ez-kind-tool); }
	.detail-kind[data-kind="subagent"] { color: var(--ez-kind-subagent); }
	.detail-kind[data-kind="error"] { color: var(--ez-kind-error); }
	.detail-meta {
		color: var(--color-text-muted);
	}
	.detail-title {
		margin: 0.125rem 0 0;
		font-weight: 600;
		color: var(--color-text-primary);
		overflow-wrap: anywhere;
	}
	/* Clamp long prose so a whole prompt can't push the graph off-screen. */
	.detail-body {
		margin: 0.25rem 0 0;
		color: var(--color-text-secondary);
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-line-clamp: 4;
		line-clamp: 4;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.detail-rows {
		margin: 0.375rem 0 0;
		display: grid;
		gap: 0.125rem;
	}
	.detail-row {
		display: grid;
		grid-template-columns: 6rem 1fr;
		gap: 0.5rem;
	}
	.detail-row dt {
		color: var(--color-text-muted);
	}
	.detail-row dd {
		margin: 0;
		color: var(--color-text-secondary);
		overflow-wrap: anywhere;
	}
	.detail-hint {
		margin: 0.375rem 0 0;
		color: var(--color-accent);
	}
</style>
