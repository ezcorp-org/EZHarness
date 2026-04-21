interface RateLimitEntry {
  count: number;
  windowStart: number;
}

interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
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
      this.entries.set(key, { count: 1, windowStart: now });
      return { allowed: true };
    }

    if (entry.count < max) {
      entry.count++;
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
}
