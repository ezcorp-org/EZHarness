// ── ez-factory audit trail — append-only, id-only (invariant I) ──────
//
// Every console mutation gets one line: who, when, which job, which fields
// moved. Nothing else. Ported from `docs/extensions/examples/ez-code-factory/
// lib/audit.ts` with one deliberate tightening, described below.
//
// ── THE FOUR PROPERTIES (invariant I) ───────────────────────────────
//
//   1. NO CONTENT. Entries carry ids and FIELD NAMES only. Never a prompt,
//      never a job input VALUE, never anything an agent produced. The
//      reference clamps `detail` and calls that enough; this port goes one
//      step further because the risky field here is different — see
//      `auditableJobDiff` below.
//   2. CLAMPED. `detail` is capped at {@link AUDIT_DETAIL_MAX_BYTES}
//      serialized; over-cap values are REPLACED with a truncation preview
//      so one bloated field can never blow the day bucket.
//   3. DROP-OLDEST WITH A VISIBLE MARKER. A full bucket sheds its oldest
//      real entries and stamps a leading `{kind:"truncated", dropped:n}`
//      marker. A trail that silently forgets is worse than no trail: the
//      marker is what stops "no entry" from being read as "nothing
//      happened".
//   4. A BUCKET WRITE FAILURE NEVER FAILS THE ACTION IT RECORDS. Storage is
//      a reverse-RPC round trip and can fail for reasons that have nothing
//      to do with the operator's save. Record-and-continue: the sink hears
//      about it, the caller does not.
//
// ── WHY `auditableJobDiff` AND NOT `diffJob` ────────────────────────
//
// `diffJob` (lib/jobs.ts) returns `{field: {from, to}}` — the VALUES. That
// shape is right for showing an operator what they are about to change, and
// wrong for a durable trail: a `draft-and-verify` job's `input.draft` is a
// whole document, and `input.globs` / `input.outPath` are filesystem paths
// that describe someone's project layout. Writing either into a 30-day
// bucket is exactly the "no prompt content" rule failing by accident rather
// than by decision. So the audit records the SORTED FIELD NAMES that moved
// and nothing else: enough to reconstruct what happened from the job's own
// history, never enough to reconstruct its content.
//
// Clamping alone would not have caught this — a 40-character `outPath`
// serializes well under 2 KB and would have been stored verbatim.
//
// ── STORAGE ─────────────────────────────────────────────────────────
//
// The SDK's `Storage("global")` bucket, key family `audit/<YYYY-MM-DD>`
// (UTC day buckets), each an append array capped at
// {@link AUDIT_BUCKET_CAP}. Jobs are install-wide (see lib/jobs.ts), so
// their trail is too. Every read-modify-write runs inside `withLock` — the
// subprocess channel dispatches inbound frames fire-and-forget, so two
// concurrent saves would otherwise interleave and the second `set` would
// silently discard the first's line.

import { Storage, withLock } from "@ezcorp/sdk/runtime";
import type { StorageScope } from "@ezcorp/sdk/runtime";

import { DIFFABLE_FIELDS, type FactoryJob } from "./jobs";

const AUDIT_KEY_PREFIX = "audit/";

/** Per-day read-modify-write lock. Namespaced like the job store's: `withLock`
 *  keys are process-global across every module the extension loads, so a bare
 *  `"audit"` would serialize against an unrelated module's `"audit"`. */
const AUDIT_LOCK = "ez-factory:audit-log";

/** Max real entries retained per UTC day bucket before drop-oldest kicks in. */
export const AUDIT_BUCKET_CAP = 500;

/** Max serialized `detail` size per entry. Defence in depth: the entry
 *  builders already emit field NAMES rather than values, so nothing should
 *  approach this — the clamp is what makes that a bound rather than a habit. */
export const AUDIT_DETAIL_MAX_BYTES = 2048;

/** Buckets older than this many UTC days are pruned. */
export const AUDIT_RETENTION_DAYS = 30;

/** The actor recorded for anything the host did on its own. */
export const SYSTEM_ACTOR = "system";

/**
 * One audit trail entry.
 *
 * `actor` is a full user id (`event.userId`) for page actions, or
 * {@link SYSTEM_ACTOR}. It is stored but NEVER rendered into the Hub tree —
 * that tree is shared and cached across every viewer (invariant K), so the
 * trail lives in storage and the page does not show it.
 */
