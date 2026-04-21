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

const breakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(provider: string): CircuitBreaker {
  let cb = breakers.get(provider);
  if (!cb) {
    cb = new CircuitBreaker();
    breakers.set(provider, cb);
  }
  return cb;
}

export function resetAllCircuitBreakers(): void {
  breakers.clear();
}
