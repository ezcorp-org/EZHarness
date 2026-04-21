// Per-provider sliding-window rate limiter. In-memory only — reset when the
// extension subprocess restarts. Acceptable because the ceiling here is
// advisory (soft protection of the Jina free tier); BYOK providers set
// `limit: Infinity` so their upstream errors dominate.

export interface RateLimiterOptions {
  /** Window length in ms. */
  windowMs: number;
  /** Clock source; override in tests. */
  now?: () => number;
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, { limit: number; hits: number[] }>();

  constructor(opts: RateLimiterOptions) {
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
  }

  /** Declare the capacity for a provider. `Infinity` disables limiting. */
  register(provider: string, limit: number): void {
    if (!this.buckets.has(provider)) this.buckets.set(provider, { limit, hits: [] });
    else this.buckets.get(provider)!.limit = limit;
  }

  /** Atomically: drop stale hits, check capacity, record a hit if allowed. */
  allow(provider: string): boolean {
    const bucket = this.buckets.get(provider);
    if (!bucket) return true; // unregistered → unbounded
    if (bucket.limit === Infinity) return true;
    const cutoff = this.now() - this.windowMs;
    while (bucket.hits.length > 0 && bucket.hits[0]! <= cutoff) bucket.hits.shift();
    if (bucket.hits.length >= bucket.limit) return false;
    bucket.hits.push(this.now());
    return true;
  }
}
