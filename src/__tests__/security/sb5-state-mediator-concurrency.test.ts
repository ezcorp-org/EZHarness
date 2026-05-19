// Regression test for sec-SB5: the state-mediator token bucket must not
// double-spend tokens under concurrent load, must keep per-extension
// buckets isolated, and must tolerate backwards clock jumps.
//
// Pre-fix (`src/extensions/state-mediator.ts` @ c313cdd): the refill +
// consume logic mutated the bucket object in place and subtracted
// `elapsed * rate` without a monotonic clamp. Safe under current usage
// because `consumeToken` is synchronous, but the invariant was implicit
// and a single backwards `Date.now()` jump (NTP skew / manual clock
// adjustment) would compute a negative elapsed, corrupting the bucket
// into negative-token state that never recovers.
//
// Fix (1f825d5): adds a per-extension reentrancy guard (`consumingLocks`),
// replaces in-place bucket mutation with full `Map.set(obj)` replacement,
// clamps elapsed via `Math.max(0, …)`, and always commits the updated
// `lastRefill` even on deny so deny→allow transitions get a correct
// elapsed window.
//
// Strategy: drive the public `handleNotification` API (which calls
// `consumeToken` through the rate-limit gate) and observe bucket state
// via the `ext:state` bus emissions. For clock-skew, spy on `Date.now`
// and read the private `buckets` map via a narrow cast — the alternative
// (observe behavior indirectly through refill) is flakier.
//
// Tests fix(sec-SB5): 1f825d5

import { test, expect, describe, spyOn } from "bun:test";
import { EventBus } from "../../runtime/events";
import type { AgentEvents } from "../../types";
import type { JsonRpcNotification } from "../../extensions/types";
import {
  ExtensionStateMediator,
  MAX_UPDATES_PER_SECOND,
  type MediatorManifest,
} from "../../extensions/state-mediator";

// ── Helpers ─────────────────────────────────────────────────────────

const MANIFEST: MediatorManifest = {
  name: "test-ext",
  panel: { stateSchema: {} },
};

function makeNotification(params: Record<string, unknown>): JsonRpcNotification {
  return { jsonrpc: "2.0", method: "ezcorp/state", params };
}

function setup() {
  const bus = new EventBus<AgentEvents>();
  const mediator = new ExtensionStateMediator(bus, () => MANIFEST);
  const events: AgentEvents["ext:state"][] = [];
  bus.on("ext:state", (e) => events.push(e));
  return { bus, mediator, events };
}

/**
 * Narrow cast to read the private bucket Map without touching the class
 * surface. The white-box access is intentional — the clock-skew regression
 * is most cleanly observed as bucket state corruption, and there is no
 * public accessor for that state.
 */
interface BucketSnapshot {
  tokens: number;
  lastRefill: number;
}
function peekBucket(
  mediator: ExtensionStateMediator,
  extensionId: string,
): BucketSnapshot | undefined {
  return (mediator as unknown as { buckets: Map<string, BucketSnapshot> })
    .buckets.get(extensionId);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("sec-SB5: concurrent same-extension consumption respects capacity", () => {
  test("Promise.all of 200 calls never consumes more than capacity + elapsed refill", async () => {
    // JS is single-threaded, but Promise.all(fn()) forces each sync body
    // to run in its own microtask turn — that's the exact interleaving a
    // future `await`-inside-consumeToken refactor would produce. The test
    // pins that no matter how many microtask-interleaved calls arrive,
    // the total successful consumes stay bounded by
    //     capacity (C) + refill_rate (R) * elapsed_seconds
    // which is the token-bucket invariant.
    const { mediator, events } = setup();

    const start = Date.now();
    const N = 200;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() =>
          mediator.handleNotification("ext-burst", makeNotification({ i })),
        ),
      ),
    );
    const elapsedMs = Date.now() - start;

    const C = MAX_UPDATES_PER_SECOND; // capacity = 10
    const R = MAX_UPDATES_PER_SECOND; // refill  = 10 tokens/sec
    // Upper bound from the token-bucket formula. +1 absorbs the edge
    // case where the very last call lands exactly one refill tick late.
    const maxAllowed = Math.ceil(C + (R * elapsedMs) / 1000) + 1;

    expect(events.length).toBeLessThanOrEqual(maxAllowed);
    // And we must consume at least a full bucket's worth — otherwise
    // the lock is over-zealous and blocks legitimate traffic.
    expect(events.length).toBeGreaterThanOrEqual(C);
  });

  test("tight synchronous loop never exceeds bucket capacity (no refill window)", async () => {
    // With no intervening microtask yields and identical Date.now()
    // within the same ms tick, the only tokens available are the initial
    // bucket capacity. Exactly C events should be emitted for a burst of
    // 50 — anything more is a double-spend.
    const { mediator, events } = setup();

    // Pin Date.now so there's zero refill window during the loop.
    const t0 = 1_700_000_000_000;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => t0);
    try {
      for (let i = 0; i < 50; i++) {
        mediator.handleNotification("ext-tight", makeNotification({ i }));
      }
    } finally {
      nowSpy.mockRestore();
    }

    expect(events).toHaveLength(MAX_UPDATES_PER_SECOND);
  });
});

