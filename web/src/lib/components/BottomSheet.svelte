<!--
  Phase 57 — UX-01 Wave 1 (Plan 57-02 Task 2).

  Shared bottom-sheet primitive used by the 9 mobile picker wraps. Renders
  panel only while open=true (mount-on-open + 300ms delayed unmount) so the
  CSS exit animation runs. Mirrors SwipeDrawer.svelte's lifecycle pattern —
  but DOES NOT extend SwipeDrawer (Pitfall 6 — its drag math is left/right
  only; vertical-drag direction math does not generalize).

  Contract pinned by W0 RED scaffold at
  `src/lib/components/__tests__/BottomSheet.component.test.ts`:
    - `role="dialog"` + `aria-modal="true"` + `data-testid="bottom-sheet"`
    - × button with `aria-label="Close"` and min 44x44 touch target
      (WCAG 2.5.5)
    - Escape key calls onclose (window-level listener active while entering)
    - Backdrop click (the .bg-black/50 element) calls onclose
    - `env(safe-area-inset-bottom)` inline style on the inner panel (iOS
      home-indicator clearance; precedent at
      `web/src/routes/(app)/+layout.svelte:230`)
    - Focus trap via `createFocusTrap(overlayEl)` from $lib/focus-trap;
      cleanup on unmount.
    - Children rendered via `{@render children()}` (Svelte 5 snippet).

  WCAG 2.5.1 single-pointer-equivalent is satisfied by the × button — NOT
  drag-to-dismiss. The CSS-only impl was chosen over `@abhivarde/svelte-drawer`
  for Wave 1 because the W0 test contract is simpler to satisfy verbatim
  here; the dep was installed in Task 1 to keep the swap-in option open
  for follow-up if gesture polish is needed.
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import { createFocusTrap } from "$lib/focus-trap";

	let {
		open,
		onclose,
		ariaLabel = "",
		children,
	}: {
		open: boolean;
		onclose: () => void;
		ariaLabel?: string;
		children: Snippet;
	} = $props();

	let visible = $state(false);
	let entering = $state(false);
	let overlayEl = $state<HTMLElement | null>(null);
	let panelEl = $state<HTMLElement | null>(null);

	// `env(safe-area-inset-bottom, 0px)` MUST be set via setAttribute — going
	// through `element.style.cssText = ...` (which Svelte's interpolated
	// `style="..."` attribute uses) round-trips through CSSStyleDeclaration
	// and gets silently dropped by jsdom + older parsers that don't recognize
	// the env() function. The setAttribute path preserves the raw string,
	// honoring iOS Safari's home-indicator clearance contract (W0 test 6).
	$effect(() => {
		if (!panelEl) return;
		const transform = entering ? "translateY(0)" : "translateY(100%)";
		panelEl.setAttribute(
			"style",
			`transform: ${transform}; padding-bottom: env(safe-area-inset-bottom, 0px);`,
		);
	});

	// Mount-on-open + delayed unmount (300ms) preserves CSS exit animation.
	// Mirrors SwipeDrawer.svelte:75-90 lifecycle.
	$effect(() => {
		if (open) {
			visible = true;
			requestAnimationFrame(() => {
				entering = true;
			});
		} else if (visible) {
			entering = false;
			const t = setTimeout(() => {
				visible = false;
			}, 300);
			return () => clearTimeout(t);
		}
	});

	// Window-level Escape listener — attach as soon as the sheet is mounted
	// (visible=true), not gated on `entering`. The W0 test fires keydown
	// synchronously after render, BEFORE the next requestAnimationFrame
	// flips `entering` to true; gating on `entering` would race with the
	// test (and with real users who hit ESC during the entry animation).
	// e.stopPropagation prevents an outer ESC handler (parent picker, drawer
	// stack) from double-firing.
	$effect(() => {
		if (!visible) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onclose();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	// Focus trap — installed on the overlay once it's mounted. Cleanup
	// restores focus to the previously-focused element on unmount.
	$effect(() => {
		if (visible && overlayEl) {
			const cleanup = createFocusTrap(overlayEl);
			return () => cleanup();
		}
	});
</script>

{#if visible}
	<div
		class="fixed inset-0 z-50"
		role="dialog"
		aria-modal="true"
		aria-label={ariaLabel}
		data-testid="bottom-sheet"
		bind:this={overlayEl}
	>
		<button
			type="button"
			class="absolute inset-0 bg-black/50 transition-opacity duration-300"
			style:opacity={entering ? 1 : 0}
			aria-label="Close picker"
			onclick={onclose}
		></button>
		<div
			class="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl bg-[var(--color-surface)] transition-transform duration-300"
			data-testid="bottom-sheet-panel"
			bind:this={panelEl}
		>
			<div
				class="sticky top-0 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2"
			>
				<span class="text-sm font-medium">{ariaLabel}</span>
				<button
					type="button"
					onclick={onclose}
					aria-label="Close"
					class="rounded p-1 hover:bg-[var(--color-surface-tertiary)]"
					style="min-width: 44px; min-height: 44px;"
				>×</button>
			</div>
			{@render children()}
		</div>
	</div>
{/if}
