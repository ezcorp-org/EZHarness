/**
 * Capability-expiry sweep — pure planner + DB applier.
 *
 * Phase 2 of the capability-expiry milestone (see
 * `tasks/capability-expiry-milestone.md` § Phase 2). Phase 1 shipped the
 * data-model contract (`./perm-expiry-config.ts` TTL table, the
 * `{allowed, grantedAt}` always-allow value shape, and the
 * `EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED` constant). This module connects
 * those pieces into:
 *
 *   • {@link runSweep}            — pure function. Reads the DB, computes
 *                                   the list of revocations + audit rows
 *                                   + events, returns them as data. NO
 *                                   side effects (no writes, no audits,
 *                                   no event emission). Sweep is
 *                                   idempotent: rerunning over already-
 *                                   revoked state yields zero
 *                                   revocations.
 *
 *   • {@link applySweepResult}    — applies the plan to the DB best-
 *                                   effort. Wraps each per-extension
 *                                   apply in a `SELECT … FOR UPDATE`
 *                                   read + CHECK-clause UPDATE so a
 *                                   concurrent user-grant write doesn't
 *                                   silently clobber the user's just-
 *                                   approved value. Skipped rows are
 *                                   reported, not errored — the sweep
 *                                   re-converges on the next tick.
 *
 *   • {@link mapGrantKeyToExpiryKind} — coerces the grant-record key
 *                                   namespace (`network`, `filesystem`,
 *                                   `shell`, …) onto the coarser
 *                                   `CapabilityExpiryKind` taxonomy from
 *                                   `./perm-expiry-config.ts`. Internal
 *                                   helper; exported so the unit-test
 *                                   suite can exercise it directly.
 *
 * No host event bus is established here — `EventBus` in `src/runtime/
 * events.ts` is per-runtime, not per-host. Locked decision §1: sweep
 * returns events as data, the call site (Phase 2 = the manual CLI;
 * Phase 4 = the daemon + UI) decides what to do with them. Phase 4's
 * UX work will wire real listeners.
 *
 * Out of scope (per orchestrator brief):
 *   • `conversationExtensions.grantedPermissions` per-conversation
 *     overrides — these were not in the design doc and the schema column
 *     exists for a different purpose.
 *   • Orphan-row cleanup for uninstalled extensions (deferred per design
 *     doc § 2.7).
 *   • Daemon registration (Phase 3).
 */

import { and, eq, like, sql } from "drizzle-orm";
import { extensions, settings } from "../db/schema";
import { insertAuditEntry } from "../db/queries/audit-log";
import {
  TTL_CONFIG,
  getForeverTtlMs,
  type CapabilityExpiryKind,
} from "./perm-expiry-config";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";
import { parseAlwaysAllowValue, type AlwaysAllowScope } from "./permissions";
import type { ExtensionPermissions } from "./types";

// ── Types ────────────────────────────────────────────────────────────

/**
 * Scope tag on an audit row. `extensions-row` distinguishes a per-
 * extension grant on the `extensions.granted_permissions` JSON column
 * from an always-allow row on `settings`. The four `AlwaysAllowScope`
 * values mirror `./permissions.ts`.
 */
export type SweepScope = AlwaysAllowScope | "extensions-row";

/**
 * One revocation in the plan. The shape is keyed enough to drive the
 * apply step without re-reading the DB — `extensionId` + (`capability`
 * | `settingKey`) is the addressable handle.
 */
export type Revocation =
  | {
      kind: "extension-grant";
      extensionId: string;
      /** Grant-record key (e.g. `"network"`, `"filesystem"`) — the
       *  *raw* key used on `ExtensionPermissions.grantedAt` and on the
       *  permission value itself. */
      grantKey: string;
      /** Coarse `CapabilityExpiryKind` family this grant key maps onto
       *  — what the audit row's `metadata.capability` records. */
      capability: CapabilityExpiryKind;
      ageMs: number;
      ttlMs: number;
    }
  | {
      kind: "always-allow";
      extensionId: string;
      settingKey: string;
      capability: CapabilityExpiryKind;
      scope: AlwaysAllowScope;
      ageMs: number;
      ttlMs: number;
    };

