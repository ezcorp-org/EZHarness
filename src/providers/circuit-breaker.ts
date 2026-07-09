type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly resetTimeout: number;

  constructor(threshold = 3, resetTimeout = 60_000) {
    this.threshold = threshold;
    this.resetTimeout = resetTimeout;
  }

  isOpen(): boolean {
    if (this.state === "open") {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.resetTimeout) {
        this.state = "half-open";
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.failures++;
    if (this.state === "half-open") {
      this.state = "open";
      this.openedAt = Date.now();
      return;
    }
    if (this.failures >= this.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}

/**
 * Upper bound on distinct `(provider, scope)` breaker entries kept in
 * memory. Scopes are per-user (see {@link getCircuitBreaker}), so an
 * unbounded map would grow with the user population; past the cap the
 * OLDEST-INSERTED entry is evicted (simple insertion-order eviction —
 * a rarely-used scope losing its breaker state is harmless: it just
 * starts closed again).
 */
export const MAX_BREAKER_ENTRIES = 512;

const breakers = new Map<string, CircuitBreaker>();

/**
 * Get (or lazily create) the circuit breaker for a `(provider, scope)`
 * pair.
 *
 * `scope` is the credential scope the failure/success signals belong to —
 * in prod the conversation owner's userId. Keying per scope stops one
 * user's 429s (their key's rate limit) from opening the breaker for every
 * other user of the same provider. Context-free callers (router tier
 * routing, legacy paths) omit it and share the process-wide `"shared"`
 * breaker — behavior-identical to the old provider-only keying.
 */
export function getCircuitBreaker(provider: string, scope = "shared"): CircuitBreaker {
  const key = `${provider} ${scope}`;
  let cb = breakers.get(key);
  if (!cb) {
    cb = new CircuitBreaker();
    if (breakers.size >= MAX_BREAKER_ENTRIES) {
      // Evict the oldest-inserted entry (Map iterates in insertion order).
      const oldest = breakers.keys().next().value;
      if (oldest !== undefined) breakers.delete(oldest);
    }
    breakers.set(key, cb);
  }
  return cb;
}

export function resetAllCircuitBreakers(): void {
  breakers.clear();
}
