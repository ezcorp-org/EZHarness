/**
 * Unit tests for the SSE resume buffer ($lib/server/sse-resume-buffer) — the
 * per-process ring buffer + fan-out that backs Last-Event-ID replay (C3).
 *
 * A fake bus captures the recorder's per-event handlers so a test can "emit"
 * by invoking them directly, exercising record / fan-out / ring-bounding /
 * replay without a live runtime.
 */

import { test, expect, describe, beforeEach } from "vitest";
import {
  addSink,
  replayFrom,
  scopeSeqFor,
  scopeCursorToGlobalId,
  SSE_RING_CAPACITY,
  SSE_MAX_SCOPES,
  __resetSseResumeBufferForTests,
  type BufferedEvent,
} from "$lib/server/sse-resume-buffer";
import { RUNTIME_EVENT_NAMES } from "$lib/runtime-event-names";

function fakeBus() {
  const handlers = new Map<string, (d: unknown) => void>();
  return {
    on(event: string, fn: (d: unknown) => void) {
      handlers.set(event, fn);
      return () => handlers.delete(event);
    },
    emit(event: string, data: unknown) {
      handlers.get(event)?.(data);
    },
    handlers,
  };
}

const SAMPLE = "run:token"; // a real RUNTIME_EVENT_NAME

beforeEach(() => {
  __resetSseResumeBufferForTests();
});

describe("sse-resume-buffer", () => {
  test("subscribes to every runtime event exactly once, regardless of sink count", () => {
    const bus = fakeBus();
    const off1 = addSink(bus, () => {});
    expect(bus.handlers.size).toBe(RUNTIME_EVENT_NAMES.length);
    // A second sink must NOT re-subscribe the bus.
    const off2 = addSink(bus, () => {});
    expect(bus.handlers.size).toBe(RUNTIME_EVENT_NAMES.length);
    off1();
    off2();
  });

  test("stamps monotonically increasing ids and fans out to live sinks", () => {
    const bus = fakeBus();
    const seen: BufferedEvent[] = [];
    addSink(bus, (e) => seen.push(e));
    bus.emit(SAMPLE, { a: 1 });
    bus.emit(SAMPLE, { a: 2 });
    expect(seen).toEqual([
      { id: 1, event: SAMPLE, data: { a: 1 } },
      { id: 2, event: SAMPLE, data: { a: 2 } },
    ]);
  });

  test("an unregistered sink stops receiving events (but the buffer keeps filling)", () => {
    const bus = fakeBus();
    const seen: number[] = [];
    const off = addSink(bus, (e) => seen.push(e.id));
    bus.emit(SAMPLE, { a: 1 });
    off();
    bus.emit(SAMPLE, { a: 2 });
    expect(seen).toEqual([1]);
    // The second event was still recorded even with no live sink.
    expect(replayFrom(0).map((e) => e.id)).toEqual([1, 2]);
  });

  test("replayFrom returns only events strictly after the cursor", () => {
    const bus = fakeBus();
    addSink(bus, () => {});
    bus.emit(SAMPLE, { a: 1 });
    bus.emit(SAMPLE, { a: 2 });
    bus.emit(SAMPLE, { a: 3 });
    expect(replayFrom(1).map((e) => e.id)).toEqual([2, 3]);
    expect(replayFrom(0).map((e) => e.id)).toEqual([1, 2, 3]);
    expect(replayFrom(3)).toEqual([]);
  });

  test("bounds the ring at capacity, evicting the oldest entries", () => {
    const bus = fakeBus();
    addSink(bus, () => {});
    const total = SSE_RING_CAPACITY + 5;
    for (let i = 0; i < total; i++) bus.emit(SAMPLE, { i });
    const all = replayFrom(0);
    expect(all).toHaveLength(SSE_RING_CAPACITY);
    // ids 1..5 were evicted; the retained tail starts at id 6.
    expect(all[0]!.id).toBe(6);
    expect(all[all.length - 1]!.id).toBe(total);
  });

  test("a throwing sink never breaks fan-out to healthy sinks", () => {
    const bus = fakeBus();
    const seen: number[] = [];
    addSink(bus, () => {
      throw new Error("closed controller");
    });
    addSink(bus, (e) => seen.push(e.id));
    bus.emit(SAMPLE, {});
    expect(seen).toEqual([1]);
  });

  test("reset clears the ring, id counter, sinks and bus subscription", () => {
    const bus = fakeBus();
    const seen: number[] = [];
    addSink(bus, (e) => seen.push(e.id));
    bus.emit(SAMPLE, {});
    __resetSseResumeBufferForTests();
    // Bus was unsubscribed → this handler no longer fires.
    bus.emit(SAMPLE, {});
    expect(seen).toEqual([1]);
    expect(replayFrom(0)).toEqual([]);
    // A fresh subscription restarts the id sequence at 1.
    const bus2 = fakeBus();
    addSink(bus2, (e) => seen.push(e.id));
    bus2.emit(SAMPLE, {});
    expect(seen).toEqual([1, 1]);
  });
});

