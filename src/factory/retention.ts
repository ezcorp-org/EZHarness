import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql, type SQL } from "drizzle-orm";
import { FACTORY_RETENTION_PERIOD_MS, type FactoryRetentionClass, type FactoryRetentionSubjectKind } from "../db/migrations/add-factory-recovery";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { s3ObjectKey } from "../extensions/v4/blobs";
import { archiveFactoryRunAudit, readFactoryArchivedRunAudit } from "./audit-archive";
import { assertFactoryIdentity, FactoryRecords, type FactoryRunKey } from "./records";
import { parseFactoryArchiveReference, type FactoryRecoveryArchive } from "./recovery-archive";
import type { FactoryArchiveObject, FactoryReleaseArchive } from "./releases";
import { factoryArchiveClient, type ArchiveS3ClientLike } from "./release-adapters";

/**
 * C06 reference-aware retention (W15).
 *
 * A subject is enrolled once, with the class period from its anchor: the
 * moment a run became terminal, a release settled, or a key wrap was
 * superseded. Nothing is collected because its age passed a default. A due
 * subject is collected only after four checks, in this order:
 *
 *   1. its archive copy exists and verifies, when its class needs one — an
 *      archive failure throws and stops the whole pass, because C06 says
 *      archival failure stops cleanup;
 *   2. no live reference holds it — a non-terminal run, an unsettled release
 *      or child, a live attempt, a foreign key the catalog names, or a sealed
 *      checkpoint that still needs a key wrap;
 *   3. it is tombstoned, in its own committed transaction, so new work stops
 *      before anything is removed;
 *   4. the references are checked again under the row lock, and only then is
 *      the primary copy removed.
 *
 * Immutable facts (releases, receipts, approvals, accepted evidence) are
 * tombstoned at their deadline and never deleted here: C06 routes final
 * deletion through the explicit C09 purge, which records what audit is lost.
 */

export const FACTORY_RETENTION_CLASS_OF: Readonly<Record<FactoryRetentionSubjectKind, FactoryRetentionClass>> = Object.freeze({
  run_audit: "canonical_audit",
  candidate_artifact: "unaccepted_candidate",
  key_wrap: "key_version",
  release: "release",
  accepted_evidence: "accepted_evidence",
  approval: "approval",
  receipt: "receipt",
});

/**
 * The per-run immutable facts C06 keeps for the audit period: validator
 * evidence, human approvals, and task and stop receipts. Each run with such a
 * fact is one subject, anchored when the run became terminal. Like a release,
 * each is tombstoned at its deadline and never deleted here: final deletion is
 * the explicit C09 purge.
 */
const RUN_FACTS: readonly { readonly kind: FactoryRetentionSubjectKind; readonly exists: SQL }[] = Object.freeze([
  { kind: "accepted_evidence", exists: sql`EXISTS (SELECT 1 FROM factory_acceptance_evidence e WHERE e.tenant_id = l.tenant_id AND e.project_id = l.project_id AND e.run_id = l.run_id)` },
  { kind: "approval", exists: sql`(EXISTS (SELECT 1 FROM factory_command_approvals c WHERE c.tenant_id = l.tenant_id AND c.project_id = l.project_id AND c.run_id = l.run_id)
    OR EXISTS (SELECT 1 FROM factory_release_approvals a JOIN factory_release_operations o ON o.tenant_id = a.tenant_id AND o.project_id = a.project_id AND o.operation_id = a.operation_id
      WHERE a.tenant_id = l.tenant_id AND a.project_id = l.project_id AND o.run_id = l.run_id))` },
  { kind: "receipt", exists: sql`(EXISTS (SELECT 1 FROM factory_task_completions c WHERE c.tenant_id = l.tenant_id AND c.project_id = l.project_id AND c.run_id = l.run_id)
    OR EXISTS (SELECT 1 FROM factory_task_outcomes t WHERE t.tenant_id = l.tenant_id AND t.project_id = l.project_id AND t.run_id = l.run_id)
    OR EXISTS (SELECT 1 FROM factory_task_stops s WHERE s.tenant_id = l.tenant_id AND s.project_id = l.project_id AND s.run_id = l.run_id AND s.stop_receipt_json IS NOT NULL))` },
]);

/** Kinds tombstoned at their deadline and never deleted by this role. */
const IMMUTABLE_KINDS: ReadonlySet<FactoryRetentionSubjectKind> = new Set(["release", ...RUN_FACTS.map(fact => fact.kind)]);

