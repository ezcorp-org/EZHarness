<script lang="ts">
	/**
	 * SVG renderer for a laid-out chat DAG.
	 *
	 * Takes a `LayoutResult` (never a raw `ChatGraph`) so the panel owns the
	 * one `layoutGraph()` call and can read `hasCycle` from it without laying
	 * the same graph out twice. Every string this template prints and every
	 * focus move it makes comes from `$lib/graph/canvas-view` — this file is
	 * markup, state wiring, and pointer plumbing only.
	 *
	 * Interaction:
	 *   - click / Enter / Space activates a node (`onactivate`); the panel
	 *     decides whether that drills in or just shows details.
	 *   - arrows / Home / End move focus between nodes (roving tabindex, so
	 *     one Tab reaches the graph and arrows walk it).
	 *   - drag the background to pan, wheel or the corner buttons to zoom.
	 *
	 * Sizing: the `viewBox` is pinned to the layout's own content box and the
	 * SVG's width/height are that box times `zoom`, so at 100% a node is
	 * exactly the 168×44 CSS px the layout intends and its label is legible.
	 * A "fit the whole graph into the panel" `preserveAspectRatio` was
	 * rejected — a long conversation is a tall narrow drawing, and fitting it
	 * to a phone-width drawer shrinks the labels to nothing. The SVG overflows
	 * into a scroll container instead, and drag-to-pan scrolls THAT container.
	 *
	 * Pan deliberately does NOT translate a `<g>` inside the SVG: the viewBox
	 * is pinned to the content box, so a transform pushes content past it and
	 * SVG's default `overflow: hidden` clips it — dragging would hide the graph
	 * rather than reveal more of it. Scrolling the container also keeps drag and
	 * the scrollbars in agreement instead of maintaining two rival offsets.
	 */
	import { DEFAULT_LAYOUT_OPTIONS, type LayoutResult } from "$lib/graph/layout";
	import {
		edgeDashArray,
		formatNodeDuration,
		type ActivationSource,
		isActivationKey,
		KIND_LABEL,
		LABEL_GUTTER,
		labelFadeStart,
		legendSections,
		moveFocus,
		nodeAriaLabel,
		nodeTitle,
		wheelZoomFactor,
		ZOOM_STEP,
		zoomBy,
	} from "$lib/graph/canvas-view";
	import type { GraphNode } from "$server/runtime/chat-graph/types";

	let {
		layout,
		selectedId = null,
		focusOnMount = false,
		onactivate,
		onnodehover,
	}: {
		layout: LayoutResult;
		/** Node the panel is showing details for — drawn with a persistent ring. */
		selectedId?: string | null;
		/**
		 * Take DOM focus as soon as the first node mounts.
		 *
		 * Set by the panel ONLY after a keyboard-initiated navigation, which
		 * destroys the node the user was on and drops focus to `<body>`. Read
		 * once at init (see `pendingFocus`) — it is an instruction for this
		 * mount, not reactive state.
		 */
		focusOnMount?: boolean;
		onactivate: (node: GraphNode, source: ActivationSource) => void;
		/** Fires with the hovered/focused node, or null when it is left. */
		onnodehover?: (node: GraphNode | null) => void;
	} = $props();

	// Unique per instance: two canvases on one page must not share a
	// <clipPath> / <marker> id.
	const uid = $props.id();
	const maskId = `${uid}-nodemask`;
	const fadeId = `${uid}-nodefade`;
	const arrowId = `${uid}-arrow`;
	const legendId = `${uid}-legend`;

	/** Legend visibility. Open by default — the colours mean nothing without it. */
	let legendOpen = $state(true);

	/**
	 * The node the pointer/focus is on. REPORTED UPWARD rather than rendered
	 * here: the detail card must be mouse-overable, and any interactive
	 * overlay inside this scroller sits on top of neighbouring nodes and
	 * swallows their hover — the node under the card became unreachable.
	 * The panel renders it in its footer, outside the graph, where it can
	 * never occlude anything. This component only draws the hover outline
	 * that links the two.
	 */
	let hoveredId = $state<string | null>(null);

	function enterNode(node: GraphNode) {
		hoveredId = node.id;
		onnodehover?.(node);
	}

	function leaveNode(nodeId: string) {
		// The pointer moving straight to the next node fires its `mouseenter`
		// BEFORE this `mouseleave`, so only clear when still the current one.
		if (hoveredId !== nodeId) return;
		hoveredId = null;
		onnodehover?.(null);
	}


	/** The canvas root, for the mount-time focus hand-off below. */
	let rootEl: HTMLDivElement;
	/** Guards the hand-off to a single claim per mount. */
	let hasClaimedFocus = false;

	let focusedId = $state<string | null>(null);
	let zoom = $state(1);
	let dragging = $state(false);
	/** The scroll container. Dragging pans by scrolling THIS, not by transforming the SVG. */
	let scroller: HTMLDivElement;

	// id → element, for moving DOM focus when the arrows move the roving
	// tabindex. An action rather than `bind:this` into a record: node ids are
	// database strings, so a `querySelector` lookup would need escaping, and
	// `bind:this` into a plain object is a non-reactive binding.
	const nodeEls = new Map<string, SVGGElement>();
	function registerNode(el: SVGGElement, id: string) {
		nodeEls.set(id, el);
		return {
			destroy() {
				nodeEls.delete(id);
			},
		};
	}

	let panStartX = 0;
	let panStartY = 0;
	let panOriginLeft = 0;
	let panOriginTop = 0;

	// Roving tabindex: exactly one node is tab-reachable at a time.
	//
	// `focusedId` is only honoured while it still names a node of the CURRENT
	// layout. Drilling in (or popping back) swaps the whole graph for one with
	// different ids, and a stale id would match nothing — leaving every node at
	// `tabindex="-1"` and the graph unreachable by keyboard entirely.
	let activeId = $derived(
		(focusedId !== null && layout.nodes.some((n) => n.id === focusedId) ? focusedId : layout.nodes[0]?.id) ?? null,
	);
	// Every node box is the same size, so one shared text mask covers them all.
	let boxWidth = $derived(layout.nodes[0]?.width ?? DEFAULT_LAYOUT_OPTIONS.nodeWidth);
	let boxHeight = $derived(layout.nodes[0]?.height ?? DEFAULT_LAYOUT_OPTIONS.nodeHeight);
	let textWidth = $derived(boxWidth - LABEL_GUTTER);
	let fadeStart = $derived(labelFadeStart(textWidth));

	/**
	 * Take focus once, on mount, when the panel says the navigation that got us
	 * here came from the keyboard.
	 *
	 * An `$effect` rather than something inside `registerNode`, and it queries
	 * the DOM rather than reading `nodeEls`, for one reason each:
	 *   - an action runs while its element is still DETACHED, and `focus()` on
	 *     a detached element is silently a no-op (this was tried; it failed);
	 *   - script-level effects are created before the template's action
	 *     effects, so `nodeEls` is not yet populated when this runs. The
	 *     rendered `tabindex="0"` is the same answer without the ordering
	 *     assumption.
	 * The `hasClaimedFocus` guard keeps it to one claim even though reading
	 * `focusOnMount` makes it a dependency; the panel unmounts this component
	 * on every navigation, so one claim per mount is one per navigation.
	 */
	$effect(() => {
		if (!focusOnMount || hasClaimedFocus) return;
		hasClaimedFocus = true;
		rootEl.querySelector<SVGGElement>('[data-node-id][tabindex="0"]')?.focus();
	});

	function focusNode(id: string) {
		focusedId = id;
		nodeEls.get(id)?.focus();
	}

	function activate(node: GraphNode, source: ActivationSource) {
		focusedId = node.id;
		onactivate(node, source);
	}

	function onNodeKeydown(e: KeyboardEvent, node: GraphNode) {
		if (isActivationKey(e.key)) {
			e.preventDefault();
			activate(node, "keyboard");
			return;
		}
		const next = moveFocus(layout.nodes, focusedId, e.key);
		if (next === null) return;
		e.preventDefault();
		focusNode(next);
	}

	function startPan(e: MouseEvent) {
		// A drag that starts on a node is a click on that node, not a pan.
		if ((e.target as Element | null)?.closest("[data-node-id]")) return;
		dragging = true;
		panStartX = e.clientX;
		panStartY = e.clientY;
		panOriginLeft = scroller.scrollLeft;
		panOriginTop = scroller.scrollTop;
	}

	function movePan(e: MouseEvent) {
		if (!dragging) return;
		// The button was released OUTSIDE the browser window, so no `mouseup`
		// ever reached us and the drag would otherwise stay stuck on — the graph
		// would then pan with nothing held down. The first move back over the
		// page reports no buttons pressed, which is where we notice.
		if (e.buttons === 0) {
			dragging = false;
			return;
		}
		// Dragging right reveals what is to the LEFT, so scroll DEcreases —
		// grab-and-drag, the same direction a touch scroll moves.
		//
		// Scroll offsets are rendered CSS pixels and so is the mouse delta, so
		// this is 1:1 with no zoom conversion. The old implementation translated
		// a `<g>` inside the SVG instead, which needed a `/ zoom` correction AND
		// pushed content past the viewBox, where SVG's default `overflow: hidden`
		// simply clipped it — panning HID the graph rather than revealing it.
		scroller.scrollLeft = panOriginLeft - (e.clientX - panStartX);
		scroller.scrollTop = panOriginTop - (e.clientY - panStartY);
	}

	function endPan() {
		dragging = false;
	}

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		zoom = zoomBy(zoom, wheelZoomFactor(e.deltaY));
	}

	function resetView() {
		zoom = 1;
		scroller.scrollLeft = 0;
		scroller.scrollTop = 0;
	}
