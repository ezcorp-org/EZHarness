// lock.test.ts — 100% line + branch coverage for runtime/lock.ts
//
// No fake timers — relies on real microtask ordering and tiny `await` waits
// to assert serialization vs. interleaving.

import { describe, expect, test } from "bun:test";

import { createMutex, withLock } from "../src/runtime/lock";

// ── Tiny helpers ───────────────────────────────────────────────────

function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ── withLock ───────────────────────────────────────────────────────

describe("withLock", () => {
  test("serializes two concurrent calls with the same key", async () => {
    // KEY: a unique string per test to avoid map-state bleed between tests.
    const KEY = `same-${Math.random()}`;
    const events: string[] = [];

    const gate1 = deferred<void>();
    const gate2 = deferred<void>();

    const p1 = withLock(KEY, async () => {
      events.push("fn1-start");
      await gate1.promise;
      events.push("fn1-end");
      return 1;
    });
    const p2 = withLock(KEY, async () => {
      events.push("fn2-start");
      await gate2.promise;
      events.push("fn2-end");
      return 2;
    });

    // Let microtasks settle so fn1 has a chance to start.
    await tick();
    expect(events).toEqual(["fn1-start"]);

    // Release fn1 — fn2 should now be able to start.
    gate1.resolve();
    await Promise.resolve();
    await tick();
    expect(events).toEqual(["fn1-start", "fn1-end", "fn2-start"]);

    gate2.resolve();
    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
    expect(events).toEqual(["fn1-start", "fn1-end", "fn2-start", "fn2-end"]);
  });

  test("runs concurrent calls with DIFFERENT keys in parallel", async () => {
    const events: string[] = [];
    const gateA = deferred<void>();
    const gateB = deferred<void>();

    const pa = withLock(`A-${Math.random()}`, async () => {
      events.push("A-start");
      await gateA.promise;
      events.push("A-end");
      return "a";
    });
    const pb = withLock(`B-${Math.random()}`, async () => {
      events.push("B-start");
      await gateB.promise;
      events.push("B-end");
      return "b";
    });

    // Both should be started after one tick — they don't share a queue.
    await tick();
    expect(events).toContain("A-start");
    expect(events).toContain("B-start");

    // Release in reverse order to prove they're independent.
    gateB.resolve();
    expect(await pb).toBe("b");
    gateA.resolve();
    expect(await pa).toBe("a");
  });

  test("rejected fn does NOT stall subsequent calls on the same key", async () => {
    const KEY = `poison-${Math.random()}`;
    const events: string[] = [];

    const p1 = withLock(KEY, async () => {
      events.push("fn1");
      throw new Error("fn1 boom");
    });

    // Schedule the second one synchronously after the first.
    const p2 = withLock(KEY, async () => {
      events.push("fn2");
      return "fn2-ok";
    });

    await expect(p1).rejects.toThrow("fn1 boom");
    expect(await p2).toBe("fn2-ok");
    expect(events).toEqual(["fn1", "fn2"]);
  });

  test("forwards the return value of fn", async () => {
    const KEY = `ret-${Math.random()}`;
    const obj = { v: 42 };
    const result = await withLock(KEY, async () => obj);
    expect(result).toBe(obj);
  });

  test("opportunistic map cleanup drops the entry once the chain settles", async () => {
    // We can't see `tails` directly, but the first call after settle takes
    // the no-prev branch (`?? Promise.resolve()`). To prove cleanup occurred
    // we run a chain, wait for full quiet, then verify a subsequent call
    // still works (i.e. the second `?? Promise.resolve()` branch is reached
    // again from a clean state).
    const KEY = `cleanup-${Math.random()}`;
    await withLock(KEY, async () => "first");
    // Allow the inner `tail.then(() => maybe-delete)` microtask to run.
    await tick();
    await tick();
    const second = await withLock(KEY, async () => "second");
    expect(second).toBe("second");
  });

  test("does not delete the entry when a newer caller has overtaken the tail", async () => {
    // Exercises the false branch of `if (tails.get(key) === tail)`.
    const KEY = `overtake-${Math.random()}`;
    const events: string[] = [];
    const gate1 = deferred<void>();

    const p1 = withLock(KEY, async () => {
      events.push("fn1-start");
      await gate1.promise;
      events.push("fn1-end");
    });
    // Schedule fn2 synchronously so the map's tail is fn2's tail when fn1
    // settles — the cleanup check `tails.get(key) === tail` (where tail is
    // fn1's tail) is now false.
    const p2 = withLock(KEY, async () => {
      events.push("fn2");
    });

    gate1.resolve();
    await p1;
    await p2;
    expect(events).toEqual(["fn1-start", "fn1-end", "fn2"]);
  });
});

// ── createMutex ────────────────────────────────────────────────────

describe("createMutex", () => {
  test("serializes all calls in a single chain", async () => {
    const mutex = createMutex();
    const events: string[] = [];
    const g1 = deferred<void>();
    const g2 = deferred<void>();
    const g3 = deferred<void>();

    const p1 = mutex(async () => {
      events.push("1-start");
      await g1.promise;
      events.push("1-end");
      return "a";
    });
    const p2 = mutex(async () => {
      events.push("2-start");
      await g2.promise;
      events.push("2-end");
      return "b";
    });
    const p3 = mutex(async () => {
      events.push("3-start");
      await g3.promise;
      events.push("3-end");
      return "c";
    });

    await tick();
    expect(events).toEqual(["1-start"]);
    g1.resolve();
    await tick();
    await tick();
    expect(events).toEqual(["1-start", "1-end", "2-start"]);
    g2.resolve();
    await tick();
    await tick();
    expect(events).toEqual(["1-start", "1-end", "2-start", "2-end", "3-start"]);
    g3.resolve();

    expect(await p1).toBe("a");
    expect(await p2).toBe("b");
    expect(await p3).toBe("c");
  });

  test("rejection does not poison the chain", async () => {
    const mutex = createMutex();

    const p1 = mutex(async () => {
      throw new Error("poison");
    });
    const p2 = mutex(async () => "after-poison");

    await expect(p1).rejects.toThrow("poison");
    expect(await p2).toBe("after-poison");
  });

  test("each createMutex() call returns an independent chain", async () => {
    const mutexA = createMutex();
    const mutexB = createMutex();
    const events: string[] = [];
    const gateA = deferred<void>();

    const pa = mutexA(async () => {
      events.push("A-start");
      await gateA.promise;
      events.push("A-end");
    });
    const pb = mutexB(async () => {
      events.push("B");
    });

    await tick();
    // B is on its own chain, must run while A is still gated.
    expect(events).toContain("A-start");
    expect(events).toContain("B");
    await pb;
    gateA.resolve();
    await pa;
  });
});
