/**
 * Unit tests for the per-call reverse-RPC provenance registry
 * (`src/extensions/call-provenance.ts`).
 *
 * The registry is pure in-process state with host-only test hooks
 * (`_resetCallProvenanceForTests`, `__sweepForTests`,
 * `__setMaxEntriesForTests`), so every arm — register / resolve /
 * release, the kind-aware TTL sweep eviction, the hard-cap OOM eviction,
 * the fire-and-forget auto-release timer, and the resolve-miss / no-token
 * defensive paths — is driveable deterministically without real time or
 * a real subprocess. The integration paths exercise the *consumers* of
 * this registry; this file pins the registry's own contract.
 *
 * Lives in `src/__tests__/` so the per-file coverage gate counts these
 * lines toward `src/extensions/call-provenance.ts` (see
 * scripts/test-coverage.sh).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  type CallProvenanceKind,
} from "../extensions/call-provenance";

function makeProv(kind: CallProvenanceKind, over: Partial<CallProvenance> = {}): CallProvenance {
  return {
    onBehalfOf: "user-1",
    conversationId: "conv-1",
    runId: null,
    parentCallId: null,
    actorExtensionId: "ext-a",
    kind,
    ownerless: false,
    ...over,
  };
}

describe("call-provenance registry", () => {
  beforeEach(() => _resetCallProvenanceForTests());
  afterEach(() => _resetCallProvenanceForTests());

  test("register → resolve returns a defensive copy of the snapshot", () => {
    const prov = makeProv("tool");
    const id = registerCallProvenance(prov);
    expect(typeof id).toBe("string");
    expect(callProvenanceSize()).toBe(1);

    const resolved = resolveCallProvenance(id);
    expect(resolved).toEqual(prov);
    // Defensive copy: mutating the result must not poison the registry.
    resolved!.onBehalfOf = "tampered";
    expect(resolveCallProvenance(id)!.onBehalfOf).toBe("user-1");
  });

  test("release drops the token and is idempotent", () => {
    const id = registerCallProvenance(makeProv("tool"));
    expect(callProvenanceSize()).toBe(1);
    releaseCallProvenance(id);
    expect(callProvenanceSize()).toBe(0);
    expect(resolveCallProvenance(id)).toBeUndefined();
    // Idempotent second release — no throw, still 0.
    releaseCallProvenance(id);
    expect(callProvenanceSize()).toBe(0);
  });

  test("release with no/empty token is a no-op", () => {
    registerCallProvenance(makeProv("tool"));
    releaseCallProvenance(undefined);
    releaseCallProvenance(null);
    releaseCallProvenance("");
    expect(callProvenanceSize()).toBe(1);
  });

  test("resolve with no/empty token returns undefined (defensive)", () => {
    expect(resolveCallProvenance(undefined)).toBeUndefined();
    expect(resolveCallProvenance(null)).toBeUndefined();
    expect(resolveCallProvenance("")).toBeUndefined();
  });

  test("resolve miss — unknown token returns undefined", () => {
    registerCallProvenance(makeProv("tool"));
    expect(resolveCallProvenance("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });

  test("TTL sweep is kind-aware: a stale fire token is evicted, a fresh tool token survives", () => {
    const toolId = registerCallProvenance(makeProv("tool"));
    const fireId = registerCallProvenance(makeProv("event"));
    expect(callProvenanceSize()).toBe(2);

    // Advance the virtual clock just past the (shorter) fire TTL but well
    // within the (much longer) tool TTL.
    const now = Date.now() + FIRE_TOKEN_TTL_MS + 1_000;
    __sweepForTests(now);

    expect(resolveCallProvenance(fireId)).toBeUndefined();
    expect(resolveCallProvenance(toolId)).toBeDefined();
    expect(callProvenanceSize()).toBe(1);
  });

  test("TTL sweep eventually evicts even a tool token past its long TTL", () => {
    const toolId = registerCallProvenance(makeProv("tool"));
    __sweepForTests(Date.now() + CALL_PROVENANCE_TTL_MS + 1_000);
    expect(resolveCallProvenance(toolId)).toBeUndefined();
    expect(callProvenanceSize()).toBe(0);
  });

  test("sweep on an empty registry is a fast no-op", () => {
    expect(callProvenanceSize()).toBe(0);
    __sweepForTests(Date.now() + CALL_PROVENANCE_TTL_MS * 10);
    expect(callProvenanceSize()).toBe(0);
  });

  test("hard cap evicts the oldest entry when the registry is full (OOM guard)", () => {
    __setMaxEntriesForTests(2);
    const first = registerCallProvenance(makeProv("tool", { actorExtensionId: "ext-first" }));
    const second = registerCallProvenance(makeProv("tool", { actorExtensionId: "ext-second" }));
    expect(callProvenanceSize()).toBe(2);

    // Registry is at the cap → registering a third evicts the OLDEST (first).
    const third = registerCallProvenance(makeProv("tool", { actorExtensionId: "ext-third" }));
    expect(resolveCallProvenance(first)).toBeUndefined();
    expect(resolveCallProvenance(second)).toBeDefined();
    expect(resolveCallProvenance(third)).toBeDefined();
    expect(callProvenanceSize()).toBe(2);
  });

  test("registerFireCallProvenance registers a resolvable token and arms a non-blocking auto-release timer", () => {
    // Stub setTimeout to capture the auto-release callback + delay without
    // burning real wall-clock (the production window is 2 min). The
    // returned handle exposes an `unref` we assert the registry calls so
    // the timer can never keep the process alive.
    const realSetTimeout = globalThis.setTimeout;
    let captured: { fn: () => void; ms: number; unrefCalled: boolean } | null = null;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      const handle = {
        unref() {
          if (captured) captured.unrefCalled = true;
          return handle;
        },
      };
      captured = { fn, ms, unrefCalled: false };
      return handle;
    }) as typeof setTimeout;

    try {
      const id = registerFireCallProvenance(makeProv("schedule"));
      expect(resolveCallProvenance(id)).toBeDefined();
      expect(callProvenanceSize()).toBe(1);

      expect(captured).not.toBeNull();
      expect(captured!.ms).toBe(FIRE_TOKEN_AUTO_RELEASE_MS);
      expect(captured!.unrefCalled).toBe(true);

      // Driving the captured callback releases the token — the auto-release
      // contract, verified without waiting on real time.
      captured!.fn();
      expect(resolveCallProvenance(id)).toBeUndefined();
      expect(callProvenanceSize()).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("registerFireCallProvenance honors a custom autoReleaseMs (timer + sweep expiry)", () => {
    // A caller opting into a LONGER window (schedule fire → maxRunDurationMs,
    // hub fire → 4 h) must (a) arm the auto-release timer for THAT window and
    // (b) survive the short kind-based TTL sweep until then — otherwise the
    // token is reaped mid-run and the reverse-RPC fails -32602 (the exact bug).
    const realSetTimeout = globalThis.setTimeout;
    let captured: { ms: number } | null = null;
    globalThis.setTimeout = ((_fn: () => void, ms: number) => {
      captured = { ms };
      return { unref() { return this; } };
    }) as unknown as typeof setTimeout;

    try {
      const customMs = 30 * 60_000; // 30 min — well past the 10-min fire TTL
      const id = registerFireCallProvenance(makeProv("schedule"), { autoReleaseMs: customMs });
      expect(captured!.ms).toBe(customMs);

      // The default fire TTL is 10 min; without a per-token expiry the sweep
      // would evict at ~10 min. With the opt-in window pinned, a sweep at
      // 11 min must NOT evict it.
      __sweepForTests(Date.now() + FIRE_TOKEN_TTL_MS + 60_000);
      expect(resolveCallProvenance(id)).toBeDefined();

      // A sweep past the custom window DOES evict it (the backstop still bites).
      __sweepForTests(Date.now() + customMs + 1_000);
      expect(resolveCallProvenance(id)).toBeUndefined();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("registerFireCallProvenance without opts keeps the 2-min default + 10-min sweep TTL", () => {
    const realSetTimeout = globalThis.setTimeout;
    let captured: { ms: number } | null = null;
    globalThis.setTimeout = ((_fn: () => void, ms: number) => {
      captured = { ms };
      return { unref() { return this; } };
    }) as unknown as typeof setTimeout;

    try {
      const id = registerFireCallProvenance(makeProv("event"));
      // Default auto-release window unchanged.
      expect(captured!.ms).toBe(FIRE_TOKEN_AUTO_RELEASE_MS);
      // No per-token expiry → the kind-based 10-min fire TTL governs the sweep.
      __sweepForTests(Date.now() + FIRE_TOKEN_TTL_MS - 1_000);
      expect(resolveCallProvenance(id)).toBeDefined();
      __sweepForTests(Date.now() + FIRE_TOKEN_TTL_MS + 1_000);
      expect(resolveCallProvenance(id)).toBeUndefined();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});
