// ── Audit log — append-only control-plane trail (spec L5) ────────────
//
// An append-only trail of everything done in the control plane: run lifecycle
// transitions, triage actions (who approved/skipped/fixed/aborted/yolo'd), job
// create/edit/enable/disable, run-now fires, push-ignored, and sweep outcomes.
// Browsable at `?view=audit`.
//
// Storage model (mirrors lib/runs.ts): the SDK `Storage("global")` bucket —
// gate activity is system/CI-like and renders on the SHARED Hub, which serves
// the global scope only. Key family `audit/<YYYY-MM-DD>` (UTC day buckets),
// each an append array capped at 500 entries. On overflow we DROP-OLDEST and
// stamp a first-entry `{kind:"truncated", dropped:<n>}` marker so the truncation
// is never silent. A bucket write failure NEVER fails the action that produced
// it (record-and-continue via `logLine`, the same discipline as step_io).
//
// Privacy (same rule as step IO): NO conversation content, NO prompts. Entries
// carry ids + deep-links only. `detail` is clamped to <= 2 KB per entry.

import { Storage, withLock } from "@ezcorp/sdk/runtime";
import type { StorageScope } from "@ezcorp/sdk/runtime";
import { logLine } from "./log";

const AUDIT_KEY_PREFIX = "audit/";
/** Per-day read-modify-write lock (mirrors the run-index lock). */
const AUDIT_LOCK = "ez-code-factory:audit-log";

/** Max entries retained per UTC day bucket before drop-oldest kicks in. */
export const AUDIT_BUCKET_CAP = 500;
/** Max serialized `detail` size per entry (defence-in-depth against a bloated
 *  diff). Over-cap details are replaced with a truncation preview. */
export const AUDIT_DETAIL_MAX_BYTES = 2048;

/** One audit trail entry. `actor` is a full user id (`event.userId`) for page
 *  actions, or `"system"` for lifecycle/sweep/seed. Findings are referenced by
 *  id, never restated; NO prompt / conversation content ever lands here. */
export interface AuditEntry {
  /** ISO timestamp the entry was recorded. */
  at: string;
  /** Full user id for page actions, `"system"` for lifecycle/sweep/seed. */
  actor: string;
  /** Action kind, e.g. `run-status`, `respond`, `job-save`, `push-ignored`. */
  kind: string;
  jobId?: string;
  runId?: string;
  step?: string;
  /** Structured, id-only detail (job field diff, sweep counts, …). Clamped. */
  detail?: unknown;
}

/** The first-entry marker stamped into a bucket that overflowed the cap. */
export interface AuditTruncationMarker {
  kind: "truncated";
  dropped: number;
  at: string;
}

/** A stored bucket is a mixed array: an optional leading truncation marker
 *  followed by `AuditEntry`s (oldest first). */
export type AuditBucket = Array<AuditEntry | AuditTruncationMarker>;

/** The UTC day-bucket storage key for an instant (`audit/YYYY-MM-DD`). */
export function auditDayKey(at: Date): string {
  return `${AUDIT_KEY_PREFIX}${at.toISOString().slice(0, 10)}`;
}

/** True for the leading `{kind:"truncated"}` marker (vs a real entry). */
export function isTruncationMarker(e: AuditEntry | AuditTruncationMarker): e is AuditTruncationMarker {
  return (e as AuditTruncationMarker).kind === "truncated" && typeof (e as AuditTruncationMarker).dropped === "number";
}

/** Clamp `detail` to <= AUDIT_DETAIL_MAX_BYTES serialized. Over-cap values are
 *  replaced with a `{truncated:true, preview}` object so a bloated field can
 *  never blow the bucket. `undefined` passes through (omitted on store). */
export function clampAuditDetail(detail: unknown): unknown {
  if (detail === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(detail);
  } catch {
    return { truncated: true, preview: "[unserializable detail]" };
  }
  if (serialized === undefined || serialized.length <= AUDIT_DETAIL_MAX_BYTES) return detail;
  return { truncated: true, preview: serialized.slice(0, AUDIT_DETAIL_MAX_BYTES) };
}

/**
 * PURE cap logic: append `entry` to `bucket` and enforce the 500-entry cap by
 * dropping the oldest REAL entries, coalescing the count into a single leading
 * `{kind:"truncated", dropped:n}` marker. Exported for direct unit coverage
 * (no storage round-trip needed). The marker itself does not count toward the
 * cap of real entries — a full bucket holds exactly `cap` entries plus (at
 * most) the one marker.
 */
export function appendWithCap(
  bucket: AuditBucket,
  entry: AuditEntry,
  cap: number = AUDIT_BUCKET_CAP,
): AuditBucket {
  // Split any existing marker from the real entries.
  let priorDropped = 0;
  const entries: AuditEntry[] = [];
  for (const e of bucket) {
    if (isTruncationMarker(e)) priorDropped += e.dropped;
    else entries.push(e);
  }
  entries.push(entry);

  if (entries.length <= cap) {
    // No overflow — preserve an existing marker if there was one.
    return priorDropped > 0
      ? [{ kind: "truncated", dropped: priorDropped, at: entry.at }, ...entries]
      : entries;
  }

  // Overflow: drop the oldest real entries down to `cap`, accumulate the count.
  const dropCount = entries.length - cap;
  const kept = entries.slice(dropCount);
  const dropped = priorDropped + dropCount;
  return [{ kind: "truncated", dropped, at: entry.at }, ...kept];
}

/** Append + per-day read for the control-plane audit trail. */
export interface AuditLog {
  /** Append one entry to today's (or the entry's `at`) UTC bucket. Never
   *  throws — a write failure is logged + swallowed (the action must not fail
   *  because its audit line didn't land). */
  append(entry: Omit<AuditEntry, "at"> & { at?: string }): Promise<void>;
  /** Read one day's bucket (`YYYY-MM-DD`), oldest-first (marker leads). */
  readDay(day: string): Promise<AuditBucket>;
  /** List the `YYYY-MM-DD` day keys that have buckets, newest-first. */
  listDays(): Promise<string[]>;
}

/** A `Storage`-backed AuditLog for the given scope (default global). */
export function createAuditLog(scope: StorageScope = "global"): AuditLog {
  const storage = new Storage(scope);
  return {
    async append(input) {
      const at = input.at ?? new Date().toISOString();
      const entry: AuditEntry = {
        at,
        actor: input.actor,
        kind: input.kind,
        ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.step !== undefined ? { step: input.step } : {}),
        ...(input.detail !== undefined ? { detail: clampAuditDetail(input.detail) } : {}),
      };
      const key = auditDayKey(new Date(at));
      try {
        await withLock(AUDIT_LOCK, async () => {
          const r = await storage.get<AuditBucket>(key);
          const bucket = Array.isArray(r.value) ? r.value : [];
          await storage.set(key, appendWithCap(bucket, entry));
        });
      } catch (err) {
        // Record-and-continue: an audit write must NEVER fail the action.
        logLine(`ez-code-factory[audit]: append failed (${entry.kind}): ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    async readDay(day) {
      const r = await storage.get<AuditBucket>(`${AUDIT_KEY_PREFIX}${day}`);
      return Array.isArray(r.value) ? r.value : [];
    },
    async listDays() {
      const { keys } = await storage.list({ prefix: AUDIT_KEY_PREFIX });
      return keys
        .map((k) => (k.startsWith(AUDIT_KEY_PREFIX) ? k.slice(AUDIT_KEY_PREFIX.length) : k))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    },
  };
}
