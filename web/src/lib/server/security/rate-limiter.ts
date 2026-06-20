interface RateLimitEntry {
  count: number;
  windowStart: number;
  blockedAudited: boolean;
}

interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
  /**
   * True only on the FIRST `check()` call that crosses the limit within
   * a given window for a given key. Subsequent blocked calls in the same
   * window report `false`. Resets when the window rolls over.
   *
   * Callers can use this to emit a single "rate-limit fired" diagnostic
   * (e.g. an audit row) per IP+window without producing one per blocked
   * attempt — i.e. without the limiter itself becoming a log-amplifier.
   */
  firstBlock?: boolean;
}

export class RateLimiter {
  private entries = new Map<string, RateLimitEntry>();

  constructor(
    private defaultLimit: number,
    private windowMs: number,
  ) {}

  check(key: string, limit?: number): RateLimitResult {
    const now = Date.now();
    const max = limit ?? this.defaultLimit;
    const entry = this.entries.get(key);

    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.entries.set(key, { count: 1, windowStart: now, blockedAudited: false });
      return { allowed: true };
    }

    if (entry.count < max) {
      entry.count++;
      return { allowed: true };
    }

    const retryAfter = Math.ceil((entry.windowStart + this.windowMs - now) / 1000);
    const firstBlock = !entry.blockedAudited;
    if (firstBlock) {
      entry.blockedAudited = true;
    }
    return { allowed: false, retryAfter: Math.max(retryAfter, 1), firstBlock };
  }

  /**
   * Read-only check: reports whether the NEXT `check()` for `key` would be
   * blocked, WITHOUT mutating any counter. Returns `allowed: true` when the
   * key has no active window or is still under the limit.
   *
   * This exists so a caller can short-circuit an expensive operation (e.g.
   * the failed-API-key fallback table scan in `verifyApiKey`) for an IP that
   * has ALREADY exhausted its failure budget, while still counting only
   * genuine failures via a separate `check()` call. Mirrors `check()`'s
   * window-rollover and limit semantics exactly so the two never disagree.
   */
  peek(key: string, limit?: number): RateLimitResult {
    const now = Date.now();
    const max = limit ?? this.defaultLimit;
    const entry = this.entries.get(key);

    if (!entry || now - entry.windowStart >= this.windowMs) {
      return { allowed: true };
    }
    if (entry.count < max) {
      return { allowed: true };
    }
    const retryAfter = Math.ceil((entry.windowStart + this.windowMs - now) / 1000);
    return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStart >= this.windowMs) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Drop all tracked entries. Intended for test isolation when a handler
   * module owns a singleton limiter — each test's `beforeEach` calls
   * `<handler>.__rateLimiter.reset()` so attempt counters don't leak
   * between cases. Safe to call in production but not used there.
   */
  reset(): void {
    this.entries.clear();
  }
}
