/**
 * Per-capability TTL configuration for the permission-grant expiry sweep.
 *
 * This module is the SOLE source of truth for "how long does a granted
 * permission live before the user is re-prompted?" — Phase 2 (the sweep
 * itself) and Phase 4 (the re-approve UI) both read from here. No magic
 * numbers in sweep code or UI copy.
 *
 * Phase 1 ships ONLY the config; the sweep that consumes it lands in
 * Phase 2. Until then this module has no production callers — it exists
 * so the contract is unit-testable in isolation.
 *
 * Source: `tasks/capability-expiry-design.md` § 2.4 (TTL table).
 *
 * Note on the key namespace: the keys below are NOT the runtime
 * `CapabilityKind` strings from `./capability-types.ts`. The runtime PDP
 * speaks in fine-grained `(kind, value)` pairs (e.g. `fs.write` +
 * absolute path). The expiry config speaks at a coarser granularity —
 * one TTL per "permission family" the user reasons about ("the
 * filesystem write capability", "shell execution"). The sweep maps from
 * a stored grant key (network/filesystem/shell/env/storage/llm/...) to
 * a `CapabilityExpiryKind` here. Phase 2 will introduce the mapping
 * helper alongside the sweep that needs it.
 */

/**
 * Permission families with a configurable expiry policy. The string
 * values mirror the rows in `capability-expiry-design.md` § 2.4. Phase
 * 1 freezes this list; Phase 2 may add a kind only if the design doc
 * is amended first (re-plan, not deviation-mid-flight).
 */
export type CapabilityExpiryKind =
  | "filesystem-read"
  | "filesystem-write"
  | "shell"
  | "network"
  | "env"
  | "storage"
  | "taskEvents"
  | "appendMessages"
  | "llm"
  | "memory"
  | "lessons"
  | "schedule";

/** Sentinel: this capability is not subject to expiry sweeping. */
export type NeverExpires = "never";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Default TTL fallback for the `forever`-scope sweep when the
 * `EZCORP_PERM_FOREVER_TTL_DAYS` env var is unset or invalid. Locked at
 * 90 days per resolved milestone open question 6.1 (see
 * `tasks/capability-expiry-milestone.md` § A).
 */
export const DEFAULT_FOREVER_TTL_DAYS = 90;

/**
 * Per-capability TTL table. Values in milliseconds (so the sweep can
 * compare directly against `Date.now() - grantedAt` with no unit math).
 * `"never"` means the sweep skips that family entirely — the grant
 * lives until manually revoked.
 *
 * Locked decisions (design doc § 2.4):
 *   - filesystem-write 30d (most sensitive; tightest cycle)
 *   - filesystem-read 90d (lower risk)
 *   - shell 30d (effectively unrestricted; tighten)
 *   - network 90d (per-host allowlist already narrows blast radius)
 *   - env 90d (static credentials; periodic rotation prompt)
 *   - llm 90d (cost-bearing; periodic re-consent)
 *   - memory 90d (cross-conversation persistence)
 *   - lessons 90d (cross-conversation persistence)
 *   - storage Never (per-extension namespace; isolated)
 *   - taskEvents Never (behavioral, no data leak)
 *   - appendMessages Never (behavioral, no data leak)
 *   - schedule Never (bounded by `maxRunsPerDay`)
 *
 * Per-capability env-var overrides are deferred to v1.5 (open question
 * 6.1). The single global override is `EZCORP_PERM_FOREVER_TTL_DAYS`,
 * which applies only to the `forever` always-allow scope (see
 * `getForeverTtlMs`). It does NOT shadow this table.
 */
export const TTL_CONFIG: Readonly<Record<CapabilityExpiryKind, number | NeverExpires>> = Object.freeze({
  "filesystem-read": 90 * DAY_MS,
  "filesystem-write": 30 * DAY_MS,
  shell: 30 * DAY_MS,
  network: 90 * DAY_MS,
  env: 90 * DAY_MS,
  storage: "never",
  taskEvents: "never",
  appendMessages: "never",
  llm: 90 * DAY_MS,
  memory: 90 * DAY_MS,
  lessons: 90 * DAY_MS,
  schedule: "never",
});

/**
 * Resolve the TTL (in ms) for a capability family. Returns `"never"`
 * for capabilities that are never swept (caller should skip).
 *
 * @param kind  Capability family (one of {@link CapabilityExpiryKind}).
 * @param foreverDays  Optional fallback when the kind is sentinel-ish
 *   in the future. Phase 1 doesn't actually use this — the env-var
 *   override is keyed off the always-allow `forever` SCOPE, not off
 *   the capability kind — but the parameter is accepted so a future
 *   per-capability override (v1.5) doesn't churn callers.
 */
export function getTtlMs(
  kind: CapabilityExpiryKind,
  _foreverDays: number = DEFAULT_FOREVER_TTL_DAYS,
): number | NeverExpires {
  return TTL_CONFIG[kind];
}

/**
 * Read `EZCORP_PERM_FOREVER_TTL_DAYS` and return the TTL (ms) for the
 * `forever` always-allow scope. Defaults to 90 days when unset; falls
 * back to the same default on a non-numeric / non-positive env value
 * (treat malformed input as "use the safe default", not an error — the
 * sweep should never crash on a typo'd env var).
 *
 * Read at every call (cheap, and means tests can flip the env var
 * between cases without re-importing the module).
 */
export function getForeverTtlMs(): number {
  const raw = process.env.EZCORP_PERM_FOREVER_TTL_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_FOREVER_TTL_DAYS * DAY_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_FOREVER_TTL_DAYS * DAY_MS;
  return Math.floor(n) * DAY_MS;
}

/**
 * Convenience: does this capability family ever expire? `true` when
 * the TTL is a finite number; `false` when it's `"never"`. The sweep
 * uses this to short-circuit the per-row TTL evaluation.
 */
export function isExpiringKind(kind: CapabilityExpiryKind): boolean {
  return TTL_CONFIG[kind] !== "never";
}
