// ── Async locks ─────────────────────────────────────────────────
//
// In-process sequencing primitives. `withLock(key, fn)` serializes all
// invocations that share the same `key`; `createMutex()` gives you a
// key-less single-chain mutex scoped to a closure.
//
// Rejections in `fn` do NOT poison the chain — a failing critical section
// still releases the next waiter. The rejection propagates to the caller
// who scheduled it.

/**
 * Module-level per-key queue of tail promises. The value is the promise
 * representing "everything scheduled on this key so far"; new callers
 * chain after it.
 *
 * Using `Promise<unknown>` instead of `Promise<void>` so we can reuse the
 * same entry for every subsequent caller without caring what they return.
 */
const tails = new Map<string, Promise<unknown>>();

/**
 * Serialize `fn` against every other call with the same `key`. Calls with
 * different keys run concurrently. Rejections in `fn` do not prevent
 * subsequent callers on the same key from running.
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();

  // The tail we publish back to the map: it resolves when `fn` settles
  // (success OR failure), so the next caller runs no matter what.
  const run = prev.then(() => fn());
  // Publish a tail that NEVER rejects, so future `.then(() => fn())`
  // always moves forward. Caller still sees the real rejection via `run`.
  const tail = run.catch(() => undefined);

  tails.set(key, tail);

  // Opportunistic cleanup: if we're still the latest tail after this fn
  // settles, drop the map entry so keys don't leak forever.
  tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });

  return run;
}

/**
 * Create an anonymous single-chain mutex (no key). Callers chain through
 * the same closure-scoped tail regardless of what `fn` they pass.
 * Rejection in `fn` does not poison the chain.
 */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(() => fn());
    tail = run.catch(() => undefined);
    return run;
  };
}