/**
 * Audit row plan — `applySweepResult` calls `insertAuditEntry` with
 * exactly these fields. Decoupled from `Revocation` so the call-site
 * can re-emit them via a different sink in Phase 4 if needed.
 */
export interface AuditPlan {
  userId: string | null;
  action: string;
  target: string;
  metadata: {
    capability: CapabilityExpiryKind;
    scope: SweepScope;
    ttlMs: number;
    ageMs: number;
  };
}

/**
 * Event payload — the shape future listeners consume. Phase 2's CLI
 * just logs these as JSON lines; Phase 4 wires real listeners.
 */
export interface ExpiryEvent {
  type: "perm-expired";
  data: {
    extensionId: string;
    capability: CapabilityExpiryKind;
    scope: SweepScope;
    ageMs: number;
  };
}

/**
 * Result of {@link runSweep}. Plan-only; no DB mutation has happened
 * yet at this point.
 *
 * Note on `audits`: consumers using {@link applySweepResult} should rely
 * on `ApplyOutcome.audits` (the count of audit rows actually written),
 * not this field. `SweepResult.audits` is informational for non-applying
 * callers (e.g. dry-run reporting); the apply path rebuilds the audit
 * shape internally to honor the audit-only-on-applied invariant — see
 * the comment block at {@link applySweepResult}, particularly the
 * `applyAudit` helper. Skipped revocations (race-mitigated) emit no
 * audit row.
 */
export interface SweepResult {
  revocations: Revocation[];
  audits: AuditPlan[];
  events: ExpiryEvent[];
}

/** Per-extension error captured by {@link applySweepResult}. */
export interface ApplyError {
  extensionId: string;
  reason: string;
  details?: string;
}

/** Outcome of {@link applySweepResult}. */
export interface ApplyOutcome {
  /** Audit rows successfully written. */
  audits: number;
  /** Revocations actually applied (i.e. extension row or settings row
   *  was rewritten). Skipped concurrent-write rows do NOT count. */
  applied: number;
  /** Rows that were skipped because the underlying value changed
   *  between the {@link runSweep} read and our write — race
   *  mitigation. The sweep re-converges on the next tick. */
  skippedConcurrent: number;
  /** Per-extension hard errors (DB connection, FK violation, …). */
  errors: ApplyError[];
}

/** Inputs to {@link runSweep}. */
export interface SweepInputs {
  /** Drizzle DB handle. The function uses only `select()` against it
   *  — no writes, no transactions. Typed as `any`: drizzle's HKT
   *  signature differs between the PGlite and bun-sql adapters, so
   *  the existing connection layer (`connection.ts:31`) collapses
   *  the union to `any`; mirroring that here. */
  db: any;
  /** Current epoch ms — injected so tests can run with a frozen clock
   *  without monkey-patching `Date.now`. */
  now: number;
  config?: {
    /** Override for the per-key TTL table. Useful in tests; falls back
     *  to `./perm-expiry-config.ts` `TTL_CONFIG` when omitted. */
    ttlConfig?: Readonly<Record<CapabilityExpiryKind, number | "never">>;
    /** Override for the `forever`-scope TTL. Useful in tests; falls
     *  back to `getForeverTtlMs()` (env-var driven) when omitted. */
    foreverTtlMs?: number;
  };
}

// ── Grant-key → CapabilityExpiryKind mapping ─────────────────────────

/**
 * Map a `grantedAt[key]` slot on `ExtensionPermissions` onto the
 * coarser `CapabilityExpiryKind` taxonomy.
 *
 * The runtime grant record carries one entry per declared permission
 * field (`network`, `filesystem`, `shell`, `env`, `storage`,
 * `taskEvents`, `appendMessages`, `eventSubscriptions`, `spawnAgents`,
 * `agentConfig`, `llm`, `memory`, `lessons`, `schedule`). Only a
 * subset of these have an expiry policy in the design doc; the rest
 * return `null` (sweep skips them silently — `eventSubscriptions`,
 * `spawnAgents`, `agentConfig` are infrastructure plumbing, not
 * privacy/safety boundaries that warrant re-prompting).
 *
 * Filesystem note: the grant-record key is plain `"filesystem"` with
 * no read/write distinction — that distinction lives on the manifest's
 * tool entries, not on the install-time grant. For the v1 sweep we
 * conservatively treat all `filesystem` grant entries as the more
 * restrictive `filesystem-write` TTL (30 days), so a write-capable
 * install is not silently held to the longer 90-day read-only TTL.
 * If a Phase-N follow-up adds a per-mode grant record key, this
 * helper updates with it.
 */
