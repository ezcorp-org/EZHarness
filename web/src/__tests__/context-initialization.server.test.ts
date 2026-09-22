/**
 * The W09 startup audit lead, pinned against the real `$lib/server/context`.
 *
 * `ensureInitialized()` set its `initialized` latch before doing any of the
 * work the latch stands for. Two things followed, and both are false
 * readiness rather than a slow start:
 *
 *   1. A second caller that arrives while the first is still initializing is
 *      told initialization succeeded. It then reaches for `getExecutor()` /
 *      `getBus()` and gets "Server not initialized".
 *   2. A start that fails leaves the latch set for the process lifetime. Every
 *      later caller is told initialization succeeded and every one of them
 *      fails on the first accessor. Nothing ever retries.
 *
 * The real server closes the first window today only because every route that
 * initializes lazily requires an authenticated principal first, and resolving
 * a principal needs the database that initialization opens. That is one
 * `await` of distance, not a guarantee, so the defect is fixed at its source:
 * the latch is the in-flight promise itself, and a failed attempt clears it.
 *
 * Only `$server/db/connection` is replaced here. `context.ts` itself is the
 * real module, and the assertions are about what a caller observes, not about
 * how initialization is implemented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let initDbCalls = 0;
let initDbBehaviour: () => Promise<void> = async () => {};

vi.mock("$server/db/connection", () => ({
  initDb: () => {
    initDbCalls++;
    return initDbBehaviour();
  },
  closeDb: async () => {},
}));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

/** Yield to the microtask queue without asserting on elapsed wall-clock time. */
const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

async function freshContext() {
  vi.resetModules();
  return import("$lib/server/context");
}

describe("ensureInitialized", () => {
  beforeEach(() => {
    initDbCalls = 0;
    initDbBehaviour = async () => {};
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("does not report success to a second caller while the first is still initializing", async () => {
    const gate = deferred<void>();
    initDbBehaviour = () => gate.promise;
    const context = await freshContext();

    const first = context.ensureInitialized();
    await tick();

    let secondSettled: "pending" | "resolved" | "rejected" = "pending";
    const second = context.ensureInitialized().then(
      () => { secondSettled = "resolved"; },
      () => { secondSettled = "rejected"; },
    );
    await tick();

    // The observable promise the caller holds. Before the fix this had already
    // resolved, which is what let the caller reach an unbuilt executor.
    expect(secondSettled).toBe("pending");
    expect(() => context.getExecutor()).toThrow(/not initialized/);

    gate.reject(new Error("database unavailable"));
    await expect(first).rejects.toThrow("database unavailable");
    await second;
    expect(secondSettled).toBe("rejected");
    // Concurrent callers share one attempt; the second never starts a rival one.
    expect(initDbCalls).toBe(1);
  });

  it("retries after a failed start instead of latching the failure", async () => {
    initDbBehaviour = async () => { throw new Error("database unavailable"); };
    const context = await freshContext();

    await expect(context.ensureInitialized()).rejects.toThrow("database unavailable");
    expect(initDbCalls).toBe(1);

    await expect(context.ensureInitialized()).rejects.toThrow("database unavailable");
    expect(initDbCalls).toBe(2);
  });

  it("never reports readiness through an accessor after a failed start", async () => {
    initDbBehaviour = async () => { throw new Error("database unavailable"); };
    const context = await freshContext();

    await expect(context.ensureInitialized()).rejects.toThrow("database unavailable");

    expect(() => context.getExecutor()).toThrow(/not initialized/);
    expect(() => context.getBus()).toThrow(/not initialized/);
    expect(() => context.getWorkflowExecutor()).toThrow(/not initialized/);
    expect(() => context.getCommandRegistry()).toThrow(/not initialized/);
  });

  it("rejects every caller of one failed attempt, not only the first", async () => {
    const gate = deferred<void>();
    initDbBehaviour = () => gate.promise;
    const context = await freshContext();

    const callers = [context.ensureInitialized(), context.ensureInitialized(), context.ensureInitialized()];
    const observed = callers.map((caller) => caller.then(() => "resolved" as const, () => "rejected" as const));
    await tick();

    gate.reject(new Error("database unavailable"));
    expect(await Promise.all(observed)).toEqual(["rejected", "rejected", "rejected"]);
    expect(initDbCalls).toBe(1);
  });
});