export interface AuditEntry {
  /** ISO timestamp the entry was recorded. */
  at: string;
  /** Full user id for page actions, {@link SYSTEM_ACTOR} otherwise. */
  actor: string;
  /** Action kind — `job-create`, `job-save`, `job-rejected`. */
  kind: string;
  /** The job the entry is about, when there is one. */
  jobId?: string;
  /** Structured, CONTENT-FREE detail (changed field names, a rejection
   *  reason code, counts). Clamped by {@link clampAuditDetail}. */
  detail?: unknown;
}

/** The first-entry marker stamped into a bucket that overflowed the cap. */
export interface AuditTruncationMarker {
  kind: "truncated";
  dropped: number;
  at: string;
}

/** A stored bucket: an optional leading truncation marker followed by
 *  `AuditEntry`s, oldest first. */
export type AuditBucket = Array<AuditEntry | AuditTruncationMarker>;

/** The UTC day-bucket storage key for an instant (`audit/YYYY-MM-DD`). */
export function auditDayKey(at: Date): string {
  return `${AUDIT_KEY_PREFIX}${at.toISOString().slice(0, 10)}`;
}

/** True for the leading `{kind:"truncated"}` marker (vs a real entry). */
export function isTruncationMarker(
  e: AuditEntry | AuditTruncationMarker,
): e is AuditTruncationMarker {
  const m = e as AuditTruncationMarker;
  return m.kind === "truncated" && typeof m.dropped === "number";
}

/**
 * The CONTENT-FREE shape of a job edit: the sorted names of the editable
 * fields that changed, and nothing about what they changed to.
 *
 * This is the whole of invariant I's "no prompt content" rule at the one
 * place it could realistically be broken. See the module header for why
 * `diffJob`'s `{from, to}` payload is deliberately not what lands here.
 */
export function auditableJobDiff(before: FactoryJob, after: FactoryJob): string[] {
  const changed: string[] = [];
  for (const field of DIFFABLE_FIELDS) {
    if (JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null)) {
      changed.push(field);
    }
  }
  return changed.sort();
}

/**
 * Clamp `detail` to <= {@link AUDIT_DETAIL_MAX_BYTES} serialized. Over-cap
 * values are replaced with `{truncated:true, preview}` so a bloated field can
 * never blow the bucket. `undefined` passes through (omitted on store); an
 * unserializable value degrades to a marker rather than throwing, because an
 * audit line must never be the thing that fails a save.
 */
export function clampAuditDetail(detail: unknown): unknown {
  if (detail === undefined) return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(detail);
  } catch {
    return { truncated: true, preview: "[unserializable detail]" };
  }
  // `JSON.stringify(undefined)` is `undefined` — a value that is neither
  // over-cap nor storable as-is. Pass it through unchanged; the entry builder
  // omits an undefined `detail`.
  if (serialized === undefined || serialized.length <= AUDIT_DETAIL_MAX_BYTES) {
    return detail;
  }
  return { truncated: true, preview: serialized.slice(0, AUDIT_DETAIL_MAX_BYTES) };
}

/**
 * PURE cap logic: append `entry` to `bucket` and enforce the cap by dropping
 * the OLDEST real entries, coalescing the count into a single leading
 * `{kind:"truncated", dropped:n}` marker.
 *
 * The marker does not count toward the cap of real entries — a full bucket
 * holds exactly `cap` entries plus (at most) the one marker. Exported for
 * direct unit coverage with no storage round trip.
 */
export function appendWithCap(
  bucket: AuditBucket,
  entry: AuditEntry,
  cap: number = AUDIT_BUCKET_CAP,
): AuditBucket {
  let priorDropped = 0;
  const entries: AuditEntry[] = [];
  for (const e of bucket) {
    if (isTruncationMarker(e)) priorDropped += e.dropped;
    else entries.push(e);
  }
  entries.push(entry);

  if (entries.length <= cap) {
    // No overflow — but preserve an existing marker, or a bucket that
    // overflowed yesterday would quietly forget that it ever did.
    return priorDropped > 0
      ? [{ kind: "truncated", dropped: priorDropped, at: entry.at }, ...entries]
      : entries;
  }

  const dropCount = entries.length - cap;
  return [
    { kind: "truncated", dropped: priorDropped + dropCount, at: entry.at },
    ...entries.slice(dropCount),
  ];
}

/** PURE: which `YYYY-MM-DD` day keys fall outside the retention window ending
 *  at `now` — strictly older than `now - retentionDays`. */
