/**
 * Per-process SSE resume buffer (durability, C3).
 *
 * The runtime-events SSE endpoint fans one bus out to many subscribers. A
 * client that briefly disconnects (tab sleep, flaky network) loses every
 * event fired during the gap. This module records events into a bounded
 * per-process ring buffer with a monotonic id so a reconnecting client can
 * replay what it missed via `Last-Event-ID`.
 *
 * The buffer records events PRE-filter and globally (one internal id sequence
 * shared across all subscribers) — that global id is the ring's storage,
 * eviction and replay key. Per-subscriber authorization is NOT applied here;
 * the SSE route re-runs the exact `shouldDeliverEvent` filter over both live
 * and replayed events, so scoping semantics are identical on both paths.
 *
 * ── Per-scope `id:` numbering (side-channel fix) ─────────────────────────
 * The global ring id is NEVER exposed to a client: it advances for EVERY
 * user's events, so the gaps between a subscriber's consecutive ids would leak
 * how much activity OTHER users generate (an INFO cross-user volume
 * side-channel). Instead each subscriber sees a DENSE per-scope sequence
 * (1,2,3…) covering only the events delivered to IT — `scopeSeqFor` assigns
 * these post-filter and MEMOISES them per (scope, global id) so replay returns
 * the same id and the sequence stays monotonic per scope. Resume still works
 * because the scope key is stable across the fresh-EventSource reconnect: the
 * client's per-scope cursor translates back to a ring position via
 * `scopeCursorToGlobalId`, and replay resumes precisely from there. The per-
 * scope maps are pruned on ring eviction and the scope table is LRU-capped, so
 * the whole structure stays bounded.
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

// ── Per-scope dense numbering (side-channel fix) ─────────────────────────

/** Bidirectional per-scope seq map. `byGlobal` memoises the dense seq assigned
 *  to a global ring id (so replay re-issues the same id); `bySeq` is its
 *  inverse for translating a reconnecting client's cursor back to a ring
 *  position. `nextSeq` only ever increases → monotonic per scope. */
interface ScopeSeq {
  nextSeq: number;
  byGlobal: Map<number, number>;
  bySeq: Map<number, number>;
}

/** Insertion-ordered so the first key is the least-recently-used scope. */
let scopes = new Map<string, ScopeSeq>();

/** Cap on distinct scopes retained. Bounds memory on a long-lived process with
 *  churning users; evicting a scope only costs a reconnecting client a
 *  replay-the-tail (best-effort), never correctness. */
export const SSE_MAX_SCOPES = 4096;

function touchScope(scopeKey: string): ScopeSeq {
  const existing = scopes.get(scopeKey);
  if (existing) {
    // Move to the end of the iteration order (most-recently-used).
    scopes.delete(scopeKey);
    scopes.set(scopeKey, existing);
    return existing;
  }
  const fresh: ScopeSeq = { nextSeq: 0, byGlobal: new Map(), bySeq: new Map() };
  scopes.set(scopeKey, fresh);
  // Evict least-recently-used scopes past the cap (the first inserted key).
  while (scopes.size > SSE_MAX_SCOPES) {
    const oldest = scopes.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    scopes.delete(oldest);
  }
  return fresh;
}

/**
 * Dense per-scope sequence number for a delivered event, memoised so replay
 * returns the SAME id it first assigned. Call ONLY for events actually
 * delivered to the scope (post-filter), so the sequence stays gap-free and
 * never reveals how many events OTHER scopes saw.
 */
export function scopeSeqFor(scopeKey: string, globalId: number): number {
  const scope = touchScope(scopeKey);
  const memoised = scope.byGlobal.get(globalId);
  if (memoised !== undefined) return memoised;
  const seq = ++scope.nextSeq;
  scope.byGlobal.set(globalId, seq);
  scope.bySeq.set(seq, globalId);
  return seq;
}

/**
 * Translate a reconnecting client's per-scope cursor back to the ring's global
 * id to resume AFTER. An unknown cursor (never issued, or its event already
 * evicted) → 0, i.e. replay whatever tail the ring still holds — the same
 * best-effort a cursor that fell off the ring already gets.
 */
export function scopeCursorToGlobalId(scopeKey: string, cursorSeq: number): number {
  const scope = scopes.get(scopeKey);
  if (!scope) return 0;
  return scope.bySeq.get(cursorSeq) ?? 0;
}

/** Drop an evicted global id from every scope's maps so they stay bounded to
 *  the ring's contents. A cursor referencing a pruned seq then resolves to 0
 *  (replay-the-tail) via `scopeCursorToGlobalId`. */
function pruneScopes(globalId: number): void {
  for (const scope of scopes.values()) {
    const seq = scope.byGlobal.get(globalId);
    if (seq !== undefined) {
      scope.byGlobal.delete(globalId);
      scope.bySeq.delete(seq);
    }
  }
}

/** Record one bus event: stamp it with the next id, retain it in the ring
 *  (evicting the oldest past capacity), and fan it out to every live sink. */
function record(event: string, data: unknown): void {
  const buffered: BufferedEvent = { id: ++nextId, event, data };
  ring.push(buffered);
  if (ring.length > SSE_RING_CAPACITY) {
    const evicted = ring.shift();
    if (evicted) pruneScopes(evicted.id);
  }
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
  scopes = new Map();
  subscribed = false;
}
