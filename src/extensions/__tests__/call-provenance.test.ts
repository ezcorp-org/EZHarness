/**
 * Unit coverage for the per-call reverse-RPC provenance registry.
 *
 * Pure unit — no DB, no subprocess. Exercises the full lifecycle
 * (register → resolve → release), the unknown/empty-token paths, and
 * both defensive backstops (TTL sweep + hard cap).
 */
import { test, expect, describe, beforeEach, afterEach, jest } from "bun:test";
import {
  registerCallProvenance,
  registerFireCallProvenance,
  resolveCallProvenance,
  releaseCallProvenance,
  callProvenanceSize,
  CALL_PROVENANCE_TTL_MS,
  FIRE_TOKEN_TTL_MS,
  FIRE_TOKEN_AUTO_RELEASE_MS,
  _resetCallProvenanceForTests,
  __sweepForTests,
  __setMaxEntriesForTests,
  type CallProvenance,
} from "../call-provenance";

function sample(overrides: Partial<CallProvenance> = {}): CallProvenance {
  return {
    onBehalfOf: "user-1",
    conversationId: "conv-1",
    runId: "run-1",
    parentCallId: "cap-1",
    actorExtensionId: "ext-1",
    kind: "tool",
    ownerless: false,
    ...overrides,
  };
}

beforeEach(() => {
  _resetCallProvenanceForTests();
});

describe("register / resolve / release lifecycle", () => {
  test("register returns a uuid token that resolves to the exact snapshot", () => {
    const prov = sample();
    const id = registerCallProvenance(prov);
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveCallProvenance(id)).toEqual(prov);
    expect(callProvenanceSize()).toBe(1);
  });

  test("each register mints a distinct token", () => {
    const a = registerCallProvenance(sample());
    const b = registerCallProvenance(sample());
    expect(a).not.toBe(b);
    expect(callProvenanceSize()).toBe(2);
  });

  test("release drops the token — subsequent resolve misses", () => {
    const id = registerCallProvenance(sample());
    releaseCallProvenance(id);
    expect(callProvenanceSize()).toBe(0);
    expect(resolveCallProvenance(id)).toBeUndefined();
  });

  test("release is idempotent and safe on empty/undefined", () => {
    const id = registerCallProvenance(sample());
    releaseCallProvenance(id);
    releaseCallProvenance(id); // second release: no throw
    releaseCallProvenance("");
    releaseCallProvenance(undefined);
    releaseCallProvenance(null);
    expect(callProvenanceSize()).toBe(0);
  });

  test("ownerless snapshot round-trips with onBehalfOf null", () => {
    const id = registerCallProvenance(
      sample({ onBehalfOf: null, conversationId: null, kind: "schedule", ownerless: true }),
    );
    const got = resolveCallProvenance(id);
    expect(got?.ownerless).toBe(true);
    expect(got?.onBehalfOf).toBeNull();
    expect(got?.kind).toBe("schedule");
  });
});

describe("resolve — invalid / unknown tokens", () => {
  test("unknown token resolves to undefined", () => {
    expect(resolveCallProvenance("not-a-real-token")).toBeUndefined();
  });

  test("empty / undefined / null token resolves to undefined", () => {
    expect(resolveCallProvenance("")).toBeUndefined();
    expect(resolveCallProvenance(undefined)).toBeUndefined();
    expect(resolveCallProvenance(null)).toBeUndefined();
  });
});

describe("defensive TTL sweep", () => {
  test("sweep evicts entries older than the TTL, keeps fresh ones", () => {
    const stale = registerCallProvenance(sample());
    // Advance the clock past the TTL — the stale entry must be evicted.
    __sweepForTests(Date.now() + CALL_PROVENANCE_TTL_MS + 1);
    expect(resolveCallProvenance(stale)).toBeUndefined();
    expect(callProvenanceSize()).toBe(0);
  });

  test("sweep within TTL is a no-op", () => {
    const id = registerCallProvenance(sample());
    __sweepForTests(Date.now() + 1000);
    expect(resolveCallProvenance(id)).toEqual(sample());
    expect(callProvenanceSize()).toBe(1);
  });

  test("sweep on an empty registry is a no-op", () => {
    __sweepForTests(Date.now() + CALL_PROVENANCE_TTL_MS + 1);
    expect(callProvenanceSize()).toBe(0);
  });
});

