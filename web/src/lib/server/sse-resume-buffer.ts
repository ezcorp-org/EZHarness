/**
 * Per-process SSE resume buffer (durability, C3).
 *
 * The runtime-events SSE endpoint fans one bus out to many subscribers. A
 * client that briefly disconnects (tab sleep, flaky network) loses every
 * event fired during the gap. This module records events into a bounded
 * per-process ring buffer with a monotonic id so a reconnecting client can
 * replay what it missed via `Last-Event-ID`.
 *
 * The buffer records events PRE-filter and globally (one id sequence shared
 * across all subscribers) — a cursor means the same thing regardless of which
 * connection produced it. Per-subscriber authorization is NOT applied here;
 * the SSE route re-runs the exact `shouldDeliverEvent` filter over both live
 * and replayed events, so scoping semantics are identical on both paths.
 *
 * A single lazy bus subscription (created on the first `addSink`) keeps the
 * buffer filling even while NO client is connected — that gap is precisely
 * when resume matters. Live delivery is a fan-out to registered sinks; replay
 * reads the ring directly. Ids assigned by `record` are strictly increasing,
 * so a freshly-registered sink (future ids) never overlaps a replay slice
 * (past ids) — no gaps, no duplicates.
 *
 * Replay is best-effort: if the client was gone long enough that its cursor
 * fell off the {@link SSE_RING_CAPACITY}-entry tail, it simply receives the
 * buffered tail and refetches the rest of its state (the pre-C3 behavior).
 */

import { RUNTIME_EVENT_NAMES } from "$lib/runtime-event-names";

export interface BufferedEvent {
  id: number;
  event: string;
  data: unknown;
}

export type BufferedSink = (e: BufferedEvent) => void;

/** The minimal event-bus surface this module needs. */
interface BusLike {
  on(event: string, fn: (data: unknown) => void): () => void;
}

/** Ring-buffer capacity (events retained for replay). Bounded so a long-lived
 *  process can't grow the buffer without limit. */
export const SSE_RING_CAPACITY = 500;

let ring: BufferedEvent[] = [];
let nextId = 0;
const sinks = new Set<BufferedSink>();
let unsubs: Array<() => void> = [];
let subscribed = false;

/** Record one bus event: stamp it with the next id, retain it in the ring
 *  (evicting the oldest past capacity), and fan it out to every live sink. */
function record(event: string, data: unknown): void {
  const buffered: BufferedEvent = { id: ++nextId, event, data };
  ring.push(buffered);
  if (ring.length > SSE_RING_CAPACITY) ring.shift();
  for (const sink of sinks) {
    try {
      sink(buffered);
    } catch {
      // A sink backed by a closed stream controller must not break fan-out
      // to the other subscribers.
    }
  }
}

/** Subscribe the recorder to the bus exactly once per process. Kept lazy so
 *  it never runs at module import (the bus isn't wired then) and survives
 *  across connect/disconnect cycles. */
function ensureSubscribed(bus: BusLike): void {
  if (subscribed) return;
  subscribed = true;
  for (const event of RUNTIME_EVENT_NAMES) {
    unsubs.push(bus.on(event, (data) => record(event, data)));
  }
}

/**
 * Register a live sink for buffered events and ensure the process-wide bus
 * subscription exists. Returns an unregister function (call it when the SSE
 * connection closes).
 */
export function addSink(bus: BusLike, sink: BufferedSink): () => void {
  ensureSubscribed(bus);
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/** Buffered events with an id strictly greater than `cursor`, in order. */
export function replayFrom(cursor: number): BufferedEvent[] {
  return ring.filter((e) => e.id > cursor);
}

/** Test-only: drop the bus subscription, the ring, the id counter and every
 *  sink so each test starts from a clean recorder. */
export function __resetSseResumeBufferForTests(): void {
  for (const u of unsubs) {
    try {
      u();
    } catch {
      // ignore
    }
  }
  unsubs = [];
  ring = [];
  nextId = 0;
  sinks.clear();
  subscribed = false;
}