export function mapGrantKeyToExpiryKind(
  grantKey: string,
): CapabilityExpiryKind | null {
  switch (grantKey) {
    case "network":
      return "network";
    case "filesystem":
      // Conservative: treat any filesystem grant as write-tier (30d).
      // Per-mode grant keys are not a Phase 2 contract addition.
      return "filesystem-write";
    case "shell":
      return "shell";
    case "env":
      return "env";
    case "storage":
      return "storage";
    case "taskEvents":
      return "taskEvents";
    case "appendMessages":
      return "appendMessages";
    case "llm":
      return "llm";
    case "memory":
      return "memory";
    case "lessons":
      return "lessons";
    case "schedule":
      return "schedule";
    // Plumbing keys without an expiry policy. Returning `null`
    // means the sweep skips them — they live until the extension
    // is uninstalled.
    case "eventSubscriptions":
    case "spawnAgents":
    case "agentConfig":
    case "acceptsCallerCaps":
    case "escalateChildCaps":
      return null;
    default:
      // Unknown key — skip. Don't crash the sweep on a future field
      // that lands without updating this helper. Phase 3's daemon
      // surfaces a "saw unknown key" warning if defensive logging is
      // wanted; Phase 2 stays silent (no production caller yet).
      return null;
  }
}

// ── Always-allow setting-key parser ──────────────────────────────────

/**
 * Parse an always-allow setting key into its scope tuple.
 *
 * The canonical key shape is:
 *   ext:<extensionId>:<userId>:<scope>:<scopeId>:always_allow:<capability>
 *
 * (See `alwaysAllowSettingKey` in `./permissions.ts:206-214`.)
 *
 * Phase 1 also supports a legacy unscoped form for back-compat:
 *   ext:<extensionId>:always_allow:<operationType>
 *
 * The legacy form has no `scope` to age against (and predates the
 * value-shape migration), so `parseAlwaysAllowKey` returns `null` for
 * it — the sweep skips legacy rows. This is locked in the value-shape
 * test (`always-allow-value-shape.test.ts`): legacy `true` is treated
 * as never-expires.
 */
function parseAlwaysAllowKey(
  key: string,
): { extensionId: string; scope: AlwaysAllowScope; capability: string } | null {
  // Quick reject — must contain `:always_allow:` separator.
  if (!key.includes(":always_allow:")) return null;

  const parts = key.split(":");
  // Canonical scoped form has 7 parts:
  //   [0]"ext", [1]extId, [2]userId, [3]scope, [4]scopeId,
  //   [5]"always_allow", [6]capability
  if (parts.length === 7 && parts[0] === "ext" && parts[5] === "always_allow") {
    const scopeRaw = parts[3]!;
    const scope = (
      ["session", "conversation", "project", "forever"] as const
    ).find((s) => s === scopeRaw);
    if (!scope) return null;
    return {
      extensionId: parts[1]!,
      scope,
      capability: parts[6]!,
    };
  }

  // Legacy unscoped — skip via null return (no scope to age).
  return null;
}

/**
 * Map the always-allow `capability` slot (e.g. `"shell"`, `"fs.write"`)
 * onto a {@link CapabilityExpiryKind}. The PDP's always-allow keys use
 * a slightly different namespace than `ExtensionPermissions` — `fs.write`
 * vs `filesystem`, etc. Returns `null` for unknown values.
 *
 * Distinct from {@link mapGrantKeyToExpiryKind}: that helper maps
 * `ExtensionPermissions` field names (e.g. `filesystem`, `network`,
 * `shell`); this helper maps always-allow capability tokens (e.g.
 * `fs.write`, `fs.read`, `network`, `shell`). The namespaces genuinely
 * differ — `parseAlwaysAllowKey` produces tokens carved from the
 * settings-key tail (`"...:always_allow:fs.write"` → `"fs.write"`),
 * whereas `grantedPermissions` keys are the field names declared on
 * `ExtensionPermissions`. Neither type can serve both: e.g. `fs.write`
 * is a valid always-allow capability but not a grantedPermissions key,
 * and `taskEvents` is a grantedPermissions key but never appears as an
 * always-allow capability. Hence two helpers.
 */
