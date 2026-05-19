<!--
  DockHost — floating right-side panel that mounts the tool card whose
  cardLayout is "dock". One instance is mounted at the (app)/+layout.svelte
  level; it reads `store.dockState[activeConvId]` and renders the routed
  card via ToolCardRouter with `mode="dock"`.

  Resize: drag handle on the LEFT edge — pointermove writes to
  `store.dockSizePx` (clamped + persisted by `setDockSize`).

  Mobile (≤640px viewport): full-screen overlay (`position: fixed; inset: 0`)
  with swipe-to-dismiss (vertical-down or horizontal-right gesture).

  Security: the routed card is the same component identity as the inline
  path. The iframe primitive's SANDBOX_FLAGS_STRICT is unchanged — see
  `iframe-card-logic.ts`.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import {
		store,
		closeDock,
		openDock,
		setDockSize,
		readPersistedDockSlot,
	} from "$lib/stores.svelte.js";
	import { inlineToolStore } from "$lib/inline-tool-store.svelte.js";
	import ToolCardRouter from "./ToolCardRouter.svelte";
	import { extractPopoutUrl } from "./iframe-card-logic.js";

	let { conversationId }: { conversationId?: string } = $props();

	// Active conversation id — accepted as a prop OR parsed from the URL when
	// not provided. The (app) layout's chat route is
	// `/project/[id]/chat/[convId]`; we extract the last segment after `/chat/`.
	// Reading from `window.location` keeps this component free of `$app/state`
	// so vitest component tests can mount it without the SvelteKit runtime.
	let urlConvId = $state<string | null>(null);
	function refreshConvIdFromUrl(): void {
		if (typeof window === "undefined") {
			urlConvId = null;
			return;
		}
		const m = window.location.pathname.match(/\/chat\/([^/?#]+)/);
		urlConvId = m?.[1] ?? null;
	}

	let activeConvId = $derived<string | null>(conversationId ?? urlConvId);

	let slot = $derived(activeConvId ? store.dockState[activeConvId] ?? null : null);
	let toolCall = $derived.by(() => {
		if (!slot) return null;
		const found = inlineToolStore.getById(slot.toolCallId);
		if (!found) return null;
		// Adapt InlineToolCall → ToolCallState for the router.
		return {
			id: found.id,
			toolName: found.toolName,
			status: found.status === "complete" ? ("complete" as const)
				: found.status === "error" ? ("error" as const)
				: ("running" as const),
			input: found.input,
			output: found.output,
			error: found.error,
			startedAt: found.startedAt ?? Date.now(),
			duration: found.duration,
			extensionId: found.extensionName,
			cardType: found.cardType,
			cardLayout: found.cardLayout,
		};
	});

	// ── Pop-out URL ──────────────────────────────────────────────────
	// SDK contract: any tool whose result carries a same-origin `iframeSrc`
	// gets a "Pop out" affordance for free. The pure helper lives in
	// iframe-card-logic.ts (`extractPopoutUrl`) so it can be unit-tested
	// against every malformed-output shape without rendering the dock.
	let popoutUrl = $derived.by((): string | null => {
		if (typeof window === "undefined") return null;
		return extractPopoutUrl(toolCall?.output, window.location.origin);
	});

	function handlePopout(): void {
		if (!popoutUrl) return;
		// `noopener,noreferrer` severs the back-channel — popped-out tab
		// can't `window.opener` back into the host. The browser may render
		// the same-origin iframe content directly here as a top-level page;
		// the response's CSP from the data route forbids cross-origin loads
		// either way.
		window.open(popoutUrl, "_blank", "noopener,noreferrer");
	}

	// Mobile breakpoint — kept reactive so the layout flips when the user
	// rotates a device or resizes the window. Initialized to a desktop value
	// during SSR to avoid hydration mismatch.
	let viewportWidth = $state<number>(typeof window !== "undefined" ? window.innerWidth : 1280);
	let isMobile = $derived(viewportWidth <= 640);

	// Hydrate the dock on mount + when convId changes. Two-step priority:
	//   1. localStorage persisted slot (the user's last-explicit-open) —
	//      restore if the toolCallId still exists in inlineToolStore.
	//   2. Fall back to the most-recently-completed dock-mode tool call in
	//      this conversation's history. Without this, when scrollback contains
	//      multiple dock-mode calls and the user closed the dock last session,
	//      the per-card auto-open effects would fire one after another, cycling
	//      the dock through every historical canvas. Picking just the latest
	//      shows ONLY the freshest one.
	//
	// Both paths skip silently if `dismissedDocks` already has the toolCallId
	// (user explicitly closed it earlier in this session).
	$effect(() => {
		if (!activeConvId) return;
		if (store.dockState[activeConvId]) return; // already open
		// 1: persisted slot wins.
		const persisted = readPersistedDockSlot(activeConvId);
		if (persisted) {
			const found = inlineToolStore.getById(persisted.toolCallId);
			if (found && !store.dismissedDocks[activeConvId]?.[persisted.toolCallId]) {
				openDock(activeConvId, persisted.toolCallId);
				return;
			}
		}
		// 2: most-recently-completed dock-mode call in this conversation.
		// Sort by `startedAt + duration` (effective completion time); fall back
		// to startedAt if duration unset. Tie-broken by array order which
		// reflects insertion (chronological).
		const candidates = inlineToolStore
			.getByConversation(activeConvId)
			.filter((c) => c.cardLayout === "dock" && c.status === "complete" && c.id);
		if (candidates.length === 0) return;
		const latest = candidates.reduce((best, cur) => {
			const bestT = (best.startedAt ?? 0) + (best.duration ?? 0);
			const curT = (cur.startedAt ?? 0) + (cur.duration ?? 0);
			return curT >= bestT ? cur : best;
		});
		if (!latest.id) return;
		if (store.dismissedDocks[activeConvId]?.[latest.id]) return;
		openDock(activeConvId, latest.id);
	});

	onMount(() => {
		const onResize = () => { viewportWidth = window.innerWidth; };
		const onNav = () => { refreshConvIdFromUrl(); };
		refreshConvIdFromUrl();
		window.addEventListener("resize", onResize);
		window.addEventListener("popstate", onNav);
		// SvelteKit fires no popstate on programmatic goto(), but it does
		// dispatch a `sveltekit:navigation-end` lifecycle event in older
		// versions. The simplest portable signal: poll on each microtask via
		// a low-frequency interval. 250ms is well below the perceptible
		// latency for a panel re-mount and avoids a per-route adapter.
		const poll = setInterval(refreshConvIdFromUrl, 250);
		return () => {
			window.removeEventListener("resize", onResize);
			window.removeEventListener("popstate", onNav);
			clearInterval(poll);
		};
	});

	// ── Drag-to-resize ──
	let dragging = $state(false);
	let dragStartX = 0;
	let dragStartWidth = 0;

	function onHandlePointerDown(e: PointerEvent): void {
		if (isMobile) return;
		dragging = true;
		dragStartX = e.clientX;
		dragStartWidth = store.dockSizePx;
		(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
		e.preventDefault();
	}

	function onHandlePointerMove(e: PointerEvent): void {
		if (!dragging) return;
		// Drag handle is on the LEFT edge of the right-anchored dock — moving
		// LEFT (negative deltaX) widens; RIGHT shrinks.
		const deltaX = e.clientX - dragStartX;
		setDockSize(dragStartWidth - deltaX);
	}

	function onHandlePointerUp(e: PointerEvent): void {
		dragging = false;
		(e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
	}

	// ── Mobile swipe-to-dismiss ──
	// Vertical-down OR horizontal-right swipe of >80px dismisses.
	let touchStartX = 0;
	let touchStartY = 0;
	let touchActive = false;

	function onPanelPointerDown(e: PointerEvent): void {
		if (!isMobile) return;
		touchActive = true;
		touchStartX = e.clientX;
		touchStartY = e.clientY;
	}

	function onPanelPointerMove(_e: PointerEvent): void {
		// We don't transform-translate during the gesture for simplicity;
		// dismiss decision happens on pointerup.
	}

	function onPanelPointerUp(e: PointerEvent): void {
		if (!touchActive || !isMobile) return;
		touchActive = false;
		const dx = e.clientX - touchStartX;
		const dy = e.clientY - touchStartY;
		// Threshold: 80px in either dismiss direction.
		if (dx > 80 || dy > 80) {
			handleClose();
		}
	}

	function handleClose(): void {
		if (activeConvId) closeDock(activeConvId);
	}

	// ── Keyboard dismissal (ESC) ──
	// Convention: Escape collapses any focused floating UI. We only fire when
	// the dock is actually open so we don't intercept ESC from unrelated UI.
	onMount(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			if (!activeConvId || !slot) return;
			handleClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});
</script>

{#if activeConvId && slot && toolCall}
	<aside
		class="dock-host {isMobile ? 'dock-host-mobile' : 'dock-host-desktop'}"
		style={isMobile ? '' : `width: ${store.dockSizePx}px;`}
		aria-label="Canvas dock"
		data-testid="dock-host"
		data-conv-id={activeConvId}
		data-tool-call-id={slot.toolCallId}
		onpointerdown={onPanelPointerDown}
		onpointermove={onPanelPointerMove}
		onpointerup={onPanelPointerUp}
	>
		{#if !isMobile}
			<button
				type="button"
				class="resize-handle"
				aria-label="Resize dock"
				data-testid="dock-resize-handle"
				onpointerdown={onHandlePointerDown}
				onpointermove={onHandlePointerMove}
				onpointerup={onHandlePointerUp}
			></button>
		{/if}
		<header class="dock-header">
			<span class="dock-title">{toolCall.toolName}</span>
			<div class="dock-actions">
				{#if popoutUrl}
					<button
						type="button"
						class="dock-action"
						aria-label="Open in new tab"
						title="Open in new tab"
						data-testid="dock-popout"
						onclick={handlePopout}
					>
						<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M9 2 H14 V7" />
							<path d="M14 2 L8 8" />
							<path d="M12 9 V13 A1 1 0 0 1 11 14 H3 A1 1 0 0 1 2 13 V5 A1 1 0 0 1 3 4 H7" />
						</svg>
						<span class="dock-action-label">Pop out</span>
					</button>
				{/if}
				<button
					type="button"
					class="dock-action dock-close"
					aria-label="Close dock (Esc)"
					title="Close dock (Esc)"
					data-testid="dock-close"
					onclick={handleClose}
				>
					<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
						<path d="M3 3 L13 13 M13 3 L3 13" />
					</svg>
					<span class="dock-action-label">Close</span>
				</button>
			</div>
		</header>
		<div class="dock-body">
			<ToolCardRouter
				toolCall={toolCall}
				conversationId={activeConvId}
				mode="dock"
			/>
		</div>
	</aside>
{/if}

<style>
	.dock-host {
		position: fixed;
		top: 0;
		bottom: 0;
		right: 0;
		z-index: 50;
		display: flex;
		flex-direction: column;
		background: var(--color-surface, #1a1a1a);
		border-left: 1px solid var(--color-border, #2a2a2a);
		box-shadow: -2px 0 12px rgba(0, 0, 0, 0.3);
	}
	.dock-host-mobile {
		inset: 0;
		border-left: 0;
		box-shadow: none;
	}
	.dock-host-desktop {
		min-width: 320px;
		max-width: 80vw;
	}
	.resize-handle {
		position: absolute;
		left: -3px;
		top: 0;
		bottom: 0;
		width: 6px;
		cursor: col-resize;
		background: transparent;
		border: 0;
		padding: 0;
		z-index: 1;
	}
	.resize-handle:hover,
	.resize-handle:focus-visible {
		background: var(--color-accent, #4a72ff);
		opacity: 0.4;
	}
	.dock-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--color-border, #2a2a2a);
		background: var(--color-surface-secondary, #141414);
	}
	.dock-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--color-text-primary, #e0e0e0);
	}
	.dock-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}
	.dock-action {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		font-weight: 500;
		line-height: 1;
		background: var(--color-surface-tertiary, #1c1c1c);
		border: 1px solid var(--color-border, #2a2a2a);
		color: var(--color-text-primary, #e0e0e0);
		cursor: pointer;
		padding: 0.375rem 0.625rem;
		border-radius: 4px;
		transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
	}
	.dock-action:hover,
	.dock-action:focus-visible {
		background: var(--color-surface-secondary, #141414);
		border-color: var(--color-accent, #4a72ff);
		color: var(--color-text-primary, #ffffff);
		outline: none;
	}
	/* Close button keeps its destructive accent — overrides the .dock-action hover. */
	.dock-close:hover,
	.dock-close:focus-visible {
		background: var(--color-error, #ef4444);
		border-color: var(--color-error, #ef4444);
		color: #fff;
	}
	.dock-action-label {
		display: inline;
	}
	@media (max-width: 480px) {
		.dock-action-label { display: none; }
	}
	.dock-body {
		flex: 1;
		overflow: auto;
		padding: 0;
	}
</style>
