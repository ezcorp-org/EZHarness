/**
 * Phase 57 — UX-01 Wave 0 RED scaffold.
 *
 * Pins the `useBreakpoint(name)` rune contract before Wave 1 (Plan 57-02
 * Task 1) lands `web/src/lib/use-breakpoint.svelte.ts`. The four cases
 * cover the SSR-safe branch, two reactive matchMedia branches at the
 * `lg` (1024px) threshold called out in CONTEXT.md, and the Tailwind-
 * default pixel thresholds (sm/md/xl) so any future breakpoint constant
 * drift fails loud.
 *
 * Runner: vitest (jsdom) — matches every other *.unit.test.ts. NEVER
 * bun:test for files under web/.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { useBreakpoint } from "$lib/use-breakpoint.svelte";

// Capture the original matchMedia and window so each test can restore
// state cleanly. jsdom 29 ships a no-op matchMedia by default; spying
// keeps the contract assertions independent of jsdom internals.
const originalMatchMedia = globalThis.window?.matchMedia;
const originalInnerWidth = globalThis.window?.innerWidth;

afterEach(() => {
	if (originalMatchMedia) {
		Object.defineProperty(window, "matchMedia", {
			value: originalMatchMedia,
			configurable: true,
			writable: true,
		});
	}
	if (typeof originalInnerWidth === "number") {
		Object.defineProperty(window, "innerWidth", {
			value: originalInnerWidth,
			configurable: true,
			writable: true,
		});
	}
});

describe("useBreakpoint", () => {
	test("returns { below: false } when window is undefined (SSR)", () => {
		const w = globalThis.window;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		delete (globalThis as any).window;
		try {
			const bp = useBreakpoint("lg");
			expect(bp.below).toBe(false);
		} finally {
			(globalThis as { window?: Window }).window = w;
		}
	});

	test("returns { below: true } when innerWidth < 1024", () => {
		Object.defineProperty(window, "innerWidth", {
			value: 800,
			configurable: true,
			writable: true,
		});
		const mql = {
			matches: true,
			media: "(max-width: 1023px)",
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
			onchange: null,
		};
		Object.defineProperty(window, "matchMedia", {
			value: vi.fn().mockReturnValue(mql),
			configurable: true,
			writable: true,
		});
		const bp = useBreakpoint("lg");
		expect(bp.below).toBe(true);
	});

	test("returns { below: false } when innerWidth >= 1024", () => {
		Object.defineProperty(window, "innerWidth", {
			value: 1280,
			configurable: true,
			writable: true,
		});
		const mql = {
			matches: false,
			media: "(max-width: 1023px)",
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
			onchange: null,
		};
		Object.defineProperty(window, "matchMedia", {
			value: vi.fn().mockReturnValue(mql),
			configurable: true,
			writable: true,
		});
		const bp = useBreakpoint("lg");
		expect(bp.below).toBe(false);
	});

	test("sm/md/xl pixel thresholds match Tailwind defaults", () => {
		const mqlFactory = () => ({
			matches: false,
			media: "",
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
			onchange: null,
		});
		const mm = vi.fn().mockImplementation(mqlFactory);
		Object.defineProperty(window, "matchMedia", {
			value: mm,
			configurable: true,
			writable: true,
		});
		// Construction triggers a matchMedia() call per breakpoint name.
		useBreakpoint("sm");
		useBreakpoint("md");
		useBreakpoint("xl");
		// Tailwind defaults: sm=640px, md=768px, xl=1280px.
		// useBreakpoint queries `(max-width: <px-1>px)` so "below" maps
		// to "viewport narrower than breakpoint".
		const queries = mm.mock.calls.map((c) => c[0]);
		expect(queries).toContain("(max-width: 639px)");
		expect(queries).toContain("(max-width: 767px)");
		expect(queries).toContain("(max-width: 1279px)");
	});
});