function mapAlwaysAllowCapabilityToExpiryKind(
  capability: string,
): CapabilityExpiryKind | null {
  switch (capability) {
    case "shell":
      return "shell";
    case "fs.write":
      return "filesystem-write";
    case "fs.read":
      return "filesystem-read";
    case "network":
      return "network";
    case "env":
      return "env";
    case "llm":
      return "llm";
    case "memory":
      return "memory";
    case "lessons":
      return "lessons";
    case "storage":
      return "storage";
    case "schedule":
      return "schedule";
    case "taskEvents":
      return "taskEvents";
    case "appendMessages":
      return "appendMessages";
    default:
      return null;
  }
}

// ── runSweep ─────────────────────────────────────────────────────────

/**
 * Compute the revocation plan. Pure: reads only, no writes. Returns
 * the empty result on an empty DB.
 *
 * Algorithm:
 *   1. SELECT all enabled extensions. For each row:
 *      - For each key in `grantedPermissions.grantedAt`:
 *        - Map key → CapabilityExpiryKind (skip null).
 *        - Look up TTL (skip "never").
 *        - Compute age = now - grantedAt[key].
 *        - If age >= ttlMs → emit a revocation.
 *
 *   2. SELECT all `settings` rows matching `ext:%:always_allow:%`. For
 *      each row:
 *      - Parse key → (extensionId, scope, capability). Skip legacy
 *        unscoped rows (null).
 *      - Skip session scope (in-memory only).
 *      - Read `parseAlwaysAllowValue` — only `"allowed"` rows are
 *        candidates. Legacy boolean `true` is also `"allowed"` but
 *        has no `grantedAt` → skip (treat as never-expires).
 *      - Map capability → CapabilityExpiryKind. Skip unknowns.
 *      - For `forever` scope, override TTL with the env-var driven
 *        `foreverTtlMs` (locked decision A.6.1 — single global knob).
 *      - Compute age. If aged → emit revocation.
 *
 * Disabled extensions are NOT swept (`enabled = true` filter on the
 * query; see design doc § 4.3 — preserve grants on `disabled`,
 * revoke on `uninstalled` which manifests as the row being absent).
 */
