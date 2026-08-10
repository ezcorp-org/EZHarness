/**
 * Reactive stand-in for the two counters `attachTaskHydration` watches.
 *
 * Must live in a `.svelte.ts` module: the hydration `$effect` re-fires only
 * on a TRACKED read. A plain object stub would silently make the reconnect
 * and resync paths inert — the test would bump a counter, nothing would
 * happen, and it would look like a passing "no refetch storm" assertion
 * while covering nothing. Same trap as `store-stub.svelte.ts`.
 */
export const hydrationStub = $state({
  /** Mirrors `store.wsReconnectCount`. */
  reconnects: 0,
  /** Mirrors `store.taskHydrationRequests`. */
  requests: 0,
});

export function resetHydrationStub(): void {
  hydrationStub.reconnects = 0;
  hydrationStub.requests = 0;
}
