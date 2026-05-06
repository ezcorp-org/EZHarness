<script lang="ts">
	import { fetchCommandBody, fetchFeatureDetails, type FeatureDetails } from "$lib/api";
	import { store } from "$lib/stores.svelte";
	import { buildFileTree } from "$lib/feature-file-tree";
	import FeatureFileTree from "./FeatureFileTree.svelte";

	let {
		name,
		kind,
		status,
		onclick,
		stretch = false,
		tooltip,
	}: {
		name: string;
		kind: 'agent' | 'extension' | 'team' | 'file' | 'dir' | 'command' | 'feature';
		status?: 'pending' | 'running' | 'complete' | 'error';
		onclick?: () => void;
		stretch?: boolean;
		tooltip?: string;
	} = $props();

	// Single hover flag covering both the chip and its popover. Two
	// regions because the popover may be interactive (feature file tree
	// toggle), but the boolean is one — the cursor is either over one
	// of those regions, or it isn't.
	let hovering = $state(false);
	let chipEl: HTMLSpanElement | undefined = $state();

	// Closing is deferred a tick because the browser fires mouseleave
	// on the leaving region *before* mouseenter on the entering one
	// when the cursor crosses chip↔popover. Without the timer,
	// `hovering` flips false for one frame, the popover unmounts, and
	// the upcoming mouseenter lands on a vanished element. Any
	// subsequent enter on either region cancels the pending close.
	const HOVER_CLOSE_DELAY_MS = 80;
	let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;

	function cancelHoverClose() {
		if (hoverCloseTimer) {
			clearTimeout(hoverCloseTimer);
			hoverCloseTimer = null;
		}
	}

	function scheduleHoverClose() {
		cancelHoverClose();
		hoverCloseTimer = setTimeout(() => {
			hovering = false;
			hoverCloseTimer = null;
		}, HOVER_CLOSE_DELAY_MS);
	}

	// Where the command-hover popover renders relative to the chip.
	// Default "above" matches current UX; flips to "below" when the chip
	// sits too close to the top of the viewport for the popover to fit.
	// Recomputed on every mouseenter so the right decision is made for
	// the chip's actual position (which can shift as the chat scrolls).
	//
	// The popover max height is 320px (pre) + header + padding; we use
	// 360px as the flip threshold to leave a small margin.
	let popoverPosition = $state<'above' | 'below'>('above');
	const POPOVER_FLIP_THRESHOLD_PX = 360;

	function computePopoverPosition() {
		if (!(isCommand || isFeature) || !chipEl || typeof window === 'undefined') return;
		const rect = chipEl.getBoundingClientRect();
		const spaceAbove = rect.top;
		const spaceBelow = window.innerHeight - rect.bottom;
		// Default "above"; flip to "below" if there isn't enough room
		// above AND there's more room below. This keeps the popover
		// from being clipped when the chip is near the top of the page.
		if (spaceAbove < POPOVER_FLIP_THRESHOLD_PX && spaceBelow > spaceAbove) {
			popoverPosition = 'below';
		} else {
			popoverPosition = 'above';
		}
	}

	const statusColors: Record<string, string> = {
		pending: 'bg-gray-400',
		running: 'bg-yellow-400 animate-pulse',
		complete: 'bg-green-500',
		error: 'bg-red-500',
	};

	let isPath = $derived(kind === 'file' || kind === 'dir');
	let isCommand = $derived(kind === 'command');
	let isFeature = $derived(kind === 'feature');

	// File / dir chips show the basename in the pill; full path goes into the
	// tooltip. Dir chips append a trailing `/` so folders are visually distinct
	// from files at a glance.
	let displayName = $derived.by(() => {
		if (!isPath) return name;
		const base = name.lastIndexOf('/') >= 0 ? name.slice(name.lastIndexOf('/') + 1) : name;
		return kind === 'dir' ? `${base}/` : base;
	});

	// Sigil prefix matches the stored token syntax: `!` for agent/ext/team,
	// `@` for file/dir (path kinds), `/` for commands, `$` for feature.
	let sigil = $derived(isPath ? '@' : isCommand ? '/' : isFeature ? '$' : '!');

	// For path chips (file/dir), always surface the full relative path on
	// hover even without an explicit tooltip prop.
	let effectiveTooltip = $derived(tooltip ?? (isPath ? name : undefined));

	// Command chips lazily resolve the prompt body on first hover so
	// readers can peek what the LLM actually received. Server-side
	// `applyCommandExpansion` substitutes the body at stream time; we
	// fetch it separately here just for display.
	let commandBody = $state<string | null>(null);
	let commandBodyLoading = $state(false);

	async function loadCommandBody() {
		if (!isCommand || commandBody !== null || commandBodyLoading) return;
		commandBodyLoading = true;
		try {
			// Project-scoped commands (`project:claude-commands`, etc.)
			// only resolve when we pass the active project. Treat the
			// sentinel `"global"` as "no project" so home + DB commands
			// still come through.
			const pid =
				store.activeProjectId && store.activeProjectId !== 'global'
					? store.activeProjectId
					: undefined;
			commandBody = await fetchCommandBody(name, pid);
		} finally {
			commandBodyLoading = false;
		}
	}

	// Feature chips lazy-fetch their description + file list on first
	// hover. Like commands, the chat-history token persists raw; the
	// LLM sees the expanded system note. The popover surfaces the same
	// info to readers — collapsed by default so a 30-file feature
	// doesn't dominate the chat.
	let featureDetails = $state<FeatureDetails | null>(null);
	let featureDetailsLoading = $state(false);

	// Re-shape the flat relpath list into a code-editor-style tree once
	// per details fetch. `buildFileTree` is pure + cheap (O(N log N) on
	// path count), so deriving on every render is fine — features
	// rarely have more than a few dozen files.
	let featureFileTree = $derived(
		featureDetails ? buildFileTree(featureDetails.files.map((f) => f.relpath)) : [],
	);

	async function loadFeatureDetails() {
		if (!isFeature || featureDetails !== null || featureDetailsLoading) return;
		const pid = store.activeProjectId;
		if (!pid || pid === 'global') return;
		featureDetailsLoading = true;
		try {
			featureDetails = await fetchFeatureDetails(name, pid);
		} finally {
			featureDetailsLoading = false;
		}
	}

	// ── Tap-and-hold (mobile) ───────────────────────────────────────
	// Touch devices don't fire mouseenter/leave, so a long-press
	// (≥ 500ms) is the mobile equivalent of "hover" — it pins the
	// popover open until the user taps outside. `pinnedByTouch` keeps
	// `hovering` latched after touchend (the deferred-close timer
	// would otherwise fire as soon as the finger lifts).
	const TOUCH_HOLD_MS = 500;
	let touchHoldTimer: ReturnType<typeof setTimeout> | null = null;
	let pinnedByTouch = $state(false);

	function openPopoverFromTouch() {
		cancelHoverClose();
		hovering = true;
		pinnedByTouch = true;
		if (isCommand) {
			computePopoverPosition();
			loadCommandBody();
		}
		if (isFeature) {
			computePopoverPosition();
			loadFeatureDetails();
		}
	}

	function clearTouchHold() {
		if (touchHoldTimer) {
			clearTimeout(touchHoldTimer);
			touchHoldTimer = null;
		}
	}

	function onTouchStart() {
		// Only chips that have something to show on hover should react
		// to long-press. A bare agent/team chip with no tooltip stays a
		// plain tap target.
		if (!effectiveTooltip && !isCommand && !isFeature) return;
		clearTouchHold();
		touchHoldTimer = setTimeout(() => {
			openPopoverFromTouch();
			touchHoldTimer = null;
		}, TOUCH_HOLD_MS);
	}

	// Movement before the timer fires means the user is scrolling, not
	// pressing — cancel so we don't accidentally pop a card mid-scroll.
	function onTouchMoveOrEnd() {
		clearTouchHold();
	}

	// Suppress the browser's long-press callout (context menu / text
	// selection bubble) on any chip that has its own popover. Without
	// this, iOS Safari + Android Chrome show their native long-press UI
	// (selection/share menu) on top of — or instead of — our popover.
	// Plain chips (no tooltip / popover) keep default behavior.
	function onContextMenu(e: Event) {
		if (effectiveTooltip || isCommand || isFeature) e.preventDefault();
	}

	// Tap outside the chip + its popover dismisses the touch-pinned
	// popover. Capture-phase so we close before any inner click handler
	// (e.g. the file-tree toggle) re-opens us via state confusion.
	$effect(() => {
		if (!pinnedByTouch) return;
		function handle(e: MouseEvent | TouchEvent) {
			const target = e.target as Node | null;
			if (!target) return;
			if (chipEl?.contains(target)) return;
			pinnedByTouch = false;
			cancelHoverClose();
			hovering = false;
		}
		document.addEventListener('click', handle as EventListener, true);
		document.addEventListener('touchstart', handle as EventListener, true);
		return () => {
			document.removeEventListener('click', handle as EventListener, true);
			document.removeEventListener('touchstart', handle as EventListener, true);
		};
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span class="{effectiveTooltip || isCommand || isFeature ? 'relative inline-block' : ''}" bind:this={chipEl}>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<span
		class="relative inline-flex items-center rounded-full border px-1.5 py-0.5 text-xs font-medium {kind === 'agent'
			? 'border-blue-500/30 bg-blue-500/20 text-blue-300'
			: kind === 'team'
				? 'border-indigo-500/30 bg-indigo-500/20 text-indigo-300'
				: kind === 'file'
					? 'border-green-500/30 bg-green-500/20 text-green-300'
					: kind === 'dir'
						? 'border-amber-500/30 bg-amber-500/20 text-amber-300'
						: kind === 'command'
							? 'border-pink-500/30 bg-pink-500/20 text-pink-300'
							: 'border-purple-500/30 bg-purple-500/20 text-purple-300'} {onclick ? 'cursor-pointer hover:brightness-125' : 'cursor-default'} {stretch ? 'w-full justify-center' : ''}"
		onclick={onclick}
		onkeydown={onclick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onclick?.(); } : undefined}
		onmouseenter={() => {
			cancelHoverClose();
			if (effectiveTooltip || isCommand || isFeature) hovering = true;
			if (isCommand) {
				computePopoverPosition();
				loadCommandBody();
			}
			if (isFeature) {
				computePopoverPosition();
				loadFeatureDetails();
			}
		}}
		onmouseleave={() => { scheduleHoverClose(); }}
		ontouchstart={onTouchStart}
		ontouchend={onTouchMoveOrEnd}
		ontouchcancel={onTouchMoveOrEnd}
		ontouchmove={onTouchMoveOrEnd}
		oncontextmenu={onContextMenu}
		role={onclick ? 'button' : undefined}
		tabindex={onclick ? 0 : undefined}
		data-mention-kind={kind}
		data-mention-name={name}
	>{sigil}{displayName}{#if status}<span class="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full {statusColors[status] ?? ''}"></span>{/if}</span>
	{#if isCommand && hovering}
		<div
			class="absolute {popoverPosition === 'above' ? 'bottom-full mb-2' : 'top-full mt-2'} left-0 z-30 w-max max-w-xl rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-2 text-xs text-[var(--color-text-primary)] shadow-lg"
			role="tooltip"
			data-command-popover={name}
			data-command-popover-position={popoverPosition}
		>
			<div class="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
				Prompt sent for /{name}
			</div>
			{#if commandBody !== null}
				<pre class="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-[var(--color-text-secondary)]">{commandBody}</pre>
			{:else if commandBodyLoading}
				<span class="text-[var(--color-text-muted)] italic">Loading prompt…</span>
			{:else}
				<span class="text-[var(--color-text-muted)] italic">Prompt body unavailable.</span>
			{/if}
		</div>
	{:else if isFeature && hovering}
		<!--
			No `mb-2`/`mt-2` gap on the feature popover: the chip and the
			popover share an edge so the cursor can transition into the
			popover without crossing dead space. This matters because the
			popover has an interactive Files toggle — the popover's own
			mouseenter cancels the chip's pending close timer so the
			user can click/scroll inside without it vanishing.
		-->
		<div
			class="absolute {popoverPosition === 'above' ? 'bottom-full' : 'top-full'} left-0 z-30 w-max max-w-md rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-3 py-2 text-xs text-[var(--color-text-primary)] shadow-lg"
			role="tooltip"
			data-feature-popover={name}
			data-feature-popover-position={popoverPosition}
			onmouseenter={() => { cancelHoverClose(); hovering = true; }}
			onmouseleave={() => { scheduleHoverClose(); }}
		>
			<div class="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
				Feature ${name}
			</div>
			{#if featureDetails}
				{#if featureDetails.description}
					<p class="m-0 mb-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--color-text-secondary)]">{featureDetails.description}</p>
				{:else}
					<p class="m-0 mb-2 italic text-[var(--color-text-muted)]">No description.</p>
				{/if}
				<div
					class="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"
					data-feature-files-header
				>
					Files ({featureDetails.files.length})
				</div>
				{#if featureDetails.files.length > 0}
					<div
						class="max-h-64 overflow-auto rounded border border-[var(--color-border)]/40 bg-[var(--color-surface-secondary)]/40 px-2 py-1 text-xs"
						data-feature-files-list
					>
						<FeatureFileTree nodes={featureFileTree} />
					</div>
				{:else}
					<p class="m-0 italic text-[var(--color-text-muted)]">No files pinned.</p>
				{/if}
			{:else if featureDetailsLoading}
				<span class="text-[var(--color-text-muted)] italic">Loading feature…</span>
			{:else}
				<span class="text-[var(--color-text-muted)] italic">Feature unavailable.</span>
			{/if}
		</div>
	{:else if effectiveTooltip && hovering}
		<span class="absolute bottom-full left-0 mb-1 z-20 max-w-xs rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap shadow-lg">{effectiveTooltip}</span>
	{/if}
</span>
