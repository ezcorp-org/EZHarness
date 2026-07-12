import { spyOn } from "bun:test";

/**
 * Run `fn` with `Date.now()` frozen at a single instant, then restore it —
 * unconditionally, even if `fn` throws.
 *
 * Why the storage rate-limit drain tests need this: the token bucket in
 * `src/extensions/rate-limit.ts` refills linearly on wall-clock elapsed
 * time (`MAX_OPS_PER_SECOND` tokens/second). The drain tests issue a burst
 * of *awaited* DB-backed ops to prove that exceeding the budget returns
 * -32004. Under CPU load each awaited op can take >20ms — i.e. longer than
 * one 50/sec token's refill interval — so the bucket refills at least as
 * fast as it drains and the burst never trips the limit. That is a false
 * red born purely of scheduling, not a real regression (reproduced by
 * running the suite under `nproc*3` CPU burners).
 *
 * Freezing the clock removes the timing dependency and asserts the exact
 * security invariant instead: with a full bucket, more than
 * `maxOpsPerSecond` ops issued in a single frozen instant are rejected —
 * no refill can mask the overflow. The bucket is keyed per-extension-id and
 * every drain test uses a fresh id, so freezing during one test's burst
 * cannot affect any other test.
 *
 * Restoration is via `try/finally` (not just an `afterEach`) so the spy can
 * never leak past this call and poison a sibling test or a parallel shard —
 * see the repo's prototype-spy-leak lesson.
 */
export async function withFrozenNow<T>(
  fn: () => T | Promise<T>,
  at: number = Date.now(),
): Promise<T> {
  const spy = spyOn(Date, "now").mockImplementation(() => at);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}