describe("sec-SB5: different-extension bucket isolation", () => {
  test("exhausting ext-A's bucket leaves ext-B's bucket full", async () => {
    const { mediator, events } = setup();

    // Exhaust ext-A with a burst larger than capacity.
    for (let i = 0; i < MAX_UPDATES_PER_SECOND * 3; i++) {
      mediator.handleNotification("ext-A", makeNotification({ i }));
    }
    const aEmitted = events.filter((e) => e.extensionId === "ext-A").length;
    expect(aEmitted).toBe(MAX_UPDATES_PER_SECOND);

    // ext-B should be untouched — a full bucket's worth must go through.
    for (let i = 0; i < MAX_UPDATES_PER_SECOND; i++) {
      mediator.handleNotification("ext-B", makeNotification({ i }));
    }
    const bEmitted = events.filter((e) => e.extensionId === "ext-B").length;
    expect(bEmitted).toBe(MAX_UPDATES_PER_SECOND);
  });

  test("concurrent interleaved calls for A and B do not starve each other", async () => {
    // Fire 100 calls for each extension, interleaved via Promise.all. Both
    // buckets should reach capacity — bucket state is per-extension, so
    // there is no shared denominator that contention could drain.
    const { mediator, events } = setup();

    const calls: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      calls.push(
        Promise.resolve().then(() =>
          mediator.handleNotification("ext-X", makeNotification({ i })),
        ),
      );
      calls.push(
        Promise.resolve().then(() =>
          mediator.handleNotification("ext-Y", makeNotification({ i })),
        ),
      );
    }
    await Promise.all(calls);

    const xCount = events.filter((e) => e.extensionId === "ext-X").length;
    const yCount = events.filter((e) => e.extensionId === "ext-Y").length;
    // Each bucket independently allows at least its full capacity.
    expect(xCount).toBeGreaterThanOrEqual(MAX_UPDATES_PER_SECOND);
    expect(yCount).toBeGreaterThanOrEqual(MAX_UPDATES_PER_SECOND);
  });
});

describe("sec-SB5: backwards clock-skew clamp", () => {
  test("Date.now jumping backwards does not push tokens negative", () => {
    // Pre-fix:
    //     elapsed = (now - lastRefill) / 1000   // negative if clock jumps back
    //     bucket.tokens += elapsed * rate       // subtracts tokens, can go <0
    // leaves the bucket permanently corrupted at negative tokens, so even
    // after real time passes the bucket takes forever to recover.
    //
    // Post-fix: `const elapsed = Math.max(0, (now - lastRefill) / 1000);`
    // clamps the backwards delta to zero, leaving token count untouched.
    const { mediator, events } = setup();

    const t0 = 2_000_000_000_000;
    let fakeNow = t0;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      // Exhaust the initial bucket at t0.
      for (let i = 0; i < MAX_UPDATES_PER_SECOND; i++) {
        mediator.handleNotification("ext-skew", makeNotification({ i }));
      }
      expect(events).toHaveLength(MAX_UPDATES_PER_SECOND);

      const afterExhaust = peekBucket(mediator, "ext-skew");
      expect(afterExhaust).toBeDefined();
      // Tokens should be ~0 after exhaustion (within floating-point dust).
      expect(afterExhaust!.tokens).toBeLessThan(1);
      expect(afterExhaust!.tokens).toBeGreaterThanOrEqual(0);

      // Jump the clock 5 seconds into the past.
      fakeNow = t0 - 5_000;

      // Issue another call — denied, but the bucket MUST NOT be pushed
      // into negative-token state by the backwards elapsed.
      mediator.handleNotification("ext-skew", makeNotification({ afterSkew: true }));

      const afterSkew = peekBucket(mediator, "ext-skew");
      expect(afterSkew).toBeDefined();
      expect(afterSkew!.tokens).toBeGreaterThanOrEqual(0);
      // Events count unchanged — the skewed call was denied as expected.
      expect(events).toHaveLength(MAX_UPDATES_PER_SECOND);

      // Advance clock 1 real second FROM THE ORIGINAL t0 — bucket should
      // refill by a full capacity's worth (10 tokens). Pre-fix, because
      // tokens was driven negative by the skew, this refill would not be
      // enough to satisfy even a single consume. Post-fix, tokens stays
      // at 0 during the skew window and refills correctly.
      fakeNow = t0 + 1_000;
      mediator.handleNotification("ext-skew", makeNotification({ recover: true }));
      // Post-fix: one full refill → at least 1 more event.
      expect(events.length).toBeGreaterThan(MAX_UPDATES_PER_SECOND);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("oscillating clock (forward/back/forward) keeps bucket non-negative", () => {
    // Simulates an NTP adjustment that bounces a few ms forward then back
    // then forward again — each step must leave the bucket state sane.
    const { mediator } = setup();

    let fakeNow = 3_000_000_000_000;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      // Exhaust.
      for (let i = 0; i < MAX_UPDATES_PER_SECOND; i++) {
        mediator.handleNotification("ext-osc", makeNotification({ i }));
      }

      for (const delta of [+50, -200, +10, -500, +1]) {
        fakeNow += delta;
        mediator.handleNotification("ext-osc", makeNotification({ delta }));
        const b = peekBucket(mediator, "ext-osc");
        expect(b!.tokens).toBeGreaterThanOrEqual(0);
        expect(b!.tokens).toBeLessThanOrEqual(MAX_UPDATES_PER_SECOND);
      }
    } finally {
      nowSpy.mockRestore();
    }
  });
});