export function auditDaysToPrune(
  days: readonly string[],
  now: Date,
  retentionDays: number,
): string[] {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffDay = cutoff.toISOString().slice(0, 10);
  return days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoffDay);
}

/** Where a swallowed audit-write failure is reported. */
export type AuditErrorSink = (message: string) => void;

/**
 * The default sink: the sandbox-safe Bun stderr writer.
 *
 * NOT `process.stderr` — the sandbox preload poisons `node:fs`, and
 * `process.stderr.write` lazily constructs a `node:fs` WriteStream for stdio
 * init, so the first call throws and takes the subprocess down. `Bun.stderr`
 * is not gated by the poison; it is the same guarantee the SDK's channel
 * relies on for `Bun.stdout`. Stderr specifically, never stdout — the
 * JSON-RPC channel owns stdout.
 */
export function auditStderrSink(message: string): void {
  const writer = Bun.stderr.writer();
  writer.write(`${message}\n`);
  // Best-effort flush, mirroring the SDK channel: back-pressure the next call
  // rather than await here.
  void writer.flush();
}

/** Append + per-day read + retention for the console's audit trail. */
export interface AuditLog {
  /** Append one entry to the UTC bucket for `at` (default: now). NEVER
   *  throws — property 4 in the module header. */
  append(entry: Omit<AuditEntry, "at"> & { at?: string }): Promise<void>;
  /** Read one day's bucket (`YYYY-MM-DD`), oldest first (marker leads). */
  readDay(day: string): Promise<AuditBucket>;
  /** The `YYYY-MM-DD` day keys that have buckets, newest first. */
  listDays(): Promise<string[]>;
  /** Prune buckets older than `retentionDays` UTC days before `now`, and
   *  audit a `retention` entry recording the pruned count. Best-effort
   *  (never throws). Returns the pruned day keys. */
  pruneRetention(now: Date, retentionDays?: number): Promise<string[]>;
}

/** A `Storage`-backed {@link AuditLog}. `onError` is injected so the swallowed
 *  failure path is directly assertable — a test that could not see the
 *  swallowed error could not tell "recorded and continued" from "lost". */
export function createAuditLog(
  scope: StorageScope = "global",
  onError: AuditErrorSink = auditStderrSink,
): AuditLog {
  const storage = new Storage(scope);

  const doAppend = async (
    input: Omit<AuditEntry, "at"> & { at?: string },
  ): Promise<void> => {
    const at = input.at ?? new Date().toISOString();
    const detail = clampAuditDetail(input.detail);
    const entry: AuditEntry = {
      at,
      actor: input.actor,
      kind: input.kind,
      ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
      ...(detail !== undefined ? { detail } : {}),
    };
    const key = auditDayKey(new Date(at));
    try {
      await withLock(AUDIT_LOCK, async () => {
        const read = await storage.get<AuditBucket>(key);
        const bucket = Array.isArray(read.value) ? read.value : [];
        await storage.set(key, appendWithCap(bucket, entry));
      });
    } catch (err) {
      // Record-and-continue. The action this line describes has already
      // happened and must not be failed retroactively by its own bookkeeping.
      onError(
        `ez-factory[audit]: append failed (${entry.kind}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  const doListDays = async (): Promise<string[]> => {
    const { keys } = await storage.list({ prefix: AUDIT_KEY_PREFIX });
    return keys
      .map((k) => (k.startsWith(AUDIT_KEY_PREFIX) ? k.slice(AUDIT_KEY_PREFIX.length) : k))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  };

  return {
    append: doAppend,
    async readDay(day) {
      const read = await storage.get<AuditBucket>(`${AUDIT_KEY_PREFIX}${day}`);
      return Array.isArray(read.value) ? read.value : [];
    },
    listDays: doListDays,
    async pruneRetention(now, retentionDays = AUDIT_RETENTION_DAYS) {
      try {
        const toPrune = auditDaysToPrune(await doListDays(), now, retentionDays);
        for (const day of toPrune) {
          await storage.delete(`${AUDIT_KEY_PREFIX}${day}`);
        }
        if (toPrune.length > 0) {
          // The prune is itself audited, on the current day.
          await doAppend({
            at: now.toISOString(),
            actor: SYSTEM_ACTOR,
            kind: "retention",
            detail: { prunedDays: toPrune.length, retentionDays },
          });
        }
        return toPrune;
      } catch (err) {
        onError(
          `ez-factory[audit]: retention prune failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return [];
      }
    },
  };
}
