<script lang="ts" module>
	// Registry of open drawers so ESC only closes the topmost one
	type DrawerEntry = { zIndex: number; close: () => void };
	const openDrawers: DrawerEntry[] = [];

	function registerDrawer(entry: DrawerEntry) {
		openDrawers.push(entry);
	}
	function unregisterDrawer(close: () => void) {
		const idx = openDrawers.findIndex(d => d.close === close);
		if (idx !== -1) openDrawers.splice(idx, 1);
	}

	function handleGlobalEsc(e: KeyboardEvent) {
		if (e.key !== "Escape" || openDrawers.length === 0) return;
		// Only close the topmost drawer — let the next ESC close the next layer
		const top = openDrawers.reduce((a, b) => a.zIndex >= b.zIndex ? a : b);
		top.close();
		e.stopImmediatePropagation();
	}

	if (typeof window !== "undefined") {
		window.addEventListener("keydown", handleGlobalEsc);
	}
</script>

<script lang="ts">
	import type { Snippet } from "svelte";
	import { createFocusTrap } from "$lib/focus-trap.js";

	let {
		open,
		side,
		maxWidth = "",
		width = "",
		onclose,
		backdrop: showBackdrop = true,
		class: extraClass = "",
		zIndex = 40,
		ariaLabel = "",
		children,
	}: {
		open: boolean;
		side: "left" | "right";
		maxWidth?: string;
		width?: string;
		onclose: () => void;
		backdrop?: boolean;
		class?: string;
		zIndex?: number;
		ariaLabel?: string;
		children: Snippet;
	} = $props();

	let visible = $state(false);
	let entering = $state(false);
	let dragging = $state(false);
	let dragDelta = $state(0);
	let panelEl = $state<HTMLElement | null>(null);
	let overlayEl = $state<HTMLElement | null>(null);

	let startX = 0;
	let startY = 0;
	let startTime = 0;
	let panelWidth = 0;
	let intentResolved = false; // Whether we've determined horizontal vs vertical
	let cleanupFocusTrap: (() => void) | null = null;

	const DEAD_ZONE = 10; // px — must move this far before we decide direction

	let progress = $derived(panelWidth > 0 ? Math.abs(dragDelta) / panelWidth : 0);
	let backdropOpacity = $derived(dragging ? 0.5 * (1 - progress) : 0.5);

	// Manage mount/unmount lifecycle for close animation
	$effect(() => {
		if (open) {
			visible = true;
			// Trigger entry animation next frame
			requestAnimationFrame(() => {
				entering = true;
			});
		} else if (visible) {
			entering = false;
			// Wait for close transition to finish, then unmount
			const timer = setTimeout(() => {
				visible = false;
			}, 300);
			return () => clearTimeout(timer);
		}
	});

	// Focus trap
	$effect(() => {
		if (entering && overlayEl) {
			cleanupFocusTrap = createFocusTrap(overlayEl);
			return () => {
				cleanupFocusTrap?.();
				cleanupFocusTrap = null;
			};
		}
	});

	function panelTransform(): string {
		if (dragging) {
			return `translateX(${dragDelta}px)`;
		}
		if (!entering) {
			return side === "left" ? "translateX(-100%)" : "translateX(100%)";
		}
		return "translateX(0)";
	}

	// Register/unregister in the global drawer stack so ESC closes topmost first
	$effect(() => {
		if (!entering) return;
		registerDrawer({ zIndex, close: onclose });
		return () => unregisterDrawer(onclose);
	});

	function onBackdropClick() {
		onclose();
	}

	function onPanelClick(e: MouseEvent) {
		e.stopPropagation();
	}

	function resetDrag() {
		dragging = false;
		dragDelta = 0;
		intentResolved = false;
	}

	function onTouchStart(e: TouchEvent) {
		if (e.touches.length > 1) return; // Ignore multi-touch
		const touch = e.touches[0]!;
		startX = touch.clientX;
		startY = touch.clientY;
		startTime = Date.now();
		panelWidth = panelEl?.offsetWidth ?? 0;
		dragDelta = 0;
		dragging = false;       // Don't activate until intent is resolved
		intentResolved = false;
	}

	function onTouchMove(e: TouchEvent) {
		const touch = e.touches[0];
		if (!touch) return;

		const dx = touch.clientX - startX;
		const dy = touch.clientY - startY;

		// Still in dead zone — wait for clear directional intent
		if (!intentResolved) {
			const absDx = Math.abs(dx);
			const absDy = Math.abs(dy);
			if (absDx < DEAD_ZONE && absDy < DEAD_ZONE) return;

			// Resolve intent: horizontal wins only if it's dominant
			if (absDx > absDy) {
				intentResolved = true;
				dragging = true;
				startTime = Date.now(); // Reset for accurate velocity
			} else {
				// Vertical scroll — bail out entirely
				intentResolved = true;
				dragging = false;
				return;
			}
		}

		if (!dragging) return;

		if (side === "left") {
			dragDelta = Math.min(0, dx);
		} else {
			dragDelta = Math.max(0, dx);
		}
	}

	function onTouchEnd() {
		if (!dragging) {
			intentResolved = false;
			return;
		}
		const elapsed = Date.now() - startTime;
		const velocity = elapsed > 0 ? Math.abs(dragDelta) / elapsed : 0;
		const shouldClose = velocity > 0.5 || progress > 0.4;

		dragging = false;
		dragDelta = 0;
		intentResolved = false;

		if (shouldClose) {
			onclose();
		}
	}
</script>

{#if visible}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="fixed inset-0"
		style:z-index={zIndex}
		role="dialog"
		aria-modal="true"
		aria-label={ariaLabel || undefined}
		data-testid="swipe-drawer"
		bind:this={overlayEl}
	>
		{#if showBackdrop}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="absolute inset-0 bg-black"
				style:opacity={backdropOpacity}
				style:will-change="opacity"
				style:transition={dragging ? "none" : "opacity 300ms cubic-bezier(0.32, 0.72, 0, 1)"}
				data-testid="swipe-drawer-backdrop"
				onclick={onBackdropClick}
			></div>
		{/if}

		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="absolute inset-y-0 flex flex-col overflow-y-auto bg-[var(--color-surface)] {side === 'left' ? 'left-0' : 'right-0'} {width} {maxWidth} {extraClass}"
			style:transform={panelTransform()}
			style:will-change="transform"
			style:transition={dragging ? "none" : "transform 300ms cubic-bezier(0.32, 0.72, 0, 1)"}
			data-testid="swipe-drawer-panel"
			bind:this={panelEl}
			onclick={onPanelClick}
			ontouchstart={onTouchStart}
			ontouchmove={onTouchMove}
			ontouchend={onTouchEnd}
			ontouchcancel={resetDrag}
		>
			{@render children()}
		</div>
	</div>
{/if}
