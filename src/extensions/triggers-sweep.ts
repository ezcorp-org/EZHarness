/**
 * Dynamic-trigger lifecycle sweeps (C2).
 *
 * The failure mode this file exists to prevent is an ORPHANED TRIGGER THAT
 * STILL FIRES — a cron row whose job the user deleted, waking a subprocess
 * every Monday forever to run nothing, or worse to run a stale definition.
 *
 * Unregistering is the extension's job (`ctx.triggers.unregister`), but a
 * design that depends on the extension behaving is not a design. So the
 * host runs its own reconciliation on extension start: it tells the
 * extension which keys it holds and asks which are still live.
 *
 * ── The fail-open rule (load-bearing) ─────────────────────────────────
 *
 * If the extension cannot answer — no `ezcorp/triggers-sync` handler
 * (`-32601`), a transport failure, a malformed reply — the sweep disables
 * NOTHING and says so.
 *
 * Reading "no handler" as "the extension claims zero live keys" would wipe
 * every user's triggers on any SDK or extension version skew: ship an
 * extension built against an older SDK, restart, and every job silently
 * stops firing. That is the same silent-kill class as the reconciler hazard
 * this phase already had to fix, just triggered by an upgrade instead of a
 * reconcile. An orphan that keeps firing is a bounded, visible waste; a
 * mass disable is unbounded and invisible.
 *
 * Sweeps are OWNERLESS (no user initiated them), so they audit to
 * `audit_log`, whose `user_id` is nullable — `sdk_capability_calls` has a
 * NOT NULL `on_behalf_of` and structurally cannot record them.
 */
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";
import {
  listDynamicCrons, listDynamicWebhooks,
  disableDynamicCrons, disableDynamicWebhooks,
} from "./triggers-store";
import { extensionLogger } from "../logger";

const log = extensionLogger("triggers", "sweep");

/** Minimal view of a live subprocess — just the host→extension request. */
export interface SyncTarget {
  call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ result?: unknown; error?: { code: number; message: string } }>;
}

export interface SweepResult {
  /** How many rows were soft-disabled. */
  disabled: number;
  /** True when the sweep declined to act (see the fail-open rule). */
  skipped: boolean;
  /** Why it declined, for the operator. */
  reason?: string;
}

/** Parse the extension's reply into a claimed-key set, or `null` when the
 *  reply is not something we can safely act on. `null` means fail open. */
export function parseClaimedKeys(result: unknown): Set<string> | null {
  if (!result || typeof result !== "object") return null;
  const keys = (result as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return null;
  if (!keys.every((k) => typeof k === "string")) return null;
  return new Set(keys as string[]);
}

/**
 * Reconcile the host's dynamic rows against the keys the extension still
 * claims. Soft-disables the difference; rows and history are preserved.
 */
export async function syncDynamicTriggers(
  extensionId: string,
  extensionName: string,
  proc: SyncTarget | null | undefined,
  now: Date = new Date(),
): Promise<SweepResult> {
  const crons = await listDynamicCrons(extensionId);
  const hooks = await listDynamicWebhooks(extensionName);
  const cronKeys = crons.filter((r) => r.enabled).map((r) => r.key as string);
  const hookKeys = hooks.filter((r) => r.enabled).map((r) => r.key as string);
  if (cronKeys.length === 0 && hookKeys.length === 0) {
    return { disabled: 0, skipped: false };
  }

  if (!proc) {
    return { disabled: 0, skipped: true, reason: "subprocess-not-running" };
  }

  let response: { result?: unknown; error?: { code: number; message: string } };
  try {
    response = await proc.call("ezcorp/triggers-sync", {
      v: 1,
      keys: [...cronKeys, ...hookKeys],
    });
  } catch (err) {
    // Transport failure / timeout. Fail open.
    return { disabled: 0, skipped: true, reason: `call-failed: ${String(err)}` };
  }

  if (response.error) {
    // `-32601 Method not found` is the common case: the extension predates
    // `ctx.triggers` or has wired no handlers yet. NOT evidence that its
    // jobs are dead.
    return {
      disabled: 0,
      skipped: true,
      reason: `no-sync-handler: ${response.error.code}`,
    };
  }

  const claimed = parseClaimedKeys(response.result);
  if (claimed === null) {
    return { disabled: 0, skipped: true, reason: "malformed-reply" };
  }

  const orphanedCrons = cronKeys.filter((k) => !claimed.has(k));
  const orphanedHooks = hookKeys.filter((k) => !claimed.has(k));
  if (orphanedCrons.length === 0 && orphanedHooks.length === 0) {
    return { disabled: 0, skipped: false };
  }

  const disabled =
    (await disableDynamicCrons(extensionId, orphanedCrons, now)) +
    (await disableDynamicWebhooks(extensionName, orphanedHooks, now));

  // One audit row per key — an operator needs to know WHICH job stopped,
  // not just that some number of them did.
  for (const key of orphanedCrons) {
    await auditOrphan(extensionId, "cron", key);
  }
  for (const key of orphanedHooks) {
    await auditOrphan(extensionId, "webhook", key);
  }

  log.info("orphaned dynamic triggers disabled", {
    extensionId, disabled, cron: orphanedCrons.length, webhook: orphanedHooks.length,
  });
  return { disabled, skipped: false };
}

/**
 * The `permissions.triggers` capability itself disappeared from the
 * manifest (§2.2 case 3). Soft-disable EVERY dynamic row.
 *
 * This is the one case where disabling a user-created trigger is correct —
 * the capability that authorized it is gone. It is an EXPLICIT sweep, never
 * a side effect of ordinary reconciliation: the reconcilers' `dynamic =
 * false` filter means they can no longer touch these rows at all, which is
 * exactly what makes an intentional revocation distinguishable from a
 * routine manifest edit.
 *
 * Narrowing a cap is NOT this. Lowering `maxCron` below the current row
 * count leaves existing rows running and refuses only NEW registrations —
 * never silently disable rows a user created under a larger cap.
 */
export async function revokeDynamicTriggers(
  extensionId: string,
  extensionName: string,
  now: Date = new Date(),
): Promise<{ disabled: number }> {
  const cronKeys = (await listDynamicCrons(extensionId))
    .filter((r) => r.enabled).map((r) => r.key as string);
  const hookKeys = (await listDynamicWebhooks(extensionName))
    .filter((r) => r.enabled).map((r) => r.key as string);
  if (cronKeys.length === 0 && hookKeys.length === 0) return { disabled: 0 };

  const disabled =
    (await disableDynamicCrons(extensionId, cronKeys, now)) +
    (await disableDynamicWebhooks(extensionName, hookKeys, now));

  for (const key of [...cronKeys, ...hookKeys]) {
    await insertAuditEntry(
      null,
      EXT_AUDIT_ACTIONS.SDK_TRIGGER_CAPABILITY_REVOKED,
      extensionId,
      {
        capability: "triggers",
        oldValue: { enabled: true },
        newValue: { enabled: false, key },
        actor: "system",
        reason: "permissions.triggers removed from the manifest",
      },
    );
  }
  log.info("dynamic triggers revoked with the capability", { extensionId, disabled });
  return { disabled };
}

async function auditOrphan(
  extensionId: string,
  kind: "cron" | "webhook",
  key: string,
): Promise<void> {
  await insertAuditEntry(
    null,
    EXT_AUDIT_ACTIONS.SDK_TRIGGER_ORPHANED,
    extensionId,
    {
      capability: "triggers",
      oldValue: { enabled: true },
      newValue: { enabled: false, kind, key },
      actor: "system",
      reason: "extension no longer claims this trigger key",
    },
  );
}
