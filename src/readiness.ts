export type ReadinessState = "booting" | "ready" | "degraded";

export interface Readiness {
  state: ReadinessState;
  reason?: string;
  detail?: unknown;
  since: string;
  warnings?: ReadinessWarning[];
}

/** A non-blocking condition a person should know about (W4H-32): a code and its subject, never a message. */
export interface ReadinessWarning {
  code: string;
  artifactDigest: string;
  count: number;
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

/** Warnings by code and subject, each with how often it happened in this process. They never change the state. */
const warnings = new Map<string, ReadinessWarning>();

export function recordReadinessWarning(warning: Omit<ReadinessWarning, "count">): void {
  const key = `${warning.code}\0${warning.artifactDigest}`;
  warnings.set(key, { code: warning.code, artifactDigest: warning.artifactDigest, count: (warnings.get(key)?.count ?? 0) + 1 });
}

export function getReadiness(): Readiness {
  let readiness = current;
  if (diagnostics.size > 0) {
    const detail = current.detail;
    const base = detail !== null && typeof detail === "object" && !Array.isArray(detail) ? detail : detail === undefined ? {} : { value: detail };
    readiness = { ...readiness, detail: { ...base, diagnostics: Object.fromEntries(diagnostics) } };
  }
  return warnings.size === 0 ? readiness : { ...readiness, warnings: [...warnings.values()].map(warning => ({ ...warning })) };
}

export function setReadiness(next: Omit<Readiness, "since"> & { since?: string }): void {
  current = { ...next, since: next.since ?? new Date().toISOString() };
}

export function resetReadiness(): void {
  current = { state: "booting", since: new Date().toISOString() };
  warnings.clear();
}