</script>

<svelte:window onmousemove={movePan} onmouseup={endPan} />

<div bind:this={rootEl} class="graph-canvas relative h-full w-full" data-testid="chat-graph-canvas">
	<!-- Outside the scroller so the controls stay pinned to the corner. -->
	<div class="absolute right-2 top-2 z-10 flex flex-col gap-1">
		<button
			type="button"
			data-testid="chat-graph-zoom-in"
			aria-label="Zoom in"
			onclick={() => (zoom = zoomBy(zoom, ZOOM_STEP))}
			class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
		>+</button>
		<button
			type="button"
			data-testid="chat-graph-zoom-out"
			aria-label="Zoom out"
			onclick={() => (zoom = zoomBy(zoom, 1 / ZOOM_STEP))}
			class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
		>−</button>
		<!-- The visible text is a prefix of the accessible name (WCAG 2.5.3 Label
		     in Name), so voice control can address it by what it reads. It resets
		     zoom and pan to 100% — it does not fit the graph to the panel, so it
		     must not be labelled "Fit". -->
		<button
			type="button"
			data-testid="chat-graph-zoom-reset"
			aria-label="Reset view"
			onclick={resetView}
			class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
		>Reset</button>
	</div>

	<div
		bind:this={scroller}
		class="h-full w-full overflow-auto p-1"
		data-testid="chat-graph-scroller"
	>
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<svg
		class="select-none {dragging ? 'cursor-grabbing' : 'cursor-grab'}"
		width={layout.width * zoom}
		height={layout.height * zoom}
		viewBox="0 0 {layout.width} {layout.height}"
		role="group"
		aria-label="Conversation graph"
		onmousedown={startPan}
		onwheel={onWheel}
	>
		<defs>
			<marker
				id={arrowId}
				viewBox="0 0 8 8"
				refX="7"
				refY="4"
				markerWidth="5"
				markerHeight="5"
				orient="auto-start-reverse"
			>
				<path class="edge-arrow" d="M 0 0 L 8 4 L 0 8 z" />
			</marker>
			<!-- Text mask: bounds the label to the box AND fades its last few px
			     to transparent, so an overlong label ends in a soft edge instead
			     of a glyph sliced down the middle. `#fff`/`#000` here are mask
			     luminance (opaque / transparent), NOT theme colour — a mask has
			     no light and dark variant. -->
			<linearGradient id={fadeId} x1="0" x2="1" y1="0" y2="0">
				<stop offset="0" stop-color="#fff" />
				<stop offset={fadeStart} stop-color="#fff" />
				<stop offset="1" stop-color="#000" />
			</linearGradient>
			<mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={textWidth} height={boxHeight}>
				<rect x="0" y="0" width={textWidth} height={boxHeight} fill="url(#{fadeId})" />
			</mask>
		</defs>

			<g class="edges" fill="none">
				{#each layout.edges as e (`${e.from}->${e.to}-${e.kind}`)}
					<path
						class="edge"
						data-testid="chat-graph-edge"
						data-kind={e.kind}
						data-from={e.from}
						data-to={e.to}
						d={e.path}
						stroke-dasharray={edgeDashArray(e.kind)}
						marker-end="url(#{arrowId})"
					/>
				{/each}
			</g>

			{#each layout.nodes as ln (ln.id)}
				{@const n = ln.node}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<g
					use:registerNode={ln.id}
					class="node"
					data-testid="chat-graph-node"
					data-node-id={ln.id}
					data-kind={n.kind}
					data-status={n.status}
					data-excluded={n.excluded === true ? "true" : "false"}
					data-drillable={n.drillable === true ? "true" : "false"}
					data-hovered={hoveredId === ln.id ? "true" : "false"}
					transform="translate({ln.x},{ln.y})"
					role="button"
					tabindex={ln.id === activeId ? 0 : -1}
					aria-label={nodeAriaLabel(n)}
					onclick={() => activate(n, "pointer")}
					onkeydown={(e) => onNodeKeydown(e, n)}
					onfocus={() => { focusedId = ln.id; enterNode(n); }}
					onblur={() => leaveNode(ln.id)}
					onmouseenter={() => enterNode(n)}
					onmouseleave={() => leaveNode(ln.id)}
				>
					<!-- No <title>: it duplicates the detail card below and browsers
					     render it as a second, slower native tooltip on top of it. -->
					<rect class="node-box" width={ln.width} height={ln.height} rx="6" />
					<!-- Inset so the bar sits on the box's straight left edge instead
					     of poking out past its rounded corners. -->
					<rect class="node-accent" x="1" y="6" width="3" height={ln.height - 12} rx="1.5" />
					<circle class="node-status" cx={ln.width - 11} cy="11" r="3.5" />
					<g mask="url(#{maskId})">
						<text class="node-label" x="11" y="19">{n.label}</text>
						<text class="node-meta" x="11" y="33">{KIND_LABEL[n.kind]} · {formatNodeDuration(n.durationMs)}</text>
					</g>
					{#if ln.id === focusedId || ln.id === selectedId}
						<rect
							class="focus-ring"
							data-testid="chat-graph-node-ring"
							x="-3"
							y="-3"
							width={ln.width + 6}
							height={ln.height + 6}
							rx="8"
						/>
					{/if}
				</g>
		{/each}
	</svg>
	</div>

	<!-- Legend. Inside `.graph-canvas` on purpose: that element declares the
	     `--ez-kind-*` / `--ez-status-*` custom properties, so the swatches
	     inherit the SAME values the nodes are drawn with and cannot drift.
	     Sits outside the scroller so it stays pinned while the graph pans.
	     Collapsible because at a small panel width an always-on legend covers
	     the bottom-right nodes; the state is component-local (not persisted)
	     since it is cheap to reopen. -->
	<div class="absolute bottom-2 right-2 z-10 flex flex-col items-end gap-1">
		<button
			type="button"
			data-testid="chat-graph-legend-toggle"
			aria-expanded={legendOpen}
			aria-controls={legendId}
			onclick={() => (legendOpen = !legendOpen)}
			class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
		>{legendOpen ? "Hide key" : "Key"}</button>
		{#if legendOpen}
			<div
				id={legendId}
				data-testid="chat-graph-legend"
				class="legend rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 shadow-lg"
			>
				{#each legendSections() as section (section.title)}
					<p class="legend-title">{section.title}</p>
					<ul class="legend-list">
						{#each section.items as item (item.id)}
							<!-- `data-legend-id` is unique only WITHIN a section: `error` is
							     both a node kind ("Error") and a status ("failed"). Pair it with
							     the group so a selector can name exactly one row. -->
							<li class="legend-row" data-legend-group={section.sample} data-legend-id={item.id}>
								{#if section.sample === "bar"}
									<span class="sample sample-bar" data-kind={item.id}></span>
								{:else if section.sample === "dot"}
									<span class="sample sample-dot" data-status={item.id}></span>
								{:else}
									<span class="sample sample-line" data-link={item.id}></span>
								{/if}
								<span class="legend-label" class:capitalize={section.sample === "dot"}>{item.label}</span>
							</li>
						{/each}
					</ul>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	/* Kind + status hues. Declared as custom properties on the root so the
	   dark override is one block instead of one per selector, and so every
	   value stays a palette token — no hardcoded hex anywhere. */
	.graph-canvas {
		--ez-graph-edge: var(--color-border-strong);
		--ez-kind-prompt: var(--color-blue-600);
		--ez-kind-assistant: var(--color-emerald-600);
		--ez-kind-thinking: var(--color-purple-500);
		--ez-kind-tool: var(--color-amber-600);
		--ez-kind-subagent: var(--color-pink-600);
		--ez-kind-error: var(--color-red-600);
		--ez-status-success: var(--color-green-600);
		--ez-status-error: var(--color-red-600);
		--ez-status-running: var(--color-amber-500);
		--ez-status-interrupted: var(--color-gray-400);
	}
	:global(.dark) .graph-canvas {
		--ez-kind-prompt: var(--color-blue-400);
		--ez-kind-assistant: var(--color-emerald-400);
		--ez-kind-thinking: var(--color-purple-400);
		--ez-kind-tool: var(--color-amber-400);
		--ez-kind-subagent: var(--color-pink-400);
		--ez-kind-error: var(--color-red-400);
		--ez-status-success: var(--color-green-400);
		--ez-status-error: var(--color-red-400);
		--ez-status-running: var(--color-amber-400);
		--ez-status-interrupted: var(--color-gray-500);
	}

	.edge {
		stroke: var(--ez-graph-edge);
		stroke-width: 1.5;
	}
	/* A rewind / A-B-retry fork. Solid like `sequence` (the edge kinds differ
	   in meaning, not in line style — the greyed subtree is what marks the
	   rewound path), but accent-tinted so a fork is findable at a glance. */
	.edge[data-kind="branch"] {
		stroke: var(--color-accent);
	}
	/* `context-stroke` makes each arrowhead match its own edge; the preceding
	   declaration is the fallback for engines that don't support it. */
	.edge-arrow {
		fill: var(--ez-graph-edge);
		fill: context-stroke;
	}

	.node-box {
		fill: var(--color-surface-tertiary);
		stroke: var(--color-border-strong);
		stroke-width: 1;
	}
	.node-label {
		fill: var(--color-text-primary);
		font-size: 11.5px;
		font-weight: 600;
	}
	.node-meta {
		fill: var(--color-text-muted);
		font-size: 9.5px;
	}

	/* Drillable nodes are the headline interaction — they must LOOK clickable. */
	.node[data-drillable="true"] {
		cursor: pointer;
	}
	.node[data-drillable="true"]:hover .node-box {
		fill: var(--color-surface-elevated);
		stroke: var(--color-accent);
	}
	/* The browser's own ring would be clipped by the SVG; we draw our own. */
	.node:focus {
		outline: none;
	}
	.focus-ring {
		fill: none;
		stroke: var(--color-accent);
		stroke-width: 2;
	}

	/* Rewound-away branch: the BOX is dimmed and dashed, the TEXT is not.
	   Opacity on the whole `<g>` drags the label down with it — measured
	   against the panel surface that gave 2.69:1 (light) / 3.98:1 (dark) for
	   the label and 1.83:1 / 1.97:1 for the meta line, all under the WCAG AA
	   4.5:1 floor for normal text. Dimming only the non-text children keeps
	   the greyed-out read at 5.91:1 / 5.25:1 worst case, and the dashed
	   stroke plus the spoken "rewound away" carry the state. */
	.node[data-excluded="true"] .node-box,
	.node[data-excluded="true"] .node-accent,
	.node[data-excluded="true"] .node-status {
		opacity: 0.45;
	}
	.node[data-excluded="true"] .node-box {
		stroke-dasharray: 4 3;
	}

	/* The card is pinned, so this outline is what ties it to its node. */
	.node[data-hovered="true"] .node-box {
		stroke: var(--color-accent);
		stroke-width: 2;
	}

	.node-accent {
		fill: var(--ez-kind-prompt);
	}
	.node[data-kind="assistant"] .node-accent {
		fill: var(--ez-kind-assistant);
	}
	.node[data-kind="thinking"] .node-accent {
		fill: var(--ez-kind-thinking);
	}
	.node[data-kind="tool"] .node-accent {
		fill: var(--ez-kind-tool);
	}
	.node[data-kind="subagent"] .node-accent {
		fill: var(--ez-kind-subagent);
	}
	.node[data-kind="error"] .node-accent {
		fill: var(--ez-kind-error);
	}

	.node-status {
		fill: var(--ez-status-success);
	}
	.node[data-status="error"] .node-status {
		fill: var(--ez-status-error);
	}
	.node[data-status="running"] .node-status {
		fill: var(--ez-status-running);
	}
	.node[data-status="interrupted"] .node-status {
		fill: var(--ez-status-interrupted);
	}

	/* ── Legend ──────────────────────────────────────────────────────────
	   Every swatch reads the SAME custom property as the shape it explains
	   (`--ez-kind-*`, `--ez-status-*`, `--ez-graph-edge`, `--color-accent`),
	   so a palette change moves both together and the key can never lie.
	   Capped height + scroll so a future extra kind can't grow the box past
	   the panel; `max-w` keeps it off the graph on a narrow drawer. */
	.legend {
		max-height: 60%;
		max-width: 13rem;
		overflow-y: auto;
		font-size: 10px;
		line-height: 1.4;
	}
	.legend-title {
		margin: 0.25rem 0 0.125rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-muted);
	}
	.legend-title:first-child {
		margin-top: 0;
	}
	.legend-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.legend-row {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}
	.legend-label {
		color: var(--color-text-secondary);
	}
	.capitalize {
		text-transform: capitalize;
	}
	.sample {
		flex: none;
		display: inline-block;
	}
	/* Mirrors the node's left accent bar (3px wide, rounded). */
	.sample-bar {
		width: 3px;
		height: 11px;
		border-radius: 1.5px;
		background: var(--ez-kind-prompt);
	}
	.sample-bar[data-kind="assistant"] { background: var(--ez-kind-assistant); }
	.sample-bar[data-kind="thinking"] { background: var(--ez-kind-thinking); }
	.sample-bar[data-kind="tool"] { background: var(--ez-kind-tool); }
	.sample-bar[data-kind="subagent"] { background: var(--ez-kind-subagent); }
	.sample-bar[data-kind="error"] { background: var(--ez-kind-error); }
	/* Mirrors the node's status dot (r=3.5 ⇒ 7px). */
	.sample-dot {
		width: 7px;
		height: 7px;
		border-radius: 9999px;
		background: var(--ez-status-success);
	}
	.sample-dot[data-status="error"] { background: var(--ez-status-error); }
	.sample-dot[data-status="running"] { background: var(--ez-status-running); }
	.sample-dot[data-status="interrupted"] { background: var(--ez-status-interrupted); }
	/* Mirrors an edge: 2px stroke, dashed for `spawn`, accent-tinted for a
	   fork. `excluded` reuses the node box's 4-3 dash + 0.45 dim. */
	.sample-line {
		width: 14px;
		height: 0;
		border-top: 2px solid var(--ez-graph-edge);
	}
	.sample-line[data-link="spawn"] {
		border-top-style: dashed;
	}
	.sample-line[data-link="branch"] {
		border-top-color: var(--color-accent);
	}
	.sample-line[data-link="excluded"] {
		border-top-style: dashed;
		opacity: 0.45;
	}
	.legend-row[data-legend-id="excluded"] .legend-label {
		opacity: 0.7;
	}
</style>