export async function runSweep(inputs: SweepInputs): Promise<SweepResult> {
  const { db, now } = inputs;
  const ttlConfig = inputs.config?.ttlConfig ?? TTL_CONFIG;
  const foreverTtlMs =
    inputs.config?.foreverTtlMs !== undefined
      ? inputs.config.foreverTtlMs
      : getForeverTtlMs();

  const revocations: Revocation[] = [];
  const audits: AuditPlan[] = [];
  const events: ExpiryEvent[] = [];

  // ── 1. Enabled extensions: per-extension grant entries ────────────
  const extRows = (await db
    .select({ id: extensions.id, perms: extensions.grantedPermissions })
    .from(extensions)
    .where(eq(extensions.enabled, true))) as Array<{
    id: string;
    perms: ExtensionPermissions | null;
  }>;

  for (const row of extRows) {
    const perms = row.perms;
    if (!perms?.grantedAt) continue;
    for (const [grantKey, ts] of Object.entries(perms.grantedAt)) {
      if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
      const kind = mapGrantKeyToExpiryKind(grantKey);
      if (!kind) continue;
      const ttl = ttlConfig[kind];
      if (ttl === "never") continue;
      const ageMs = now - ts;
      if (ageMs < ttl) continue;
      revocations.push({
        kind: "extension-grant",
        extensionId: row.id,
        grantKey,
        capability: kind,
        ageMs,
        ttlMs: ttl,
      });
      audits.push({
        userId: null,
        action: EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED,
        target: row.id,
        metadata: {
          capability: kind,
          scope: "extensions-row",
          ttlMs: ttl,
          ageMs,
        },
      });
      events.push({
        type: "perm-expired",
        data: {
          extensionId: row.id,
          capability: kind,
          scope: "extensions-row",
          ageMs,
        },
      });
    }
  }

  // ── 2. Always-allow rows ──────────────────────────────────────────
  const aaRows = (await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(like(settings.key, "ext:%:always_allow:%"))) as Array<{
    key: string;
    value: unknown;
  }>;

  for (const row of aaRows) {
    const parsed = parseAlwaysAllowKey(row.key);
    if (!parsed) continue; // legacy unscoped row — never-expires
    // Per-scope ageing decisions (design doc §4.4 + Phase 1 milestone §A
    // locked decision):
    //   • session       — skipped (in-memory only, restart-bound).
    //   • conversation  — skipped (lifetime-bound; conversation deletion
    //     orphans the row, but ageing it against a per-capability TTL is
    //     wrong: the design contract is "lifetime of conv — sweep doesn't
    //     age it" and orphan cleanup is deferred to v1.5 per design doc
    //     § 2.7).
    //   • project       — per-capability TTL. (Design doc § 2.5 originally
    //     proposed a uniform 30d for project scope, but Phase 1 froze the
    //     per-capability table as the SOLE source of TTL values to keep
    //     the matrix small for v1; Phase 4 may add a per-scope override
    //     knob.)
    //   • forever       — env-var-driven `foreverTtlMs`
    //     (`EZCORP_PERM_FOREVER_TTL_DAYS`, default 90d).
    if (parsed.scope === "session") continue;
    if (parsed.scope === "conversation") continue;
    const decision = parseAlwaysAllowValue(row.value);
    if (decision !== "allowed") continue; // already denied / malformed

    // Legacy boolean `true` is "allowed" but has no `grantedAt` — skip.
    // The new shape always has `grantedAt: number`.
    const v = row.value;
    if (
      !(
        typeof v === "object" &&
        v !== null &&
        !Array.isArray(v) &&
        typeof (v as Record<string, unknown>).grantedAt === "number"
      )
    ) {
      continue;
    }
    const grantedAt = (v as { grantedAt: number }).grantedAt;
    if (!Number.isFinite(grantedAt)) continue;

    const kind = mapAlwaysAllowCapabilityToExpiryKind(parsed.capability);
    if (!kind) continue;

    // Only `project` and `forever` reach here (session + conversation
    // skipped above). `forever` uses the env-driven global TTL;
    // `project` uses the per-capability table.
    const baseTtl = ttlConfig[kind];
    if (baseTtl === "never") continue;
    const ttl = parsed.scope === "forever" ? foreverTtlMs : baseTtl;
    const ageMs = now - grantedAt;
    if (ageMs < ttl) continue;

    revocations.push({
      kind: "always-allow",
      extensionId: parsed.extensionId,
      settingKey: row.key,
      capability: kind,
      scope: parsed.scope,
      ageMs,
      ttlMs: ttl,
    });
    audits.push({
      userId: null,
      action: EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED,
      target: parsed.extensionId,
      metadata: {
        capability: kind,
        scope: parsed.scope,
        ttlMs: ttl,
        ageMs,
      },
    });
    events.push({
      type: "perm-expired",
      data: {
        extensionId: parsed.extensionId,
        capability: kind,
        scope: parsed.scope,
        ageMs,
      },
    });
  }

  return { revocations, audits, events };
}

// ── applySweepResult ─────────────────────────────────────────────────

/**
 * Apply the plan. Each revocation is applied in isolation:
 *
 *   • For `extension-grant`: re-read the extension row under
 *     `SELECT … FOR UPDATE` (works on real Postgres; degrades to a
 *     plain SELECT on PGlite — single-writer in practice). Then
 *     UPDATE with a CHECK clause `WHERE granted_permissions = $orig`
 *     so a concurrent rewrite is detected via `rows-affected = 0`.
 *     The mutation strips the matching `grantedAt[key]` slot AND the
 *     matching permission value (e.g. `network: ["api.x"]` → field
 *     deleted).
 *
 *   • For `always-allow`: re-read the settings row, confirm the value
 *     is still `{allowed: true, grantedAt: <orig>}`, then write
 *     `{allowed: false, grantedAt: <now>}` with a CHECK clause so the
 *     pre-existing value matches what `runSweep` saw. Skipped rows
 *     (concurrent user-approve) re-converge on the next tick.
 *
 * Audit rows are written via `insertAuditEntry` per the design doc
 * § 2.6 contract. Audit-write failures are logged via the existing
 * persistError pipeline (inside `insertAuditEntry`) and never abort
 * the apply — that pitfall #2 invariant is enforced at the audit-log
 * write boundary.
 *
 * The events list is NOT emitted here — the caller (CLI script in
 * Phase 2; daemon + UI listeners in Phase 4) decides what to do with
 * them. Returning events as data keeps this function pure-ish (only
 * DB side effects, no eventbus coupling).
 */
