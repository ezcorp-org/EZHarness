/**
 * Token-bucket rate limiter factory used by the capability-RPC handlers
 * (storage, emit-task-event, agent-configs). Each call returns an
 * isolated `consume(id, count)` closure with its own per-id bucket map,
 * so one hot handler cannot starve another's budget — same shape,
 * separate accounting.
 *
 * Semantics: each `id` (typically an extensionId) has `maxOpsPerSecond`
 * tokens that refill linearly. `consume` returns true if at least
 * `count` tokens are available, false otherwise. Tokens are consumed
 * on success; refill happens on every call based on elapsed
 * wall-clock time.
 *
 * Extracted from `storage-handler.ts:32-45` for reuse.
 *
 * The returned closure carries a `forget(id)` method that drops a single
 * id's bucket — callers with a bounded, churning id space (e.g. per-preview
 * accounting that must be released on reap) use it to avoid an unbounded
 * `buckets` Map. Idempotent; a no-op for an unknown id.
 */
export interface RateLimiter {
  (id: string, count: number): boolean;
  /** Drop a single id's bucket so a freed id doesn't leak memory. */
  forget(id: string): void;
}

export function createRateLimiter(maxOpsPerSecond: number): RateLimiter {
  interface Bucket { tokens: number; lastRefill: number; }
  const buckets = new Map<string, Bucket>();

  const consumeTokens = function consumeTokens(id: string, count: number): boolean {
    const now = Date.now();
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { tokens: maxOpsPerSecond, lastRefill: now };
      buckets.set(id, bucket);
    }
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(
      maxOpsPerSecond,
      bucket.tokens + elapsed * maxOpsPerSecond,
    );
    bucket.lastRefill = now;
    if (bucket.tokens < count) return false;
    bucket.tokens -= count;
    return true;
  } as RateLimiter;

  consumeTokens.forget = (id: string): void => {
    buckets.delete(id);
  };

  return consumeTokens;
}