/** Kinds whose primary copy may expire only after a verified archive copy exists. */
const ARCHIVED_KINDS: ReadonlySet<FactoryRetentionSubjectKind> = new Set(["run_audit", "release"]);
export const FACTORY_TERMINAL_RUN_STATUSES = Object.freeze(["succeeded", "failed", "cancelled"] as const);
/**
 * Tables whose foreign key to a candidate is its own production history, not a
 * use of it. An execution terminal names the output it produced; that does not
 * keep an unaccepted candidate alive.
 */
export const FACTORY_RETENTION_HISTORY_REFERRERS: Readonly<Record<"factory_artifacts" | "factory_audit_batches", readonly string[]>> = Object.freeze({
  factory_artifacts: Object.freeze(["factory_execution_terminals"]),
  factory_audit_batches: Object.freeze([]),
});
export const FACTORY_RETENTION_PAGE_LIMIT = 200;
const IMMUTABLE_FACT = "immutable_fact_retained_until_purge";
const TERMINAL = sql.raw(FACTORY_TERMINAL_RUN_STATUSES.map(status => `'${status}'`).join(","));

export class FactoryRetentionError extends Error {
  constructor(readonly code: "factory_retention_invalid" | "factory_retention_not_found" | "factory_retention_archive_failed", options?: { cause?: unknown }) {
    super(code, options);
    this.name = "FactoryRetentionError";
  }
}

export interface FactoryRetentionRecord {
  readonly subjectKind: FactoryRetentionSubjectKind;
  readonly subjectId: string;
  readonly projectId: string | null;
  readonly runId: string | null;
  readonly retentionClass: FactoryRetentionClass;
  readonly anchoredAtMs: number;
  readonly retainUntilMs: number;
  readonly state: "retained" | "tombstoned" | "collected";
  readonly archive: FactoryArchiveObject | null;
  readonly lastRefusal: string | null;
}

export type FactoryRetentionAction = "collected" | "tombstoned" | "refused";
export interface FactoryRetentionOutcome {
  readonly subjectKind: FactoryRetentionSubjectKind;
  readonly subjectId: string;
  readonly action: FactoryRetentionAction;
  readonly reason?: string;
}

/** Removes an unaccepted candidate's current object version. A versioned store keeps the prior version for backups. */
export interface FactoryRetentionBlobEraser {
  erase(blobDigest: string, signal?: AbortSignal): Promise<void>;
}

export interface FactoryRetentionOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  readonly installationId: string;
  readonly archive: FactoryRecoveryArchive;
  /** Reads a release's own archived intent, material, and receipt. */
  readonly releaseArchive: Pick<FactoryReleaseArchive, "read">;
  readonly eraser?: FactoryRetentionBlobEraser;
  readonly now?: () => number;
}

interface RecordRow {
  subject_kind: FactoryRetentionSubjectKind; subject_id: string; project_id: string | null; run_id: string | null;
  retention_class: FactoryRetentionClass; anchored_at_ms: string | number; retain_until_ms: string | number;
  state: FactoryRetentionRecord["state"]; archive_json: string | null; last_refusal: string | null;
}

function record(row: RecordRow): FactoryRetentionRecord {
  return Object.freeze({
    subjectKind: row.subject_kind, subjectId: row.subject_id, projectId: row.project_id, runId: row.run_id,
    retentionClass: row.retention_class, anchoredAtMs: Number(row.anchored_at_ms), retainUntilMs: Number(row.retain_until_ms),
    state: row.state, archive: row.archive_json === null ? null : parseFactoryArchiveReference(row.archive_json), lastRefusal: row.last_refusal,
  });
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new FactoryRetentionError("factory_retention_invalid");
  return `"${value}"`;
}

/**
 * `[projectId, id]`, the subject id of every project-scoped subject. The SQL
 * enrollment builds the same bytes with `to_json`, which escapes a string the
 * way canonical JSON does and adds no whitespace.
 */
export function factoryRetentionSubjectId(projectId: string, id: string): string {
  assertFactoryIdentity(projectId, id);
  return canonicalJson([projectId, id]);
}

function subjectKey(subjectId: string): [string, string] {
  const parsed = JSON.parse(subjectId) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some(value => typeof value !== "string")) throw new FactoryRetentionError("factory_retention_invalid");
  return parsed as [string, string];
}

/**
 * The first catalog foreign key whose referencing rows point at the subject.
 * The catalog is the authority: a table added later that references the
 * subject keeps it alive without anyone editing this file.
 */