export async function applySweepResult(
  db: any,
  result: SweepResult,
  now: number = Date.now(),
): Promise<ApplyOutcome> {
  let auditCount = 0;
  let appliedCount = 0;
  let skippedConcurrent = 0;
  const errors: ApplyError[] = [];

  // Group revocations by extension so we can batch the per-extension
  // row update — multiple grant keys on one row collapse to a single
  // UPDATE, which is what we want under the CHECK clause (otherwise
  // the second update for the same row would always see "row changed
  // by us" and skip).
  const byExt = new Map<string, Revocation[]>();
  for (const rev of result.revocations) {
    const list = byExt.get(rev.extensionId) ?? [];
    list.push(rev);
    byExt.set(rev.extensionId, list);
  }

  // Audits are written 1:1 with successfully-applied revocations only.
  // Skipped (race-mitigated) revocations do NOT produce an audit row
  // — Phase 4's "expired in last 7 days" banner queries this table,
  // and a phantom row would show the user a re-approve prompt for a
  // grant that's still active.
  const applyAudit = async (rev: Revocation): Promise<void> => {
    const audit: AuditPlan = {
      userId: null,
      action: EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED,
      target: rev.extensionId,
      metadata: {
        capability: rev.capability,
        scope: rev.kind === "always-allow" ? rev.scope : "extensions-row",
        ttlMs: rev.ttlMs,
        ageMs: rev.ageMs,
      },
    };
    const id = await insertAuditEntry(
      audit.userId,
      audit.action,
      audit.target,
      audit.metadata,
    );
    if (id !== "") auditCount++;
  };

  for (const [extensionId, revs] of byExt) {
    // ── extension-grant batch ────────────────────────────────────
    const extGrants = revs.filter(
      (r): r is Extract<Revocation, { kind: "extension-grant" }> =>
        r.kind === "extension-grant",
    );
    if (extGrants.length > 0) {
      try {
        const outcome = await applyExtensionGrants(
          db,
          extensionId,
          extGrants,
          now,
        );
        appliedCount += outcome.applied;
        skippedConcurrent += outcome.skipped;
        // Emit audits for the keys that actually applied. The
        // applyExtensionGrants helper preserves the order of the
        // input revs and reports per-key applied/skipped via
        // appliedRevs.
        for (const rev of outcome.appliedRevs) {
          await applyAudit(rev);
        }
      } catch (err) {
        errors.push({
          extensionId,
          reason: "extension-grant-update-failed",
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── always-allow rows (one-row-per-revocation) ───────────────
    const aaRevs = revs.filter(
      (r): r is Extract<Revocation, { kind: "always-allow" }> =>
        r.kind === "always-allow",
    );
    for (const rev of aaRevs) {
      try {
        const outcome = await applyAlwaysAllowRevocation(db, rev, now);
        if (outcome === "applied") {
          appliedCount++;
          await applyAudit(rev);
        } else if (outcome === "skipped" || outcome === "missing") {
          skippedConcurrent++;
        }
      } catch (err) {
        errors.push({
          extensionId,
          reason: "always-allow-update-failed",
          details: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    audits: auditCount,
    applied: appliedCount,
    skippedConcurrent,
    errors,
  };
}

/**
 * Update a single extension's `granted_permissions` JSON: strip every
 * matching `grantedAt[key]` slot AND every matching permission value,
 * skipping per-key any whose `grantedAt[key]` has been rewritten
 * since `runSweep` saw it.
 *
 * Race-mitigation primitive (per design doc § 4.6): the relevant
 * timestamp is `grantedAt[key]`. If a concurrent user-approve writes
 * a fresh `grantedAt[key]` that no longer satisfies "aged past ttl",
 * the sweep skips that specific key. Other keys on the same row
 * still apply normally — collapsing the multi-key revocation into a
 * single UPDATE with the freshest value as the basis.
 *
 * The UPDATE itself uses a CHECK clause `WHERE granted_permissions =
 * $current` to defend against an even later concurrent rewrite that
 * arrives between the FOR UPDATE read and our write — extremely
 * unlikely under FOR UPDATE on real Postgres, but PGlite's locking
 * is degenerate so the CHECK is belt-and-suspenders.
 *
 * Returns `{applied, skipped}` per-revocation counts.
 */
async function applyExtensionGrants(
  db: any,
  extensionId: string,
  revs: Array<Extract<Revocation, { kind: "extension-grant" }>>,
  now: number,
): Promise<{
  applied: number;
  skipped: number;
  appliedRevs: Array<Extract<Revocation, { kind: "extension-grant" }>>;
}> {
  // Re-read the row under FOR UPDATE. On real Postgres this acquires
  // a row-level lock until the surrounding transaction commits; under
  // PGlite the clause is parsed but locking is degenerate (single-
  // writer). Either way the read returns the freshest value, which
  // is the input to our per-key freshness check below.
  let current: ExtensionPermissions | null = null;
  try {
    const reread = (await db
      .select({ perms: extensions.grantedPermissions })
      .from(extensions)
      .where(eq(extensions.id, extensionId))
      .for("update")) as Array<{ perms: ExtensionPermissions | null }>;
    current = reread[0]?.perms ?? null;
  } catch {
    // PGlite's `.for("update")` rejection is rare but possible if the
    // PG version doesn't support the locking clause. Fall back to a
    // plain SELECT — the per-key freshness check + CHECK clause on
    // UPDATE remain the primary race primitives.
    const reread = (await db
      .select({ perms: extensions.grantedPermissions })
      .from(extensions)
      .where(eq(extensions.id, extensionId))) as Array<{
      perms: ExtensionPermissions | null;
    }>;
    current = reread[0]?.perms ?? null;
  }

  if (!current) {
    // Row vanished between the runSweep read and now — extension was
    // uninstalled. Nothing to do.
    return { applied: 0, skipped: revs.length, appliedRevs: [] };
  }

  // Per-key freshness check: build the next value, but skip any key
  // whose grantedAt has been rewritten with a value no longer aged
  // past TTL. Track applied vs. skipped counts.
  const nextGrantedAt = { ...(current.grantedAt ?? {}) };
  // Dynamic field deletes on the typed `ExtensionPermissions` shape:
  // not all keys are present on every row, and the type-system can't
  // narrow on string-typed `grantKey` here. Repo-wide
  // `noExplicitAny` is off (mirrors `connection.ts:31`).
  const nextWorking: any = { ...current, grantedAt: nextGrantedAt };
  const appliedRevs: Array<Extract<Revocation, { kind: "extension-grant" }>> =
    [];
  let skippedKeys = 0;
  for (const rev of revs) {
    const curTs = nextGrantedAt[rev.grantKey];
    if (typeof curTs !== "number" || !Number.isFinite(curTs)) {
      // Key already gone (idempotent re-run) or never existed (FK-
      // dropped row) — skip.
      skippedKeys++;
      continue;
    }
    if (now - curTs < rev.ttlMs) {
      // Concurrent rewrite produced a fresher grantedAt that's still
      // within TTL. Don't revoke; sweep will re-converge if/when the
      // new timestamp also ages out.
      skippedKeys++;
      continue;
    }
    // Strip both the grantedAt entry and the matching permission
    // slot (e.g. `network: ["api.x"]` → field deleted).
    delete nextGrantedAt[rev.grantKey];
    if (rev.grantKey in nextWorking) {
      delete nextWorking[rev.grantKey];
    }
    appliedRevs.push(rev);
  }

  if (appliedRevs.length === 0) {
    return { applied: 0, skipped: skippedKeys, appliedRevs: [] };
  }

  // Persist as a typed `ExtensionPermissions` value.
  const next = nextWorking as ExtensionPermissions;

  // CHECK clause UPDATE — only commit if granted_permissions still
  // matches what we just re-read under FOR UPDATE. Catches the
  // double-race (a third concurrent writer between FOR UPDATE and
  // our UPDATE), which is theoretical on PG but worth the seatbelt.
  // Importantly, the per-key freshness check above is what defends
  // against a user-approve that landed between `runSweep` and the
  // FOR UPDATE re-read.
  const updated = await db
    .update(extensions)
    .set({
      grantedPermissions: sql`${JSON.stringify(next)}::jsonb`,
      updatedAt: sql`NOW()`,
    })
    .where(
      and(
        eq(extensions.id, extensionId),
        sql`${extensions.grantedPermissions} = ${JSON.stringify(current)}::jsonb`,
      ),
    )
    .returning({ id: extensions.id });

  if (updated.length === 0) {
    // The row changed between FOR UPDATE and our UPDATE. Treat all
    // attempted keys as skipped — sweep re-converges next tick.
    return { applied: 0, skipped: revs.length, appliedRevs: [] };
  }
  return {
    applied: appliedRevs.length,
    skipped: skippedKeys,
    appliedRevs,
  };
}

/**
 * Apply a single always-allow revocation. Per design doc § 2.6:
 * replace the value with `{allowed: false, grantedAt: <now>}` (an
 * explicit deny). Race-mitigated via the CHECK clause on the UPDATE
 * so a concurrent user-approve doesn't get clobbered.
 *
 * Returns `"applied" | "skipped" | "missing"`. `missing` collapses to
 * `skipped` at the call site for simplicity; both mean "nothing was
 * mutated".
 */
async function applyAlwaysAllowRevocation(
  db: any,
  rev: Extract<Revocation, { kind: "always-allow" }>,
  now: number,
): Promise<"applied" | "skipped" | "missing"> {
  // Re-read under FOR UPDATE (PGlite may degenerate; CHECK clause is
  // the primary primitive).
  let current: unknown;
  try {
    const reread = (await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, rev.settingKey))
      .for("update")) as Array<{ value: unknown }>;
    current = reread[0]?.value;
  } catch {
    const reread = (await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, rev.settingKey))) as Array<{ value: unknown }>;
    current = reread[0]?.value;
  }
  if (current === undefined) return "missing";

  // Confirm the row is still in the shape we planned to revoke. If
  // the user just toggled it (legacy `true`, or a fresh
  // `{allowed: true, grantedAt: <newer>}`), we'd still want to
  // respect that — but the design doc's race-mitigation contract is
  // "skip on mismatch, re-converge next tick". So check structural
  // equality on the value we read at runSweep time vs. now: if the
  // serialized form differs, skip.
  //
  // We don't have the original-read value threaded through (the plan
  // doesn't carry it — it's not part of the revocation's addressable
  // handle). Instead we use the plan's `ageMs + ttlMs` as a stand-in:
  // if the current value is the new shape AND its grantedAt computes
  // to an age >= ttlMs against `now`, we proceed. Any other shape
  // (legacy boolean, malformed, freshly written) means "skip".
  if (
    !(
      typeof current === "object" &&
      current !== null &&
      !Array.isArray(current) &&
      typeof (current as Record<string, unknown>).allowed === "boolean" &&
      typeof (current as Record<string, unknown>).grantedAt === "number"
    )
  ) {
    return "skipped";
  }
  const cur = current as { allowed: boolean; grantedAt: number };
  if (!cur.allowed) return "skipped"; // already denied
  // Concurrent user-approve detection: the value was rewritten with a
  // newer grantedAt that's still within TTL. Skip — sweep re-converges
  // when this newer value also ages out.
  if (now - cur.grantedAt < rev.ttlMs) return "skipped";

  const next = { allowed: false, grantedAt: now };
  const updated = await db
    .update(settings)
    .set({ value: sql`${JSON.stringify(next)}::jsonb`, updatedAt: sql`NOW()` })
    .where(
      and(
        eq(settings.key, rev.settingKey),
        sql`${settings.value} = ${JSON.stringify(cur)}::jsonb`,
      ),
    )
    .returning({ key: settings.key });
  return updated.length > 0 ? "applied" : "skipped";
}
