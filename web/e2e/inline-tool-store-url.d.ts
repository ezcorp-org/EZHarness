/**
 * Vite serves this test-only browser import through its `/src/` URL. The
 * TypeScript program resolves source through `$lib`, so bridge the URL to the
 * same singleton without changing the runtime import used by Playwright.
 */
declare module "/src/lib/inline-tool-store.svelte.js" {
	export const inlineToolStore: typeof import("$lib/inline-tool-store.svelte").inlineToolStore;
}