export async function factoryForeignReferrer(transaction: MigrationDb, target: keyof typeof FACTORY_RETENTION_HISTORY_REFERRERS, where: Readonly<Record<string, string>>): Promise<string | null> {
  const keys = rows<{ referrer: string; columns: string; referenced: string }>(await transaction.execute(sql`SELECT con.conrelid::regclass::text AS referrer,
      (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
      (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS referenced
    FROM pg_constraint con WHERE con.contype = 'f' AND con.confrelid = ${target}::regclass ORDER BY 1, 2`));
  const filters = Object.entries(where).map(([column, value]) => sql`AND t.${sql.raw(identifier(column))} = ${value}`);
  for (const key of keys) {
    if (FACTORY_RETENTION_HISTORY_REFERRERS[target].includes(key.referrer)) continue;
    const columns = key.columns.split(",").map(identifier);
    const referenced = key.referenced.split(",").map(identifier);
    const join = sql.raw(columns.map((column, index) => `r.${column} = t.${referenced[index]}`).join(" AND "));
    const found = rows(await transaction.execute(sql`SELECT 1 FROM ${sql.raw(identifier(key.referrer))} r JOIN ${sql.raw(identifier(target))} t ON ${join} WHERE TRUE ${sql.join(filters, sql` `)} LIMIT 1`));
    if (found.length > 0) return key.referrer;
  }
  return null;
}

/** Deletes one content-addressed object's current version from the tenant's ordinary S3 prefix. */
export class S3FactoryRetentionBlobEraser implements FactoryRetentionBlobEraser {
  private readonly client: ArchiveS3ClientLike;
  constructor(private readonly options: { readonly endpoint: string; readonly bucket: string; readonly prefix: string; readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string }; readonly client?: ArchiveS3ClientLike }) {
    s3ObjectKey(options.prefix, "0".repeat(64));
    this.client = factoryArchiveClient(options);
  }

  async erase(blobDigest: string, signal?: AbortSignal): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: s3ObjectKey(this.options.prefix, blobDigest) }), signal ? { abortSignal: signal } : undefined);
  }
}

export class FactoryRetention {
  private readonly database: TransactionalDb;
  private readonly records: FactoryRecords;
  private readonly now: () => number;
  readonly tenantId: string;
  private readonly installationId: string;

  constructor(private readonly options: FactoryRetentionOptions) {
    assertFactoryIdentity(options.tenantId, options.installationId);
    this.database = options.database;
    this.tenantId = options.tenantId;
    this.installationId = options.installationId;
    this.records = new FactoryRecords(options.database, options.tenantId);
    this.now = options.now ?? Date.now;
  }

