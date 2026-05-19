/**
 * Phase 57 — UX-01 Wave 1 (Plan 57-02 Task 1).
 *
 * Svelte 5 rune composable. Tracks whether the viewport is below a Tailwind
 * breakpoint (`sm`/`md`/`lg`/`xl`). SSR-safe — returns `{ below: false }` when
 * `window` is undefined.
 *
 * Pixel thresholds match Tailwind defaults verbatim — the W0 RED scaffold
 * (`use-breakpoint.unit.test.ts`) asserts the `(max-width: <px-1>px)` query
 * literals so any future breakpoint drift fails loud.
 *
 * The `.svelte.ts` extension is mandatory for files using runes outside a
 * `.svelte` component (per CONVENTIONS.md "File Naming for Rune-based
 * Modules"). Vite + the Svelte plugin transform the rune syntax at import
 * time; bun cannot import this file directly.
 *
 * Only the `below` API is exposed — the 9 pickers all wrap on `<lg`. A
 * `useBreakpointAbove` variant would be YAGNI per CLAUDE.md DRY rule.
 */

const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280 } as const;
export type BreakpointName = keyof typeof BREAKPOINTS;

export function useBreakpoint(name: BreakpointName): { readonly below: boolean } {
	const px = BREAKPOINTS[name];

	// SSR path: window is undefined → frozen `{ below: false }`. The
	// matchMedia branch is skipped entirely so no listeners leak.
	if (typeof window === "undefined") {
		return { get below() { return false; } };
	}

	let below = $state(window.innerWidth < px);
	const mql = window.matchMedia(`(max-width: ${px - 1}px)`);
	const onChange = () => { below = mql.matches; };
	// Use the modern `change` event — `MediaQueryList.addListener` was
	// deprecated in Safari 14+ and Chrome 39+.
	mql.addEventListener("change", onChange);
	// Module-level effect: `$effect.root` lets us register cleanup without
	// being inside a component lifecycle. The returned getter object is
	// returned to the caller IMMEDIATELY; cleanup runs when the root effect
	// is destroyed (process tear-down in practice).
	$effect.root(() => () => mql.removeEventListener("change", onChange));

	return { get below() { return below; } };
}
