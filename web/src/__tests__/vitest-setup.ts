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
 * - Stubs Element.prototype.animate (jsdom doesn't implement the Web
 *   Animations API) so any component using a Svelte `transition:*` — which
 *   calls element.animate() on intro/outro — can mount and unmount without
 *   throwing. Shared here so transition-using components (Toast,
 *   UpdateBanner, …) don't each re-stub it.
 */

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/svelte";

afterEach(() => cleanup());

if (typeof Element !== "undefined" && typeof Element.prototype.animate !== "function") {
  // Minimal no-op Animation-like object — Svelte only needs the lifecycle
  // methods + the `finished` promise to drive transition completion.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).animate = () => ({
    cancel() {},
    finish() {},
    pause() {},
    play() {},
    reverse() {},
    addEventListener() {},
    removeEventListener() {},
    finished: Promise.resolve(),
  });
}

if (
  typeof URL.createObjectURL !== "function" ||
  URL.createObjectURL.toString().includes("not implemented")
) {
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