  /**
   * Enrolls every subject that has reached its anchor and has no ledger row.
   * Idempotent: a repeat enrolls nothing, and a concurrent enrollment of the
   * same subject lands on the primary key once.
   */
  async enroll(limit = FACTORY_RETENTION_PAGE_LIMIT): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > FACTORY_RETENTION_PAGE_LIMIT) throw new FactoryRetentionError("factory_retention_invalid");
    const period = (kind: FactoryRetentionSubjectKind) => FACTORY_RETENTION_PERIOD_MS[FACTORY_RETENTION_CLASS_OF[kind]];
    const inserted = (result: unknown) => rows(result).length;
    return this.database.transaction(async transaction => {
      let count = inserted(await transaction.execute(sql`INSERT INTO factory_retention_records (tenant_id, subject_kind, subject_id, project_id, run_id, retention_class, anchored_at_ms, retain_until_ms)
        SELECT l.tenant_id, 'run_audit', ('[' || to_json(l.project_id::text)::text || ',' || to_json(l.run_id::text)::text || ']'), l.project_id, l.run_id, 'canonical_audit', a.anchor, a.anchor + ${period("run_audit")}
        FROM factory_run_lifecycle l CROSS JOIN LATERAL (SELECT (floor(extract(epoch FROM l.updated_at) * 1000))::bigint AS anchor) a
        WHERE l.tenant_id = ${this.tenantId} AND l.status IN (${TERMINAL})
          AND NOT EXISTS (SELECT 1 FROM factory_retention_records r WHERE r.tenant_id = l.tenant_id AND r.subject_kind = 'run_audit' AND r.subject_id = ('[' || to_json(l.project_id::text)::text || ',' || to_json(l.run_id::text)::text || ']'))
        ORDER BY l.updated_at LIMIT ${limit}
        ON CONFLICT (tenant_id, subject_kind, subject_id) DO NOTHING RETURNING subject_id`));
      count += inserted(await transaction.execute(sql`INSERT INTO factory_retention_records (tenant_id, subject_kind, subject_id, project_id, run_id, retention_class, anchored_at_ms, retain_until_ms)
        SELECT f.tenant_id, 'candidate_artifact', ('[' || to_json(f.project_id::text)::text || ',' || to_json(f.object_id::text)::text || ']'), f.project_id, f.run_id, 'unaccepted_candidate', a.anchor, a.anchor + ${period("candidate_artifact")}
        FROM factory_artifacts f JOIN factory_run_lifecycle l ON l.tenant_id = f.tenant_id AND l.project_id = f.project_id AND l.run_id = f.run_id
          CROSS JOIN LATERAL (SELECT (floor(extract(epoch FROM l.updated_at) * 1000))::bigint AS anchor) a
        WHERE f.tenant_id = ${this.tenantId} AND f.kind = 'candidate_output' AND l.status IN (${TERMINAL})
          AND NOT EXISTS (SELECT 1 FROM factory_retention_records r WHERE r.tenant_id = f.tenant_id AND r.subject_kind = 'candidate_artifact' AND r.subject_id = ('[' || to_json(f.project_id::text)::text || ',' || to_json(f.object_id::text)::text || ']'))
        ORDER BY l.updated_at LIMIT ${limit}
        ON CONFLICT (tenant_id, subject_kind, subject_id) DO NOTHING RETURNING subject_id`));
      count += inserted(await transaction.execute(sql`INSERT INTO factory_retention_records (tenant_id, subject_kind, subject_id, retention_class, anchored_at_ms, retain_until_ms)
        SELECT ${this.tenantId}, 'key_wrap', w.wrap_version::text, 'key_version', a.anchor, a.anchor + ${period("key_wrap")}
        FROM factory_installation_key_wraps w
          CROSS JOIN LATERAL (SELECT (floor(extract(epoch FROM min(n.created_at)) * 1000))::bigint AS anchor FROM factory_installation_key_wraps n WHERE n.installation_id = w.installation_id AND n.wrap_version > w.wrap_version) a
        WHERE w.installation_id = ${this.installationId} AND a.anchor IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM factory_retention_records r WHERE r.tenant_id = ${this.tenantId} AND r.subject_kind = 'key_wrap' AND r.subject_id = w.wrap_version::text)
        ORDER BY w.wrap_version LIMIT ${limit}
        ON CONFLICT (tenant_id, subject_kind, subject_id) DO NOTHING RETURNING subject_id`));
      count += inserted(await transaction.execute(sql`INSERT INTO factory_retention_records (tenant_id, subject_kind, subject_id, project_id, run_id, retention_class, anchored_at_ms, retain_until_ms)
        SELECT o.tenant_id, 'release', ('[' || to_json(o.project_id::text)::text || ',' || to_json(o.operation_id::text)::text || ']'), o.project_id, o.run_id, 'release', a.anchor, a.anchor + ${period("release")}
        FROM factory_release_operations o CROSS JOIN LATERAL (SELECT (floor(extract(epoch FROM o.updated_at) * 1000))::bigint AS anchor) a
        WHERE o.tenant_id = ${this.tenantId} AND o.state IN ('succeeded','failed')
          AND NOT EXISTS (SELECT 1 FROM factory_retention_records r WHERE r.tenant_id = o.tenant_id AND r.subject_kind = 'release' AND r.subject_id = ('[' || to_json(o.project_id::text)::text || ',' || to_json(o.operation_id::text)::text || ']'))
        ORDER BY o.updated_at LIMIT ${limit}
        ON CONFLICT (tenant_id, subject_kind, subject_id) DO NOTHING RETURNING subject_id`));
      for (const fact of RUN_FACTS) {
        count += inserted(await transaction.execute(sql`INSERT INTO factory_retention_records (tenant_id, subject_kind, subject_id, project_id, run_id, retention_class, anchored_at_ms, retain_until_ms)
          SELECT l.tenant_id, ${fact.kind}, ('[' || to_json(l.project_id::text)::text || ',' || to_json(l.run_id::text)::text || ']'), l.project_id, l.run_id, ${FACTORY_RETENTION_CLASS_OF[fact.kind]}, a.anchor, a.anchor + ${period(fact.kind)}
          FROM factory_run_lifecycle l CROSS JOIN LATERAL (SELECT (floor(extract(epoch FROM l.updated_at) * 1000))::bigint AS anchor) a
          WHERE l.tenant_id = ${this.tenantId} AND l.status IN (${TERMINAL}) AND ${fact.exists}
            AND NOT EXISTS (SELECT 1 FROM factory_retention_records r WHERE r.tenant_id = l.tenant_id AND r.subject_kind = ${fact.kind} AND r.subject_id = ('[' || to_json(l.project_id::text)::text || ',' || to_json(l.run_id::text)::text || ']'))
          ORDER BY l.updated_at LIMIT ${limit}
          ON CONFLICT (tenant_id, subject_kind, subject_id) DO NOTHING RETURNING subject_id`));
      }
      return count;
    });
  }

  async read(kind: FactoryRetentionSubjectKind, subjectId: string): Promise<FactoryRetentionRecord | null> {
    const row = rows<RecordRow>(await this.database.execute(sql`SELECT subject_kind, subject_id, project_id, run_id, retention_class, anchored_at_ms, retain_until_ms, state, archive_json, last_refusal FROM factory_retention_records WHERE tenant_id = ${this.tenantId} AND subject_kind = ${kind} AND subject_id = ${subjectId}`))[0];
    return row ? record(row) : null;
  }

  /**
   * Extends a deadline. A later deadline wins and an earlier one changes
   * nothing; the database CHECK refuses anything below the class period, so a
   * release can lengthen retention and nothing can shorten it.
   */
  async extend(kind: FactoryRetentionSubjectKind, subjectId: string, retainUntilMs: number, reason: string): Promise<FactoryRetentionRecord> {
    if (!Number.isSafeInteger(retainUntilMs) || retainUntilMs < 0 || typeof reason !== "string" || reason.length < 1 || reason.length > 512) throw new FactoryRetentionError("factory_retention_invalid");
    const updated = rows<RecordRow>(await this.database.execute(sql`UPDATE factory_retention_records SET retain_until_ms = GREATEST(retain_until_ms, ${retainUntilMs}),
        extension_reason = CASE WHEN ${retainUntilMs} > retain_until_ms THEN ${reason} ELSE extension_reason END, updated_at = NOW()
      WHERE tenant_id = ${this.tenantId} AND subject_kind = ${kind} AND subject_id = ${subjectId} AND state = 'retained'
      RETURNING subject_kind, subject_id, project_id, run_id, retention_class, anchored_at_ms, retain_until_ms, state, archive_json, last_refusal`))[0];
    if (!updated) throw new FactoryRetentionError("factory_retention_not_found");
    return record(updated);
  }

  /** Archives up to `limit` enrolled subjects whose class needs an archive copy and has none yet. */
  async archivePending(limit = FACTORY_RETENTION_PAGE_LIMIT, signal?: AbortSignal): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > FACTORY_RETENTION_PAGE_LIMIT) throw new FactoryRetentionError("factory_retention_invalid");
    const pending = rows<RecordRow>(await this.database.execute(sql`SELECT subject_kind, subject_id, project_id, run_id, retention_class, anchored_at_ms, retain_until_ms, state, archive_json, last_refusal FROM factory_retention_records
      WHERE tenant_id = ${this.tenantId} AND archive_json IS NULL AND subject_kind IN ('run_audit','release') AND state <> 'collected' ORDER BY retain_until_ms LIMIT ${limit}`));
    for (const row of pending) await this.archive(record(row), signal);
    return pending.length;
  }

  /**
   * One bounded collection pass over due subjects. An archive failure throws
   * out of the pass, so nothing after it is collected.
   */
  async collectDue(limit = FACTORY_RETENTION_PAGE_LIMIT, signal?: AbortSignal): Promise<readonly FactoryRetentionOutcome[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > FACTORY_RETENTION_PAGE_LIMIT) throw new FactoryRetentionError("factory_retention_invalid");
    const now = this.now();
    const due = rows<RecordRow>(await this.database.execute(sql`SELECT subject_kind, subject_id, project_id, run_id, retention_class, anchored_at_ms, retain_until_ms, state, archive_json, last_refusal FROM factory_retention_records
      WHERE tenant_id = ${this.tenantId} AND state IN ('retained','tombstoned') AND retain_until_ms <= ${now} ORDER BY retain_until_ms, subject_kind, subject_id LIMIT ${limit}`)).map(record);
    // Every due subject that needs an archive copy is archived and verified
    // before anything in this pass is collected, so a failure leaves the pass
    // with nothing removed rather than with whatever preceded the failure.
    const ready: FactoryRetentionRecord[] = [];
    for (const subject of due) {
      signal?.throwIfAborted();
      if (!ARCHIVED_KINDS.has(subject.subjectKind)) { ready.push(subject); continue; }
      const archived = subject.archive ? subject : await this.archive(subject, signal);
      await this.verifyArchive(archived, signal);
      ready.push(archived);
    }
    const outcomes: FactoryRetentionOutcome[] = [];
    for (const subject of ready) {
      signal?.throwIfAborted();
      const refusal = await this.database.transaction(transaction => this.liveReference(transaction, subject));
      if (refusal) { outcomes.push(await this.refuse(subject, refusal)); continue; }
      await this.tombstone(subject, now);
      if (IMMUTABLE_KINDS.has(subject.subjectKind)) { outcomes.push(await this.refuse(subject, IMMUTABLE_FACT, "tombstoned")); continue; }
      outcomes.push(await this.collect(subject, now, signal));
    }
    return outcomes;
  }

  /** Counts per kind and state, for readiness and the recovery report. */
  async summary(): Promise<readonly { readonly subjectKind: string; readonly state: string; readonly count: number }[]> {
    return rows<{ subject_kind: string; state: string; count: string | number }>(await this.database.execute(sql`SELECT subject_kind, state, count(*) AS count FROM factory_retention_records WHERE tenant_id = ${this.tenantId} GROUP BY subject_kind, state ORDER BY subject_kind, state`))
      .map(row => Object.freeze({ subjectKind: row.subject_kind, state: row.state, count: Number(row.count) }));
  }

  private runKey(subject: FactoryRetentionRecord): FactoryRunKey {
    const [projectId, id] = subjectKey(subject.subjectId);
    return subject.subjectKind === "run_audit" ? { projectId, runId: id } : { projectId, runId: subject.runId ?? "" };
  }

  private async archive(subject: FactoryRetentionRecord, signal?: AbortSignal): Promise<FactoryRetentionRecord> {
    let reference: FactoryArchiveObject;
    try {
      reference = subject.subjectKind === "run_audit"
        ? (await archiveFactoryRunAudit(this.records, this.options.archive, this.runKey(subject), signal)).index
        : await this.releaseArchiveReference(subject, signal);
    } catch (cause) { throw new FactoryRetentionError("factory_retention_archive_failed", { cause }); }
    const updated = rows<RecordRow>(await this.database.execute(sql`UPDATE factory_retention_records SET archive_json = ${canonicalJson(reference)}, archive_digest = ${reference.digest}, archived_at_ms = ${this.now()}, updated_at = NOW()
      WHERE tenant_id = ${this.tenantId} AND subject_kind = ${subject.subjectKind} AND subject_id = ${subject.subjectId} AND archive_json IS NULL
      RETURNING subject_kind, subject_id, project_id, run_id, retention_class, anchored_at_ms, retain_until_ms, state, archive_json, last_refusal`))[0];
    return updated ? record(updated) : (await this.read(subject.subjectKind, subject.subjectId))!;
  }

  /** A settled release was archived by the release store before it dispatched; this only proves the copy still reads back. */
  private async releaseArchiveReference(subject: FactoryRetentionRecord, signal?: AbortSignal): Promise<FactoryArchiveObject> {
    const [projectId, operationId] = subjectKey(subject.subjectId);
    const row = rows<{ intent_archive_json: string | null; material_archive_json: string | null; receipt_archive_json: string | null }>(await this.database.execute(sql`SELECT intent_archive_json, material_archive_json, receipt_archive_json FROM factory_release_operations WHERE tenant_id = ${this.tenantId} AND project_id = ${projectId} AND operation_id = ${operationId}`))[0];
    if (!row?.intent_archive_json || !row.material_archive_json) throw new FactoryRetentionError("factory_retention_archive_failed");
    const references = [row.intent_archive_json, row.material_archive_json, row.receipt_archive_json].flatMap(value => value === null ? [] : [parseFactoryArchiveReference(value)]);
    for (const reference of references) {
      signal?.throwIfAborted();
      await this.options.releaseArchive.read(reference);
    }
    return references.at(-1)!;
  }

  private async verifyArchive(subject: FactoryRetentionRecord, signal?: AbortSignal): Promise<void> {
    try {
      if (subject.subjectKind === "release") { await this.releaseArchiveReference(subject, signal); return; }
      const key = this.runKey(subject);
      const archived = await readFactoryArchivedRunAudit(this.options.archive, subject.archive!, this.tenantId, key, signal);
      const held = Number(rows<{ sequence: string | number }>(await this.database.execute(sql`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM factory_audit_batches WHERE tenant_id = ${this.tenantId} AND project_id = ${key.projectId} AND run_id = ${key.runId}`))[0]!.sequence);
      // A primary stream that grew after archiving is archived again before anything expires.
      if (held > archived.length) {
        const refreshed = await archiveFactoryRunAudit(this.records, this.options.archive, key, signal);
        await this.database.execute(sql`UPDATE factory_retention_records SET archive_json = ${canonicalJson(refreshed.index)}, archive_digest = ${refreshed.index.digest}, archived_at_ms = ${this.now()}, updated_at = NOW() WHERE tenant_id = ${this.tenantId} AND subject_kind = 'run_audit' AND subject_id = ${subject.subjectId}`);
      }
    } catch (cause) {
      if (cause instanceof FactoryRetentionError) throw cause;
      throw new FactoryRetentionError("factory_retention_archive_failed", { cause });
    }
  }

  /** The first live reference that keeps the subject, or null. */
  private async liveReference(transaction: MigrationDb, subject: FactoryRetentionRecord): Promise<string | null> {
    if (subject.subjectKind === "key_wrap") return this.keyWrapReference(transaction, subject);
    if (subject.subjectKind === "release") return null;
    const key = this.runKey(subject);
    const status = rows<{ status: string }>(await transaction.execute(sql`SELECT status FROM factory_run_lifecycle WHERE tenant_id = ${this.tenantId} AND project_id = ${key.projectId} AND run_id = ${key.runId} FOR SHARE`))[0]?.status;
    if (!status || !(FACTORY_TERMINAL_RUN_STATUSES as readonly string[]).includes(status)) return "run_not_terminal";
    const scoped = sql`tenant_id = ${this.tenantId} AND project_id = ${key.projectId}`;
    if (rows(await transaction.execute(sql`SELECT 1 FROM factory_child_runs WHERE ${scoped} AND (parent_run_id = ${key.runId} OR child_run_id = ${key.runId}) AND state <> 'settled' LIMIT 1`)).length) return "child_unsettled";
    if (rows(await transaction.execute(sql`SELECT 1 FROM factory_release_operations WHERE ${scoped} AND run_id = ${key.runId} AND state IN ('pending','executing','uncertain') LIMIT 1`)).length) return "release_unsettled";
    if (rows(await transaction.execute(sql`SELECT 1 FROM factory_attempt_launches WHERE ${scoped} AND run_id = ${key.runId} AND state IN ('prepared','launching','launched','uncertain') LIMIT 1`)).length) return "attempt_live";
    // A per-run fact is only tombstoned, so the run-level checks above are all it needs.
    if (IMMUTABLE_KINDS.has(subject.subjectKind)) return null;
    if (subject.subjectKind === "run_audit") {
      const referrer = await factoryForeignReferrer(transaction, "factory_audit_batches", { tenant_id: this.tenantId, project_id: key.projectId, run_id: key.runId });
      return referrer ? `referenced_by:${referrer}` : null;
    }
    const [, objectId] = subjectKey(subject.subjectId);
    const artifact = rows<{ digest: string }>(await transaction.execute(sql`SELECT digest FROM factory_artifacts WHERE ${scoped} AND object_id = ${objectId} FOR SHARE`))[0];
    if (!artifact) return "artifact_missing";
    if (rows(await transaction.execute(sql`SELECT 1 FROM factory_release_operations WHERE ${scoped} AND candidate_digest = ${artifact.digest} LIMIT 1`)).length) return "released_candidate";
    const referrer = await factoryForeignReferrer(transaction, "factory_artifacts", { tenant_id: this.tenantId, project_id: key.projectId, object_id: objectId });
    return referrer ? `referenced_by:${referrer}` : null;
  }

  private async keyWrapReference(transaction: MigrationDb, subject: FactoryRetentionRecord): Promise<string | null> {
    const version = Number(subject.subjectId);
    const newest = Number(rows<{ version: string | number | null }>(await transaction.execute(sql`SELECT max(wrap_version) AS version FROM factory_installation_key_wraps WHERE installation_id = ${this.installationId}`))[0]?.version ?? 0);
    if (version >= newest) return "current_key_wrap";
    const cutoff = this.now() - FACTORY_RETENTION_PERIOD_MS.key_version;
    if (rows(await transaction.execute(sql`SELECT 1 FROM factory_checkpoints WHERE tenant_id = ${this.tenantId} AND state = 'sealed' AND key_wrap_version = ${version} AND sealed_at > to_timestamp(${cutoff}::double precision / 1000) LIMIT 1`)).length) return "checkpoint_needs_key_wrap";
    return null;
  }

  private async refuse(subject: FactoryRetentionRecord, reason: string, action: FactoryRetentionAction = "refused"): Promise<FactoryRetentionOutcome> {
    await this.database.execute(sql`UPDATE factory_retention_records SET last_refusal = ${reason}, updated_at = NOW() WHERE tenant_id = ${this.tenantId} AND subject_kind = ${subject.subjectKind} AND subject_id = ${subject.subjectId}`);
    return Object.freeze({ subjectKind: subject.subjectKind, subjectId: subject.subjectId, action, reason });
  }

  private async tombstone(subject: FactoryRetentionRecord, now: number): Promise<void> {
    await this.database.execute(sql`UPDATE factory_retention_records SET state = 'tombstoned', tombstoned_at_ms = ${now}, last_refusal = NULL, updated_at = NOW() WHERE tenant_id = ${this.tenantId} AND subject_kind = ${subject.subjectKind} AND subject_id = ${subject.subjectId} AND state = 'retained'`);
  }

  private async collect(subject: FactoryRetentionRecord, now: number, signal?: AbortSignal): Promise<FactoryRetentionOutcome> {
    if (subject.subjectKind === "candidate_artifact") {
      const erased = await this.eraseCandidate(subject, signal);
      if (erased !== true) return this.refuse(subject, erased, "tombstoned");
    }
    return this.database.transaction(async transaction => {
      const locked = rows(await transaction.execute(sql`SELECT 1 FROM factory_retention_records WHERE tenant_id = ${this.tenantId} AND subject_kind = ${subject.subjectKind} AND subject_id = ${subject.subjectId} AND state = 'tombstoned' FOR UPDATE`));
      if (!locked.length) return Object.freeze({ subjectKind: subject.subjectKind, subjectId: subject.subjectId, action: "refused" as const, reason: "not_tombstoned" });
      const refusal = await this.liveReference(transaction, subject);
      if (refusal) {
        await transaction.execute(sql`UPDATE factory_retention_records SET last_refusal = ${refusal}, updated_at = NOW() WHERE tenant_id = ${this.tenantId} AND subject_kind = ${subject.subjectKind} AND subject_id = ${subject.subjectId}`);
        return Object.freeze({ subjectKind: subject.subjectKind, subjectId: subject.subjectId, action: "tombstoned" as const, reason: refusal });
      }
      if (subject.subjectKind === "run_audit") {
        const key = this.runKey(subject);
        const scoped = sql`tenant_id = ${this.tenantId} AND project_id = ${key.projectId} AND run_id = ${key.runId}`;
        await transaction.execute(sql`DELETE FROM factory_run_projection_attempts WHERE ${scoped}`);
        await transaction.execute(sql`DELETE FROM factory_run_projections WHERE ${scoped}`);
        await transaction.execute(sql`DELETE FROM factory_audit_batches WHERE ${scoped}`);
      } else if (subject.subjectKind === "key_wrap") {
        await transaction.execute(sql`DELETE FROM factory_installation_key_wraps WHERE installation_id = ${this.installationId} AND wrap_version = ${Number(subject.subjectId)}`);
      }
      await transaction.execute(sql`UPDATE factory_retention_records SET state = 'collected', collected_at_ms = ${now}, last_refusal = NULL, updated_at = NOW() WHERE tenant_id = ${this.tenantId} AND subject_kind = ${subject.subjectKind} AND subject_id = ${subject.subjectId}`);
      return Object.freeze({ subjectKind: subject.subjectKind, subjectId: subject.subjectId, action: "collected" as const });
    });
  }

  /**
   * Erases the candidate's bytes unless another retained artifact shares them.
   * Content addressing means two rows can name one object; erasing it would
   * remove bytes a live row still needs.
   */
  private async eraseCandidate(subject: FactoryRetentionRecord, signal?: AbortSignal): Promise<true | string> {
    const [projectId, objectId] = subjectKey(subject.subjectId);
    const artifact = rows<{ blob_digest: string }>(await this.database.execute(sql`SELECT blob_digest FROM factory_artifacts WHERE tenant_id = ${this.tenantId} AND project_id = ${projectId} AND object_id = ${objectId}`))[0]!;
    const shared = rows(await this.database.execute(sql`SELECT 1 FROM factory_artifacts f WHERE f.tenant_id = ${this.tenantId} AND f.blob_digest = ${artifact.blob_digest} AND NOT (f.project_id = ${projectId} AND f.object_id = ${objectId})
      AND NOT EXISTS (SELECT 1 FROM factory_retention_records r WHERE r.tenant_id = f.tenant_id AND r.subject_kind = 'candidate_artifact' AND r.subject_id = ('[' || to_json(f.project_id::text)::text || ',' || to_json(f.object_id::text)::text || ']') AND r.state = 'collected') LIMIT 1`));
    if (shared.length) return "blob_shared";
    if (!this.options.eraser) return "eraser_unconfigured";
    await this.options.eraser.erase(artifact.blob_digest, signal);
    return true;
  }
}
