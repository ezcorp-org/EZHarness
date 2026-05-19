export type ReadinessState = "booting" | "ready" | "degraded";

export interface Readiness {
  state: ReadinessState;
  reason?: string;
  detail?: unknown;
  since: string;
}

let current: Readiness = { state: "booting", since: new Date().toISOString() };

export function getReadiness(): Readiness {
  return current;
}

export function setReadiness(next: Omit<Readiness, "since"> & { since?: string }): void {
  current = { ...next, since: next.since ?? new Date().toISOString() };
}

export function resetReadiness(): void {
  current = { state: "booting", since: new Date().toISOString() };
}
