export type ReadinessState = "booting" | "ready" | "degraded";

export interface Readiness {
  state: ReadinessState;
  reason?: string;
  detail?: unknown;
  since: string;
}

let current: Readiness = { state: "booting", since: new Date().toISOString() };

/**
 * Named diagnostics a boot step publishes beside the readiness it does not own (W4H-26: built-in runner
 * staging runs after the factory sets readiness, and a failure there must be visible, not only logged).
 * They ride every readiness value under `detail.diagnostics`; with none, readiness is exactly what was set.
 */
const diagnostics = new Map<string, unknown>();

export function setReadinessDiagnostic(name: string, value: unknown): void {
  if (value === undefined) diagnostics.delete(name);
  else diagnostics.set(name, value);
}

export function getReadiness(): Readiness {
  if (diagnostics.size === 0) return current;
  const detail = current.detail;
  const base = detail !== null && typeof detail === "object" && !Array.isArray(detail) ? detail : detail === undefined ? {} : { value: detail };
  return { ...current, detail: { ...base, diagnostics: Object.fromEntries(diagnostics) } };
}

export function setReadiness(next: Omit<Readiness, "since"> & { since?: string }): void {
  current = { ...next, since: next.since ?? new Date().toISOString() };
}

export function resetReadiness(): void {
  current = { state: "booting", since: new Date().toISOString() };
}
