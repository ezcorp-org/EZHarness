/**
 * Reactive stand-in for the `$lib/stores.svelte.js` singleton, used by the
 * stream-resume component test.
 *
 * Must live in a `.svelte.ts` module: `attachStreamResume`'s WS-reconnect
 * `$effect` reads `store.connected` and only re-fires if that read is
 * TRACKED. A plain object stub silently makes the effect inert — the test
 * would flip `connected` and nothing would happen, which looks like a
 * passing "no reconnect storm" test while actually covering nothing.
 */
export const storeStub = $state({
  connected: false,
  streamingToolCalls: {} as Record<string, unknown[]>,
});

export function resetStoreStub(): void {
  storeStub.connected = false;
  storeStub.streamingToolCalls = {};
}
