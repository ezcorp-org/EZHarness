/**
 * vitest setup for Svelte component DOM tests.
 * - Pulls in @testing-library/jest-dom matchers (toBeInTheDocument, etc.)
 * - Cleans up mounted components between tests so DOM queries don't leak.
 * - Stubs URL.createObjectURL / revokeObjectURL since jsdom's default
 *   implementation throws; the ChatInput thumbnail effect relies on them.
 * - Stubs window.matchMedia (jsdom does NOT ship one by default) so any
 *   component depending on `$lib/use-breakpoint.svelte` can mount without
 *   the test having to mock `matchMedia` itself. The default stub returns
 *   `matches: false` (i.e. desktop viewport) so the picker's `>=lg` branch
 *   is exercised; component tests that need to assert the `<lg` branch
 *   override this stub themselves via Object.defineProperty.
 */

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/svelte";

afterEach(() => cleanup());

if (typeof URL.createObjectURL !== "function" || URL.createObjectURL.toString().includes("not implemented")) {
	let counter = 0;
	URL.createObjectURL = (_blob: Blob) => `blob:mock://${++counter}`;
	URL.revokeObjectURL = () => {};
}

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
	// Minimal jsdom-compatible stub. The breakpoint composable only reads
	// `.matches` once + subscribes via `addEventListener('change', ...)`,
	// so the no-op listener pair is enough to satisfy every consumer that
	// doesn't explicitly assert media-query reactivity.
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		configurable: true,
		value: (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}),
	});
}
