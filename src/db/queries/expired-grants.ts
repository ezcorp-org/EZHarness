/**
 * Phase 4 (capability-expiry) — query helper for the settings-page
 * banner. Returns the audit rows the sweep wrote when it revoked an
 * expired grant, scoped to a single extension and a configurable
 * lookback window (default: 7 days per design doc § 3.1).
 *
 * Why a dedicated helper rather than inlining at the route:
 *   • The audit_log filter shape (`target = $extensionId AND
 *     action = 'ext:permission-grant-expired' AND createdAt > $since`)
 *     is the contract the banner consumes. Pinning it here keeps the
 *     contract testable (`expired-grants.test.ts`) and means the API
 *     route is a thin shape-mapper.
 *   • The metadata projection (`capability`, `ageMs` from the audit
 *     row's metadata; `expiredAt` from createdAt) shifts column→prop
 *     mapping out of the route.
 *
 * The audit row contract (Phase 2 — see
 * `src/extensions/perm-expiry-sweep.ts:435-444`):
 *   {
 *     userId:   null,             // sweep is system-actor
 *     action:   "ext:permission-grant-expired",
 *     target:   <extensionId>,
 *     metadata: {
 *       capability: CapabilityExpiryKind,
 *       scope:      AlwaysAllowScope | "extensions-row",
 *       ttlMs:      number,
 *       ageMs:      number,
 *     },
 *   }
 */

import { and, eq, gt, desc } from "drizzle-orm";
import { getDb } from "../connection";
import { auditLog } from "../schema";
import { EXT_AUDIT_ACTIONS } from "../../extensions/audit-actions";
import type { CapabilityExpiryKind } from "../../extensions/perm-expiry-config";

/**
 * One row in the banner. `auditId` is the underlying audit_log id —
 * used as the keyed-each marker in the Svelte component AND as a
 * stable handle should a future admin "dismiss row" action need to
 * record the dismissal against the original audit row.
 *
 * `expiredAt` is unix-ms (not ISO) so the banner's age-bucketing logic
 * stays in lockstep with the modal copy (which receives `ageMs`
 * directly, no string parsing).
 */
export interface ExpiredGrantRow {
  auditId: string;
  extensionId: string;
  capability: CapabilityExpiryKind;
  ageMs: number;
  expiredAt: number; // unix ms (audit_log.createdAt)
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fetch expired-grant audit rows for a single extension within a
 * lookback window. Defaults to the last 7 days per design doc § 3.1.
 *
 * Ordering: most-recent first (matches the banner's "recent
 * expirations" framing — newest sweep result on top).
 *
 * @param extensionId  The extension whose recent expirations to list.
 * @param opts.now     Current epoch ms. Injected for tests.
 *                     Defaults to `Date.now()`.
 * @param opts.lookbackMs  Lookback window in ms. Defaults to 7 days.
 * @param opts.limit   Max rows. Defaults to 100 — generous; banner
 *                     truncates client-side if needed.
 */
export async function listExpiredGrantsForExtension(
  extensionId: string,
  opts?: {
    now?: number;
    lookbackMs?: number;
    limit?: number;
  },
): Promise<ExpiredGrantRow[]> {
  const now = opts?.now ?? Date.now();
  const lookbackMs = opts?.lookbackMs ?? SEVEN_DAYS_MS;
  const limit = opts?.limit ?? 100;
  const since = new Date(now - lookbackMs);

  const rows = await getDb()
    .select({
      id: auditLog.id,
      target: auditLog.target,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, EXT_AUDIT_ACTIONS.PERM_GRANT_EXPIRED),
        eq(auditLog.target, extensionId),
        gt(auditLog.createdAt, since),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);

  // Project rows onto the banner shape. Rows with malformed metadata
  // (missing capability/ageMs) are skipped silently — the audit
  // contract is set in Phase 2 and a malformed row is itself a
  // governance signal, but the banner shouldn't render garbled rows
  // for users.
  const out: ExpiredGrantRow[] = [];
  for (const row of rows) {
    const meta = row.metadata as Record<string, unknown> | null;
    if (!meta) continue;
    const capability = meta.capability;
    const ageMs = meta.ageMs;
    if (typeof capability !== "string" || capability.length === 0) continue;
    if (typeof ageMs !== "number" || !Number.isFinite(ageMs)) continue;
    out.push({
      auditId: row.id,
      extensionId: (row.target ?? extensionId) as string,
      capability: capability as CapabilityExpiryKind,
      ageMs,
      expiredAt: row.createdAt.getTime(),
    });
  }
  return out;
}
