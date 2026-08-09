/**
 * Task-panel cold-start hydration — rune half.
 *
 * Decides WHEN to reload the persisted task snapshot; the fetch itself lives
 * in `./task-hydrate.ts` (split so the transport logic is reachable from
 * `bun test`, which can't execute `$state`).
 *
 * Three triggers:
 *   1. conversation change — covers first mount, refresh, new tab, switching
 *   2. SSE reconnect (`store.wsReconnectCount`) — resyncs events missed in
 *      the gap, which were previously lost for good
 *   3. a store-side request (`store.taskHydrationRequests`) — raised when an
 *      assignment delta arrives for a conversation with no loaded snapshot
 *
 * Ordering is guarded twice, because there are two different ways a slow
 * fetch can be wrong by the time it lands:
 *   - a `generation` counter drops responses for a conversation the user has
 *     already navigated away from (would show one chat's tasks under another)
 *   - the reducer drops responses that a live bus event overtook (would roll
 *     the panel back to older state)
 */

import { untrack } from "svelte";
import {
  getTaskSeq,
  getWsReconnectCount,
  hydrateTaskSnapshotInto,
  taskHydrationRequests,
} from "$lib/stores.svelte.js";
import { hydrateTaskSnapshot, type TaskHydrationHost } from "./task-hydrate.js";

export type { TaskHydrationHost, TaskSnapshotResponse } from "./task-hydrate.js";

/**
 * Attach the hydration effect. MUST be called inside a rune scope.
 *
 * `convId` is the only required slot; everything else defaults to the app
 * store. The remaining slots exist so a component test can drive it without
 * a live store.
 */
export function attachTaskHydration(
  host: Pick<TaskHydrationHost, "convId"> & Partial<TaskHydrationHost>,
): void {
  // Incremented per scheduled hydrate; a response is applied only while it
  // is still the latest one. Plain closure state — a guard, not something
  // the UI renders.
  let generation = 0;

  const resolved: TaskHydrationHost = {
    convId: host.convId,
    reconnectCount: host.reconnectCount ?? getWsReconnectCount,
    requestCount: host.requestCount ?? taskHydrationRequests,
    apply: host.apply ?? hydrateTaskSnapshotInto,
    seqFor: host.seqFor ?? getTaskSeq,
    ...(host.fetchImpl !== undefined ? { fetchImpl: host.fetchImpl } : {}),
  };

  $effect(() => {
    const cid = resolved.convId();
    // Read (and therefore track) the two resync signals.
    resolved.reconnectCount();
    resolved.requestCount();
    if (!cid) return;

    const mine = ++generation;
    // `untrack` is load-bearing: `hydrateTaskSnapshot` reads the store's
    // live-event counter synchronously, before its fetch, and then writes
    // the snapshot it fetched. Without this the effect would depend on the
    // very state it updates and re-fire forever.
    untrack(() => {
      void hydrateTaskSnapshot(
        resolved,
        cid,
        () => generation === mine && untrack(() => resolved.convId()) === cid,
      );
    });
  });
}