describe("defensive hard cap", () => {
  test("registering past the cap evicts the oldest entry", () => {
    __setMaxEntriesForTests(2);
    const first = registerCallProvenance(sample({ actorExtensionId: "first" }));
    const second = registerCallProvenance(sample({ actorExtensionId: "second" }));
    // Third insert is at cap → oldest (first) evicted before insert.
    const third = registerCallProvenance(sample({ actorExtensionId: "third" }));
    expect(resolveCallProvenance(first)).toBeUndefined();
    expect(resolveCallProvenance(second)?.actorExtensionId).toBe("second");
    expect(resolveCallProvenance(third)?.actorExtensionId).toBe("third");
    expect(callProvenanceSize()).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────
// Regression hardening — the property a singleton CANNOT give.
// ───────────────────────────────────────────────────────────────────

describe("concurrency: many interleaved tokens each keep their OWN snapshot", () => {
  test("200 tokens registered/resolved/released in an interleaved order never bleed", () => {
    const N = 200;
    const ids: string[] = [];
    const expected: CallProvenance[] = [];

    // Phase 1 — register all N up front so they coexist in the live set
    // (a singleton `currentUserId` would now hold only the LAST one).
    for (let i = 0; i < N; i++) {
      const prov = sample({
        onBehalfOf: `user-${i}`,
        conversationId: `conv-${i}`,
        runId: `run-${i}`,
        parentCallId: `cap-${i}`,
        actorExtensionId: `ext-${i}`,
      });
      expected.push(prov);
      ids.push(registerCallProvenance(prov));
    }
    expect(callProvenanceSize()).toBe(N);
    // Tokens are distinct.
    expect(new Set(ids).size).toBe(N);

    // Phase 2 — interleave resolve / release across the full set in a
    // deliberately scrambled order (register A,B → resolve A → release A
    // → resolve B …). Every still-live token MUST resolve to ITS OWN
    // snapshot regardless of registration / release ordering.
    const order = Array.from({ length: N }, (_, i) => (i * 73) % N); // coprime → permutation
    const released = new Set<number>();
    for (const i of order) {
      // The token still in the registry resolves to its exact snapshot.
      expect(resolveCallProvenance(ids[i])).toEqual(expected[i]);
      // A sibling that is still live also resolves to its OWN snapshot,
      // proving no cross-talk while many entries coexist.
      const sibling = (i + 1) % N;
      if (!released.has(sibling)) {
        expect(resolveCallProvenance(ids[sibling])?.onBehalfOf).toBe(
          `user-${sibling}`,
        );
      }
      releaseCallProvenance(ids[i]);
      released.add(i);
      // Released token is gone immediately — no lingering snapshot.
      expect(resolveCallProvenance(ids[i])).toBeUndefined();
    }

    expect(callProvenanceSize()).toBe(0);
    // Every token, re-resolved post-sweep, is gone — no leak.
    for (const id of ids) expect(resolveCallProvenance(id)).toBeUndefined();
  });

  test("resolving one token never mutates or leaks into another's snapshot", () => {
    const a = registerCallProvenance(sample({ onBehalfOf: "alice", conversationId: "c-a" }));
    const b = registerCallProvenance(sample({ onBehalfOf: "bob", conversationId: "c-b" }));
    // Interleaved resolves — order must not matter.
    expect(resolveCallProvenance(b)?.onBehalfOf).toBe("bob");
    expect(resolveCallProvenance(a)?.onBehalfOf).toBe("alice");
    expect(resolveCallProvenance(b)?.conversationId).toBe("c-b");
    expect(resolveCallProvenance(a)?.conversationId).toBe("c-a");
    // Mutating a returned snapshot must not corrupt the registry copy
    // for the OTHER token (defensive: callers must not be able to poison
    // a sibling call's provenance).
    const got = resolveCallProvenance(a)!;
    (got as { onBehalfOf: string }).onBehalfOf = "mallory";
    expect(resolveCallProvenance(b)?.onBehalfOf).toBe("bob");
  });

  test("mutating a resolved snapshot does NOT poison the SAME token's later resolves (defensive copy)", () => {
    // D1 hardening: resolve must hand back a copy, never the live
    // registry entry. Without the copy, a handler that mutates the
    // result corrupts the provenance every other in-flight resolver of
    // the SAME token observes.
    const id = registerCallProvenance(sample({ onBehalfOf: "honest-user" }));
    const first = resolveCallProvenance(id)!;
    (first as { onBehalfOf: string }).onBehalfOf = "attacker";
    (first as { conversationId: string | null }).conversationId = "evil-conv";
    const second = resolveCallProvenance(id)!;
    expect(second.onBehalfOf).toBe("honest-user");
    expect(second.conversationId).toBe("conv-1");
    // Distinct object each call — no shared mutable reference escapes.
    expect(second).not.toBe(first);
  });
});

describe("leak safety: hard cap bounds the live set + evicts the OLDEST", () => {
  test("registering N past the cap keeps size bounded and drops the oldest first", () => {
    const CAP = 5;
    __setMaxEntriesForTests(CAP);
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      ids.push(registerCallProvenance(sample({ actorExtensionId: `e-${i}` })));
      // The live set is NEVER allowed to exceed the hard cap, no matter
      // how many leak in (the OOM backstop).
      expect(callProvenanceSize()).toBeLessThanOrEqual(CAP);
    }
    expect(callProvenanceSize()).toBe(CAP);
    // The CAP most-recent tokens survive; everything older was evicted
    // oldest-first.
    for (let i = 0; i < 50 - CAP; i++) {
      expect(resolveCallProvenance(ids[i])).toBeUndefined();
    }
    for (let i = 50 - CAP; i < 50; i++) {
      expect(resolveCallProvenance(ids[i])?.actorExtensionId).toBe(`e-${i}`);
    }
    // A full TTL sweep then clears the survivors → size 0 (no leak
    // survives the final backstop).
    __sweepForTests(Date.now() + CALL_PROVENANCE_TTL_MS + 1);
    expect(callProvenanceSize()).toBe(0);
  });
});

describe("TTL boundary: entry exactly at TTL is kept, at TTL+1 is evicted", () => {
  test("eviction predicate is strictly `> TTL`, not `>=`", () => {
    const base = Date.now();
    const id = registerCallProvenance(sample());
    // Sweep at exactly base + TTL → age == TTL → NOT evicted
    // (predicate is `now - createdAt > TTL`).
    __sweepForTests(base + CALL_PROVENANCE_TTL_MS);
    expect(resolveCallProvenance(id)).toEqual(sample());
    expect(callProvenanceSize()).toBe(1);
    // One ms past the TTL → evicted.
    __sweepForTests(base + CALL_PROVENANCE_TTL_MS + 1);
    expect(resolveCallProvenance(id)).toBeUndefined();
    expect(callProvenanceSize()).toBe(0);
  });
});

describe("D2 hardening: kind-aware TTL — tool tokens outlive fire tokens", () => {
  test("a fire token is swept at FIRE_TOKEN_TTL_MS while a same-age tool token survives", () => {
    const base = Date.now();
    const toolId = registerCallProvenance(sample({ kind: "tool" }));
    const fireId = registerCallProvenance(
      sample({ kind: "schedule", onBehalfOf: null, ownerless: true }),
    );
    expect(FIRE_TOKEN_TTL_MS).toBeLessThan(CALL_PROVENANCE_TTL_MS);

    // Just past the FIRE TTL: the fire token is reaped, the tool token
    // (released deterministically in a forward `finally`, possibly a
    // long human-wait) is NOT — this is the D2 fix: never evict a
    // healthy long-running call's provenance on the fire schedule.
    __sweepForTests(base + FIRE_TOKEN_TTL_MS + 1);
    expect(resolveCallProvenance(fireId)).toBeUndefined();
    expect(resolveCallProvenance(toolId)).toEqual(sample({ kind: "tool" }));

    // The tool token only ages out at the (much larger) tool TTL.
    __sweepForTests(base + CALL_PROVENANCE_TTL_MS + 1);
    expect(resolveCallProvenance(toolId)).toBeUndefined();
    expect(callProvenanceSize()).toBe(0);
  });

  test("a tool token is NOT evicted at the fire TTL boundary", () => {
    const base = Date.now();
    const toolId = registerCallProvenance(sample({ kind: "tool" }));
    // Sweeps well past the fire TTL but below the tool TTL keep it.
    __sweepForTests(base + FIRE_TOKEN_TTL_MS * 10);
    expect(resolveCallProvenance(toolId)).toEqual(sample({ kind: "tool" }));
    expect(callProvenanceSize()).toBe(1);
  });

  test("event-kind tokens use the fire TTL too (not the tool TTL)", () => {
    const base = Date.now();
    const eventId = registerCallProvenance(sample({ kind: "event" }));
    __sweepForTests(base + FIRE_TOKEN_TTL_MS + 1);
    expect(resolveCallProvenance(eventId)).toBeUndefined();
  });
});

describe("registerFireCallProvenance: resolvable token + auto-release", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("returns a token that resolves to the fire snapshot immediately", () => {
    const prov = sample({ kind: "schedule", onBehalfOf: "cron-user" });
    const id = registerFireCallProvenance(prov);
    expect(typeof id).toBe("string");
    expect(resolveCallProvenance(id)).toEqual(prov);
    expect(callProvenanceSize()).toBe(1);
  });

  test("auto-releases the token exactly after FIRE_TOKEN_AUTO_RELEASE_MS", () => {
    jest.useFakeTimers();
    const id = registerFireCallProvenance(sample({ kind: "event" }));
    expect(callProvenanceSize()).toBe(1);
    // A release timer is scheduled (the seam: no manual finally for fires).
    expect(jest.getTimerCount()).toBeGreaterThanOrEqual(1);

    // Just before the window → still live (handler's reverse-RPC must
    // still resolve while in flight).
    jest.advanceTimersByTime(FIRE_TOKEN_AUTO_RELEASE_MS - 1);
    expect(resolveCallProvenance(id)).toBeDefined();
    expect(callProvenanceSize()).toBe(1);

    // Crossing the window → auto-released, no manual release needed.
    jest.advanceTimersByTime(1);
    expect(resolveCallProvenance(id)).toBeUndefined();
    expect(callProvenanceSize()).toBe(0);
  });

  test("explicit release before the timer is safe (idempotent with auto-release)", () => {
    jest.useFakeTimers();
    const id = registerFireCallProvenance(sample({ kind: "schedule" }));
    releaseCallProvenance(id);
    expect(callProvenanceSize()).toBe(0);
    // Timer still fires later but the delete is idempotent — no throw.
    expect(() => jest.runAllTimers()).not.toThrow();
    expect(callProvenanceSize()).toBe(0);
  });
});

describe("test reset", () => {
  test("_resetCallProvenanceForTests clears entries and restores the cap", () => {
    __setMaxEntriesForTests(1);
    registerCallProvenance(sample());
    _resetCallProvenanceForTests();
    expect(callProvenanceSize()).toBe(0);
    // Cap restored — two registrations now coexist.
    registerCallProvenance(sample());
    registerCallProvenance(sample());
    expect(callProvenanceSize()).toBe(2);
  });
});