// Per-scope dense numbering (side-channel fix): the exposed `id:` is a dense
// per-scope sequence, NEVER the global ring id, so its gaps can't leak how many
// events other scopes saw.
describe("sse-resume-buffer — per-scope numbering", () => {
  test("assigns a DENSE per-scope sequence, memoised per (scope, global id)", () => {
    // Scope A sees global ids 1 and 3 (global 2 went to another scope and was
    // filtered out for A). A's exposed ids stay DENSE (1, 2) — the skipped
    // global 2 never bumps A's counter, so nothing about it leaks.
    expect(scopeSeqFor("A", 1)).toBe(1);
    expect(scopeSeqFor("A", 3)).toBe(2);
    // Memoised: re-asking for the same global id returns the SAME seq (so
    // replay re-issues the id the client already saw).
    expect(scopeSeqFor("A", 1)).toBe(1);
    expect(scopeSeqFor("A", 3)).toBe(2);
    // A different scope keeps its OWN independent dense sequence.
    expect(scopeSeqFor("B", 2)).toBe(1);
    expect(scopeSeqFor("B", 5)).toBe(2);
  });

  test("scopeCursorToGlobalId translates a known cursor and is 0 for unknown", () => {
    expect(scopeSeqFor("A", 10)).toBe(1);
    expect(scopeSeqFor("A", 20)).toBe(2);
    // A seq → the global id it was assigned (resume resumes AFTER this).
    expect(scopeCursorToGlobalId("A", 1)).toBe(10);
    expect(scopeCursorToGlobalId("A", 2)).toBe(20);
    // A never-issued seq, and a never-seen scope, both resolve to 0 → the
    // caller replays whatever tail the ring still holds.
    expect(scopeCursorToGlobalId("A", 99)).toBe(0);
    expect(scopeCursorToGlobalId("no-such-scope", 1)).toBe(0);
  });

  test("prunes a scope's seq mapping when its global id is evicted from the ring", () => {
    const bus = fakeBus();
    addSink(bus, () => {});
    bus.emit(SAMPLE, {}); // global id 1
    expect(scopeSeqFor("A", 1)).toBe(1);
    expect(scopeCursorToGlobalId("A", 1)).toBe(1);
    // Push exactly SSE_RING_CAPACITY more events → global id 1 is evicted.
    for (let i = 0; i < SSE_RING_CAPACITY; i++) bus.emit(SAMPLE, {});
    // Its per-scope mapping was pruned → the cursor now resolves to 0 (tail).
    expect(scopeCursorToGlobalId("A", 1)).toBe(0);
  });

  test("caps the scope table, evicting the least-recently-used scope", () => {
    // Create one more scope than the cap; the FIRST (never re-touched) is LRU
    // and gets evicted, while the newest is retained.
    for (let i = 0; i <= SSE_MAX_SCOPES; i++) scopeSeqFor(`s${i}`, 1);
    expect(scopeCursorToGlobalId("s0", 1)).toBe(0); // evicted
    expect(scopeCursorToGlobalId(`s${SSE_MAX_SCOPES}`, 1)).toBe(1); // retained
  });

  test("reset also clears the per-scope numbering", () => {
    expect(scopeSeqFor("A", 7)).toBe(1);
    __resetSseResumeBufferForTests();
    // Fresh scope table → the sequence restarts and the old cursor is gone.
    expect(scopeCursorToGlobalId("A", 1)).toBe(0);
    expect(scopeSeqFor("A", 7)).toBe(1);
  });
});
