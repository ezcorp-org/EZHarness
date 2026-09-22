import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../db/migrations/types";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject, s3ObjectKey } from "../extensions/v4/blobs";
import { importFactoryArchivedRunAudit, readFactoryArchivedRunAudit, readFactoryRunAudit } from "./audit-archive";
import { captureFactoryProductState, factoryInterpreterWorkflowId, factoryKeyWrapDigest, factorySchemaDigest, latestFactoryCheckpoint, type FactoryCheckpointManifest, type FactoryCheckpointSeal, type FactoryCheckpointTemporalSource } from "./checkpoint-barrier";
import type { InstallationDataKey } from "./encryption";
import type { FactoryPrincipal } from "./grants";
import { validateFactoryStopReceipt, type FactoryJournalHostKey } from "./journal-validation";
import { assertFactoryIdentity, FactoryRecordError, FactoryRecords, type FactoryRunKey } from "./records";
import { parseFactoryArchiveReference, readFactoryRecoveryJson, writeFactoryRecoveryJson, type FactoryArchivedReleaseCatalog, type FactoryArchivedReleaseObjects, type FactoryRecoveryArchive } from "./recovery-archive";
import type { FactoryArchiveObject, FactoryProviderReceipt, FactoryReleaseArchive, FactoryReleaseOperation, FactoryReleaseProvider } from "./releases";
import type { FactoryPhysicalStopReceipt } from "./runner/attempt-wire";
import type { FactoryHostStopCommand } from "./runner/host-stop-service";
import type { FactoryPoolStopAcknowledger } from "./task-stops";

/**
 * C06 restore into a new execution epoch (W15).
 *
 * `begin` opens the epoch before it verifies anything: it raises the
 * installation's execution epoch, which fences every old-epoch attempt token,
 * broker request, and run write, and it records an open restore epoch, which
 * the database gates read to close run admission, release claims, and attempt
 * launches. Nothing can dispatch from a restore that later proves
 * inconsistent, because nothing can dispatch at all until a human signs.
 *
 * Then, in order, it fences the old deployment's ingress and credentials,
 * checks the restored database against the sealed checkpoint (schema, product
 * state digests, keys, every object version), reconciles the shared pool
 * ledger, compares Temporal positions (a tenant restore against the live
 * namespace; a cluster restore against restored persistence), verifies every
 * run's audit stream and rebuilds its projections (importing archived batches
 * the database no longer holds), recovers every release identity the
 * independent archive holds, reconciles each with its provider, and proves a
 * physical stop for every pre-epoch worker through the original supervisor.
 * Restored rows alone never re-enable a worker.
 *
 * Each result is a finding: verified, reconciled, or blocked with its reason.
 * A blocked check (schema, state, key, object) keeps the whole tenant closed;
 * a blocked run, release, or worker keeps only that subject at the old epoch.
 * `sign` records a human tenant administrator's signature over the report's
 * digest, moves every unblocked run to the new epoch, and only then enables
 * service.
 */

export type FactoryRestoreMode = "tenant" | "cluster";
export type FactoryRestoreDisposition = "verified" | "reconciled" | "blocked";
export type FactoryRestoreSubject = "check" | "run" | "release" | "worker" | "pool" | "projection";

export class FactoryRestoreError extends Error {
  constructor(readonly code: "factory_restore_invalid" | "factory_restore_no_checkpoint" | "factory_restore_not_found" | "factory_restore_state" | "factory_restore_human_required" | "factory_restore_report_mismatch" | "factory_restore_blocked", options?: { cause?: unknown }) {
    super(code, options);
    this.name = "FactoryRestoreError";
  }
}

export interface FactoryRestoreFinding {
  readonly findingId: string;
  readonly subjectKind: FactoryRestoreSubject;
  readonly subjectId: string;
  readonly disposition: FactoryRestoreDisposition;
  readonly reason: string;
  readonly detail: Record<string, unknown>;
}

/** Whether an object version the checkpoint recorded still exists in the versioned ordinary store. */
export interface FactoryObjectVersionProbe {
  exists(blobDigest: string, storageVersion: string, signal?: AbortSignal): Promise<boolean>;
}

/** The original supervisor's stop, reached over its own authenticated transport. It signs; the restore verifies. */
export interface FactoryRestoreWorkerStopper {
  stop(command: FactoryHostStopCommand, signal: AbortSignal): Promise<FactoryPhysicalStopReceipt>;
}

/** Fences the old deployment outside the database. Each call records what it did; a refusal blocks the restore. */
export interface FactoryRestoreFence {
  closeIngress(restoreId: string, signal?: AbortSignal): Promise<string>;
  revokeCredentials(restoreId: string, signal?: AbortSignal): Promise<string>;
}

/** The shared pool ledger's restore half: re-create reservations it lost as `uncertain`. */
export interface FactoryRestorePoolLedger {
  importLost(tenantId: string, snapshot: readonly Record<string, unknown>[]): Promise<{ readonly present: readonly string[]; readonly imported: readonly string[]; readonly overcommitted: readonly string[] }>;
}

export interface FactoryRestoreOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  readonly installationId: string;
  readonly archive: FactoryRecoveryArchive & FactoryArchivedReleaseCatalog;
  readonly releaseArchive: Pick<FactoryReleaseArchive, "read">;
  /** Loads the installation data key from the restored wraps and the configured master keys. */
  readonly loadDataKey: () => Promise<InstallationDataKey>;
  readonly objects: FactoryObjectVersionProbe;
  readonly fence: FactoryRestoreFence;
  readonly workers: FactoryRestoreWorkerStopper;
  readonly hostKeys: ReadonlyMap<string, FactoryJournalHostKey>;
  readonly poolStops?: FactoryPoolStopAcknowledger;
  readonly pool?: FactoryRestorePoolLedger;
  readonly temporal?: FactoryCheckpointTemporalSource;
  /** The provider that owns an archived release's destination, or null when this installation has none for it. */
  readonly providers: (intent: FactoryArchivedReleaseIntent) => FactoryReleaseProvider | null;
  /** Rebuilds one run's projections by replaying its verified audit stream. */
  readonly projections?: { project(key: FactoryRunKey, limit?: number): Promise<unknown> };
  readonly now?: () => number;
  readonly monotonic?: () => number;
}

/** The release intent `FactoryReleases.ensureArchived` writes, read back from the archive alone. */
export interface FactoryArchivedReleaseIntent {
  readonly operationId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly candidateGeneration: number;
  readonly candidateDigest: string;
  readonly decisionId: string;
  readonly requestDigest: string;
  readonly destination: FactoryReleaseOperation["destination"];
  readonly request: unknown;
  readonly [key: string]: unknown;
}

export interface FactoryRestoreInput {
  readonly restoreId: string;
  readonly mode: FactoryRestoreMode;
  /** When the old deployment was lost, for the measured internal-progress loss. */
  readonly failureAtMs?: number;
  /** The sealed checkpoint to restore; the newest one in the archive when absent. */
  readonly checkpoint?: { readonly seal: FactoryCheckpointSeal; readonly manifest: FactoryCheckpointManifest };
}

export interface FactoryRestoreSession extends FactoryRestoreInput {
  readonly seal: FactoryCheckpointSeal;
  readonly manifest: FactoryCheckpointManifest;
  readonly previousEpoch: number;
  readonly executionEpoch: number;
  readonly started: number;
}

export interface FactoryRestoreReport {
  readonly schemaVersion: "factory.recovery-report.v1";
  readonly tenantId: string;
  readonly installationId: string;
  readonly restoreId: string;
  readonly mode: FactoryRestoreMode;
  readonly checkpointId: string;
  readonly manifestDigest: string;
  readonly previousEpoch: number;
  readonly executionEpoch: number;
  readonly findings: readonly FactoryRestoreFinding[];
  readonly blockedChecks: readonly string[];
  readonly blockedRuns: readonly string[];
  readonly blockedSubjects: readonly { readonly subjectKind: FactoryRestoreSubject; readonly subjectId: string; readonly reason: string }[];
  readonly releaseIdentities: { readonly archived: number; readonly recovered: number; readonly blocked: number };
  readonly measured: { readonly checkpointStartedAtMs: number; readonly failureAtMs: number | null; readonly internalProgressLossMs: number | null; readonly recoveryMs: number };
  readonly reportedAtMs: number;
}

function findingId(kind: FactoryRestoreSubject, subject: string, reason: string): string {
  return digestObject({ kind, subject, reason }).slice(0, 32);
}

/** HEADs one exact object version in the ordinary store with the restore's read-only credentials. */
export class S3FactoryObjectVersionProbe implements FactoryObjectVersionProbe {
  private readonly client: Pick<S3Client, "send">;
  constructor(private readonly options: { readonly endpoint: string; readonly bucket: string; readonly prefix: string; readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string }; readonly client?: Pick<S3Client, "send"> }) {
    s3ObjectKey(options.prefix, "0".repeat(64));
    this.client = options.client ?? new S3Client({ endpoint: options.endpoint, region: "us-east-1", forcePathStyle: true, credentials: options.credentials, maxAttempts: 1 });
  }

  async exists(blobDigest: string, storageVersion: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: s3ObjectKey(this.options.prefix, blobDigest), VersionId: storageVersion }), signal ? { abortSignal: signal } : undefined);
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || status === 400 || ["NotFound", "NoSuchKey", "NoSuchVersion"].includes((error as { name?: string }).name ?? "")) return false;
      throw error;
    }
  }
}

export class FactoryRestore {
  private readonly database: TransactionalDb;
  readonly tenantId: string;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly records: FactoryRecords;

  constructor(private readonly options: FactoryRestoreOptions) {
    assertFactoryIdentity(options.tenantId, options.installationId);
    this.database = options.database;
    this.tenantId = options.tenantId;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.records = new FactoryRecords(options.database, options.tenantId);
  }

  /** Opens a restore epoch and runs every check and reconciliation. Returns the report the human authority signs. */
  async begin(input: FactoryRestoreInput, signal?: AbortSignal): Promise<FactoryRestoreReport> {
    return this.verify(await this.open(input, signal), signal);
  }

  /**
   * Opens the epoch and nothing else: the installation epoch rises, the
   * restore gate closes admission and effect claims, and the chosen sealed
   * checkpoint is pinned. Service stays closed whatever `verify` later finds.
   */
  async open(input: FactoryRestoreInput, signal?: AbortSignal): Promise<FactoryRestoreSession> {
    assertFactoryIdentity(input.restoreId);
    if (input.mode !== "tenant" && input.mode !== "cluster") throw new FactoryRestoreError("factory_restore_invalid");
    const started = this.monotonic();
    const checkpoint = input.checkpoint ?? await latestFactoryCheckpoint(this.options.archive, this.tenantId, signal);
    if (!checkpoint) throw new FactoryRestoreError("factory_restore_no_checkpoint");
    const epoch = await this.openEpoch(input.restoreId, input.mode, checkpoint.manifest, checkpoint.seal);
    return Object.freeze({ ...input, ...checkpoint, ...epoch, started });
  }

  /** Every check and reconciliation for an opened epoch, recorded as findings, then the sealed report. */
  async verify(session: FactoryRestoreSession, signal?: AbortSignal): Promise<FactoryRestoreReport> {
    const { manifest, seal, restoreId } = session;
    const findings = new Map<string, FactoryRestoreFinding>();
    const record = async (finding: Omit<FactoryRestoreFinding, "findingId">) => {
      const complete = { ...finding, findingId: findingId(finding.subjectKind, finding.subjectId, finding.reason) };
      if (findings.has(complete.findingId)) return;
      findings.set(complete.findingId, complete);
      await this.database.execute(sql`INSERT INTO factory_restore_findings (tenant_id, restore_id, finding_id, subject_kind, subject_id, disposition, reason, detail_json)
        VALUES (${this.tenantId}, ${restoreId}, ${complete.findingId}, ${complete.subjectKind}, ${complete.subjectId}, ${complete.disposition}, ${complete.reason}, ${canonicalJson(complete.detail)}) ON CONFLICT (tenant_id, restore_id, finding_id) DO NOTHING`);
    };
    await this.fenceOldDeployment(restoreId, record, signal);
    await this.checkCompatibility(manifest, record, signal);
    await this.reconcilePool(manifest, record);
    await this.compareTemporal(session.mode, manifest, record, signal);
    await this.rebuildRuns(record, signal);
    const releases = await this.recoverReleases(restoreId, record, signal);
    await this.stopPreEpochWorkers(manifest, session.previousEpoch, record, signal);
    const all = [...findings.values()];
    const blocked = all.filter(finding => finding.disposition === "blocked");
    const report: FactoryRestoreReport = {
      schemaVersion: "factory.recovery-report.v1", tenantId: this.tenantId, installationId: this.options.installationId,
      restoreId, mode: session.mode, checkpointId: manifest.checkpointId, manifestDigest: seal.manifestDigest,
      previousEpoch: session.previousEpoch, executionEpoch: session.executionEpoch,
      findings: all,
      blockedChecks: blocked.filter(finding => finding.subjectKind === "check").map(finding => `${finding.subjectId}:${finding.reason}`),
      blockedRuns: [...new Set(blocked.filter(finding => finding.subjectKind === "run").map(finding => finding.subjectId))].sort(),
      blockedSubjects: blocked.filter(finding => finding.subjectKind !== "check").map(finding => ({ subjectKind: finding.subjectKind, subjectId: finding.subjectId, reason: finding.reason })),
      releaseIdentities: releases,
      measured: {
        checkpointStartedAtMs: manifest.startedAtMs, failureAtMs: session.failureAtMs ?? null,
        internalProgressLossMs: session.failureAtMs === undefined ? null : Math.max(0, session.failureAtMs - manifest.startedAtMs),
        recoveryMs: Math.round(this.monotonic() - session.started),
      },
      reportedAtMs: this.now(),
    };
    await writeFactoryRecoveryJson(this.options.archive, this.tenantId, "report", restoreId, report, signal);
    await this.database.execute(sql`UPDATE factory_restore_epochs SET state = 'awaiting_signature', report_json = ${canonicalJson(report)}, report_digest = ${factoryRestoreReportDigest(report)}, updated_at = NOW() WHERE tenant_id = ${this.tenantId} AND restore_id = ${restoreId} AND state = 'fenced'`);
    return report;
  }

  /**
   * A human tenant administrator signs the exact report, by digest. Only then
   * do unblocked runs move to the new epoch and service reopen. A report with
   * a blocked check cannot be signed into service.
   */
  async sign(restoreId: string, principal: FactoryPrincipal, reportDigest: string): Promise<{ readonly enabled: true; readonly rebound: number; readonly blockedRuns: readonly string[] }> {
    assertFactoryIdentity(restoreId);
    const actor = Object.freeze({ kind: principal.kind, id: principal.id, authentication: principal.authentication });
    if (actor.kind !== "user" || actor.authentication !== "session") throw new FactoryRestoreError("factory_restore_human_required");
    return this.database.transaction(async transaction => {
      const human = rows(await transaction.execute(sql`SELECT 1 FROM users WHERE id = ${actor.id} AND role = 'admin' AND status = 'active' FOR SHARE`));
      if (!human.length) throw new FactoryRestoreError("factory_restore_human_required");
      const epoch = rows<{ state: string; report_json: string | null; report_digest: string | null; execution_epoch: number | string; previous_epoch: number | string }>(await transaction.execute(sql`SELECT state, report_json, report_digest, execution_epoch, previous_epoch FROM factory_restore_epochs WHERE tenant_id = ${this.tenantId} AND restore_id = ${restoreId} FOR UPDATE`))[0];
      if (!epoch) throw new FactoryRestoreError("factory_restore_not_found");
      if (epoch.state !== "awaiting_signature") throw new FactoryRestoreError("factory_restore_state");
      if (epoch.report_digest !== reportDigest) throw new FactoryRestoreError("factory_restore_report_mismatch");
      const report = JSON.parse(epoch.report_json!) as FactoryRestoreReport;
      if (report.blockedChecks.length > 0) throw new FactoryRestoreError("factory_restore_blocked");
      const blockedRuns = new Set(report.blockedRuns);
      const previous = Number(epoch.previous_epoch), next = Number(epoch.execution_epoch);
      let rebound = 0;
      for (const run of rows<{ project_id: string; run_id: string }>(await transaction.execute(sql`SELECT project_id, run_id FROM factory_runs WHERE tenant_id = ${this.tenantId} AND execution_epoch = ${previous} ORDER BY project_id, run_id`))) {
        if (blockedRuns.has(canonicalJson([run.project_id, run.run_id]))) continue;
        await transaction.execute(sql`UPDATE factory_runs SET execution_epoch = ${next} WHERE tenant_id = ${this.tenantId} AND project_id = ${run.project_id} AND run_id = ${run.run_id}`);
        rebound += 1;
      }
      await transaction.execute(sql`UPDATE factory_restore_epochs SET state = 'enabled', signed_by = ${actor.id}, signed_at_ms = ${this.now()}, enabled_at_ms = ${this.now()}, updated_at = NOW() WHERE tenant_id = ${this.tenantId} AND restore_id = ${restoreId}`);
      await insertTransactionalAuditEntry(transaction, `factory-restore-enabled:${this.tenantId}:${restoreId}`, actor.id, "factory.restore.enabled", restoreId, { tenantId: this.tenantId, reportDigest, executionEpoch: next, rebound, blockedRuns: report.blockedRuns });
      return { enabled: true as const, rebound, blockedRuns: report.blockedRuns };
    });
  }

  private async openEpoch(restoreId: string, mode: FactoryRestoreMode, manifest: FactoryCheckpointManifest, seal: FactoryCheckpointSeal): Promise<{ readonly previousEpoch: number; readonly executionEpoch: number }> {
    if (manifest.tenantId !== this.tenantId || manifest.installationId !== this.options.installationId) throw new FactoryRestoreError("factory_restore_invalid");
    return this.database.transaction(async transaction => {
      const current = rows<{ execution_epoch: number | string }>(await transaction.execute(sql`SELECT execution_epoch FROM factory_installation WHERE tenant_id = ${this.tenantId} FOR UPDATE`))[0];
      if (!current) throw new FactoryRestoreError("factory_restore_invalid");
      if (rows(await transaction.execute(sql`SELECT 1 FROM factory_restore_epochs WHERE tenant_id = ${this.tenantId} AND state <> 'enabled' LIMIT 1`)).length) throw new FactoryRestoreError("factory_restore_state");
      const previousEpoch = Number(current.execution_epoch), executionEpoch = previousEpoch + 1;
      await transaction.execute(sql`INSERT INTO factory_restore_epochs (tenant_id, restore_id, mode, checkpoint_id, manifest_digest, previous_epoch, execution_epoch, state, started_at_ms)
        VALUES (${this.tenantId}, ${restoreId}, ${mode}, ${manifest.checkpointId}, ${seal.manifestDigest}, ${previousEpoch}, ${executionEpoch}, 'fenced', ${this.now()})`);
      await transaction.execute(sql`UPDATE factory_installation SET execution_epoch = ${executionEpoch} WHERE tenant_id = ${this.tenantId}`);
      await insertTransactionalAuditEntry(transaction, `factory-restore-opened:${this.tenantId}:${restoreId}`, null, "factory.restore.opened", restoreId, { tenantId: this.tenantId, checkpointId: manifest.checkpointId, previousEpoch, executionEpoch, mode });
      return { previousEpoch, executionEpoch };
    });
  }

  private async fenceOldDeployment(restoreId: string, record: (finding: Omit<FactoryRestoreFinding, "findingId">) => Promise<void>, signal?: AbortSignal): Promise<void> {
    for (const [name, fence] of [["ingress", () => this.options.fence.closeIngress(restoreId, signal)], ["credentials", () => this.options.fence.revokeCredentials(restoreId, signal)]] as const) {
      try { await record({ subjectKind: "check", subjectId: `fence-${name}`, disposition: "verified", reason: "fenced", detail: { evidence: await fence() } }); }
      catch (error) { await record({ subjectKind: "check", subjectId: `fence-${name}`, disposition: "blocked", reason: "fence_refused", detail: { error: error instanceof Error ? error.message : String(error) } }); }
    }
  }

  private async checkCompatibility(manifest: FactoryCheckpointManifest, record: (finding: Omit<FactoryRestoreFinding, "findingId">) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const schemaDigest = await factorySchemaDigest(this.database);
    await record(schemaDigest === manifest.product.schemaDigest
      ? { subjectKind: "check", subjectId: "schema", disposition: "verified", reason: "schema_matches", detail: { schemaDigest } }
      : { subjectKind: "check", subjectId: "schema", disposition: "blocked", reason: "incompatible_schema", detail: { expected: manifest.product.schemaDigest, restored: schemaDigest } });
    const { state } = await captureFactoryProductState(this.database, this.tenantId);
    const mismatched = (Object.keys(manifest.product.state) as (keyof typeof state)[]).filter(key => state[key] !== manifest.product.state[key]);
    await record(mismatched.length === 0
      ? { subjectKind: "check", subjectId: "database-position", disposition: "verified", reason: "state_matches_checkpoint", detail: { stateDigest: state.stateDigest, lsn: manifest.product.lsn } }
      : { subjectKind: "check", subjectId: "database-position", disposition: "blocked", reason: "database_position_mismatch", detail: { mismatched, lsn: manifest.product.lsn } });
    // The recorded wrap must be in the restored ledger byte for byte, and the
    // operator's master keys must open the installation's data key.
    const wrap = await factoryKeyWrapDigest(this.database, manifest.keys.installationId, manifest.keys.wrapVersion);
    let keyError: string | null = null;
    try { if ((await this.options.loadDataKey()).installationId !== manifest.keys.installationId) keyError = "installation_mismatch"; }
    catch (error) { keyError = error instanceof Error ? error.message : String(error); }
    const keyReason = wrap?.wrappedDigest !== manifest.keys.wrappedDigest ? "key_version_missing" : keyError !== null ? "key_missing" : null;
    await record(keyReason === null
      ? { subjectKind: "check", subjectId: "keys", disposition: "verified", reason: "key_version_opens", detail: { wrapVersion: manifest.keys.wrapVersion, masterKeyId: manifest.keys.masterKeyId } }
      : { subjectKind: "check", subjectId: "keys", disposition: "blocked", reason: keyReason, detail: { wrapVersion: manifest.keys.wrapVersion, masterKeyId: manifest.keys.masterKeyId, error: keyError } });
    const inventory = await readFactoryRecoveryJson<{ readonly objects: readonly { readonly objectId: string; readonly blobDigest: string; readonly storageVersion: string }[] }>(this.options.archive, parseFactoryArchiveReference(manifest.product.objects), signal);
    const missing: string[] = [];
    for (const object of inventory.objects) if (!await this.options.objects.exists(object.blobDigest, object.storageVersion, signal)) missing.push(object.objectId);
    await record(missing.length === 0
      ? { subjectKind: "check", subjectId: "object-versions", disposition: "verified", reason: "every_version_present", detail: { count: inventory.objects.length } }
      : { subjectKind: "check", subjectId: "object-versions", disposition: "blocked", reason: "object_version_missing", detail: { missing: missing.slice(0, 50), count: missing.length } });
  }

  private async reconcilePool(manifest: FactoryCheckpointManifest, record: (finding: Omit<FactoryRestoreFinding, "findingId">) => Promise<void>): Promise<void> {
    if (!manifest.pool.captured) { await record({ subjectKind: "pool", subjectId: "ledger", disposition: "blocked", reason: "pool_not_captured", detail: { reason: manifest.pool.reason } }); return; }
    if (!this.options.pool) { await record({ subjectKind: "pool", subjectId: "ledger", disposition: "blocked", reason: "pool_unavailable", detail: {} }); return; }
    const result = await this.options.pool.importLost(this.tenantId, manifest.pool.rows);
    for (const reservationId of result.imported) await record({ subjectKind: "pool", subjectId: reservationId, disposition: "reconciled", reason: "lost_reservation_reimported_uncertain", detail: {} });
    for (const reservationId of result.overcommitted) await record({ subjectKind: "pool", subjectId: reservationId, disposition: "blocked", reason: "capacity_overcommitted", detail: {} });
    await record({ subjectKind: "pool", subjectId: "ledger", disposition: "verified", reason: "ledger_compared", detail: { present: result.present.length, imported: result.imported.length, overcommitted: result.overcommitted.length } });
  }

  /**
   * A tenant restore keeps the live shared namespace: a workflow ahead of the
   * restored product stream means product facts after the checkpoint were
   * lost, so that run stays blocked and its lag is exposed. A cluster restore
   * restored Temporal persistence itself, so every position must equal the
   * checkpoint's.
   */
  private async compareTemporal(mode: FactoryRestoreMode, manifest: FactoryCheckpointManifest, record: (finding: Omit<FactoryRestoreFinding, "findingId">) => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!this.options.temporal) { await record({ subjectKind: "check", subjectId: "temporal", disposition: mode === "cluster" ? "blocked" : "verified", reason: mode === "cluster" ? "temporal_unavailable" : "no_live_namespace_reader", detail: {} }); return; }
    if (mode === "cluster" && !manifest.temporal.captured) { await record({ subjectKind: "check", subjectId: "temporal", disposition: "blocked", reason: "temporal_not_captured", detail: { reason: manifest.temporal.reason } }); return; }
    const recorded = new Map(manifest.temporal.captured ? manifest.temporal.workflows.map(workflow => [workflow.workflowId, workflow]) : []);
    const ids = manifest.product.liveRuns.flatMap(run => run.interpreters.map(interpreter => factoryInterpreterWorkflowId(this.tenantId, run.runId, interpreter.interpreterId)));
    const live = new Map((await this.options.temporal.positions(ids, signal)).map(position => [position.workflowId, position]));
    for (const run of manifest.product.liveRuns) {
      const subject = canonicalJson([run.projectId, run.runId]);
      const workflows = run.interpreters.map(interpreter => factoryInterpreterWorkflowId(this.tenantId, run.runId, interpreter.interpreterId));
      const differs = workflows.filter(id => mode === "cluster" ? live.get(id)?.historyLength !== recorded.get(id)?.historyLength : (live.get(id)?.historyLength ?? 0) > (recorded.get(id)?.historyLength ?? Number.POSITIVE_INFINITY));
      if (differs.length === 0) await record({ subjectKind: "run", subjectId: subject, disposition: "verified", reason: "temporal_position_consistent", detail: { workflows } });
      else await record({ subjectKind: "run", subjectId: subject, disposition: "blocked", reason: mode === "cluster" ? "temporal_position_mismatch" : "temporal_ahead_of_product", detail: { workflows: differs } });
    }
  }

  /**
   * Verifies every run's audit stream. A run whose primary rows expired is
   * re-materialized from its archived stream; a gap or conflict blocks the run.
   * Then every projection is discarded and rebuilt by replay.
   */
  private async rebuildRuns(record: (finding: Omit<FactoryRestoreFinding, "findingId">) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const runs = rows<{ project_id: string; run_id: string; archive_json: string | null; state: string | null }>(await this.database.execute(sql`SELECT r.project_id, r.run_id, t.archive_json, t.state FROM factory_runs r
      LEFT JOIN factory_retention_records t ON t.tenant_id = r.tenant_id AND t.subject_kind = 'run_audit' AND t.subject_id = ('[' || to_json(r.project_id::text)::text || ',' || to_json(r.run_id::text)::text || ']')
      WHERE r.tenant_id = ${this.tenantId} ORDER BY r.project_id, r.run_id`));
    for (const run of runs) {
      signal?.throwIfAborted();
      const key = { projectId: run.project_id, runId: run.run_id };
      const subject = canonicalJson([key.projectId, key.runId]);
      try {
        const held = await readFactoryRunAudit(this.records, key);
        let imported = 0;
        if (run.archive_json !== null) {
          const archived = await readFactoryArchivedRunAudit(this.options.archive, parseFactoryArchiveReference(run.archive_json), this.tenantId, key, signal);
          if (archived.length > held.length || run.state === "collected") imported = await importFactoryArchivedRunAudit(this.database, this.records, archived);
        }
        await this.database.transaction(async transaction => {
          const scoped = sql`tenant_id = ${this.tenantId} AND project_id = ${key.projectId} AND run_id = ${key.runId}`;
          await transaction.execute(sql`DELETE FROM factory_run_projection_attempts WHERE ${scoped}`);
          await transaction.execute(sql`DELETE FROM factory_run_projections WHERE ${scoped}`);
        });
        if (this.options.projections) await this.options.projections.project(key, 200);
        await record({ subjectKind: "projection", subjectId: subject, disposition: imported > 0 ? "reconciled" : "verified", reason: imported > 0 ? "audit_imported_from_archive" : "audit_verified", detail: { held: held.length, imported } });
      } catch (error) {
        const code = error instanceof FactoryRecordError ? error.code : error instanceof Error ? error.message : String(error);
        await record({ subjectKind: "run", subjectId: subject, disposition: "blocked", reason: "audit_unrecoverable", detail: { code } });
      }
    }
  }

  /**
   * Every release identity the archive holds is recovered: one the restored
   * database settled is verified; one it lacks, or holds unsettled, is
   * recorded from the archive and reconciled with its provider. Nothing is
   * dispatched.
   */
  private async recoverReleases(restoreId: string, record: (finding: Omit<FactoryRestoreFinding, "findingId">) => Promise<void>, signal?: AbortSignal): Promise<FactoryRestoreReport["releaseIdentities"]> {
    let archived = 0, recovered = 0, blocked = 0;
    for (const objects of await this.options.archive.operations(this.tenantId, signal)) {
      const intent = await this.latest<FactoryArchivedReleaseIntent>(objects.intent, value => value.operationId === objects.operationId && value.tenantId === this.tenantId);
      if (!intent) continue;
      archived += 1;
      const outcome = await this.recoverRelease(restoreId, intent, objects, signal);
      if (outcome.disposition === "blocked") blocked += 1; else recovered += 1;
      await record({ subjectKind: "release", subjectId: canonicalJson([intent.projectId, intent.operationId]), ...outcome });
      if (outcome.disposition === "blocked") await record({ subjectKind: "run", subjectId: canonicalJson([intent.projectId, intent.runId]), disposition: "blocked", reason: "release_unreconciled", detail: { operationId: intent.operationId } });
    }
    return { archived, recovered, blocked };
  }

  private async recoverRelease(restoreId: string, intent: FactoryArchivedReleaseIntent, objects: FactoryArchivedReleaseObjects, signal?: AbortSignal): Promise<Omit<FactoryRestoreFinding, "findingId" | "subjectKind" | "subjectId">> {
    const row = rows<{ state: string; receipt_json: string | null; dispatch_generation: string | number; request_digest: string }>(await this.database.execute(sql`SELECT state, receipt_json, dispatch_generation, request_digest FROM factory_release_operations WHERE tenant_id = ${this.tenantId} AND project_id = ${intent.projectId} AND operation_id = ${intent.operationId}`))[0];
    const receipt = await this.latest<FactoryProviderReceipt>(objects.receipt, value => value.operationId === intent.operationId && value.requestDigest === intent.requestDigest
      && value.provider === intent.destination.provider && value.account === intent.destination.account && value.object === intent.destination.object);
    if (row?.state === "succeeded" && row.receipt_json !== null && (!receipt || canonicalJson(JSON.parse(row.receipt_json)) === canonicalJson(receipt))) return { disposition: "verified", reason: "settled_in_restored_database", detail: { operationId: intent.operationId } };
    if (row && row.request_digest !== intent.requestDigest) return { disposition: "blocked", reason: "archive_conflicts_with_database", detail: { operationId: intent.operationId } };
    const provider = this.options.providers(intent);
    if (!provider) return this.recordRecovered(restoreId, intent, receipt, false, "provider_unavailable");
    const operation = { ...intent, tenantId: this.tenantId, dispatchGeneration: receipt?.dispatchGeneration ?? Number(row?.dispatch_generation ?? 0) } as unknown as FactoryReleaseOperation;
    if (receipt) {
      const verified = await provider.verifyReceipt(operation, receipt, { source: "release-archive", restoreId }, signal);
      return this.recordRecovered(restoreId, intent, receipt, verified, verified ? "receipt_verified_by_provider" : "receipt_unverified");
    }
    const noEffect = await provider.proveNoEffect(operation, { operationId: intent.operationId, reason: "restore found no archived receipt" }, signal);
    return this.recordRecovered(restoreId, intent, null, false, noEffect ? "no_effect_proven" : "outcome_uncertain", noEffect);
  }

  private async recordRecovered(restoreId: string, intent: FactoryArchivedReleaseIntent, receipt: FactoryProviderReceipt | null, verified: boolean, reason: string, noEffect = false): Promise<Omit<FactoryRestoreFinding, "findingId" | "subjectKind" | "subjectId">> {
    await this.database.execute(sql`INSERT INTO factory_recovered_releases (tenant_id, project_id, operation_id, restore_id, run_id, dispatch_generation, intent_json, intent_digest, receipt_json, receipt_digest, provider_verified)
      VALUES (${this.tenantId}, ${intent.projectId}, ${intent.operationId}, ${restoreId}, ${intent.runId}, ${receipt?.dispatchGeneration ?? 0}, ${canonicalJson(intent)}, ${`sha256:${digestObject(intent)}`}, ${receipt ? canonicalJson(receipt) : null}, ${receipt ? `sha256:${digestObject(receipt)}` : null}, ${verified})
      ON CONFLICT (tenant_id, project_id, operation_id) DO UPDATE SET restore_id = EXCLUDED.restore_id, receipt_json = EXCLUDED.receipt_json, receipt_digest = EXCLUDED.receipt_digest, provider_verified = EXCLUDED.provider_verified`);
    return { disposition: verified || noEffect ? "reconciled" : "blocked", reason, detail: { operationId: intent.operationId, ...(receipt ? { providerReceiptId: receipt.providerReceiptId } : {}) } };
  }

  /** The newest archived JSON object that matches, read through the verifying archive. */
  private async latest<Value>(objects: readonly FactoryArchiveObject[], matches: (value: Value) => boolean): Promise<Value | null> {
    for (const object of [...objects].reverse()) {
      let value: Value;
      try { value = await readFactoryRecoveryJson<Value>(this.options.releaseArchive, object); } catch { continue; }
      if (value && typeof value === "object" && matches(value)) return value;
    }
    return null;
  }

  /**
   * Every attempt that was live at the old epoch — in the restored database or
   * fenced in the manifest — is stopped by its original supervisor, and the
   * signed receipt is verified against the configured host keys before the
   * worker counts as reconciled. An unconfirmed stop blocks the run.
   */
  private async stopPreEpochWorkers(manifest: FactoryCheckpointManifest, previousEpoch: number, record: (finding: Omit<FactoryRestoreFinding, "findingId">) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const live = rows<{ attempt_id: string; project_id: string; run_id: string; reservation_id: string; worker_id: string; holder_generation: string | number; allocation_generation: string | number; host_id: string }>(await this.database.execute(sql`SELECT attempt_id, project_id, run_id, reservation_id, worker_id, holder_generation, allocation_generation, host_id FROM factory_attempt_launches
      WHERE tenant_id = ${this.tenantId} AND state IN ('launching','launched','uncertain') ORDER BY attempt_id`));
    const known = new Set(live.map(row => row.attempt_id));
    const fencedOnly = manifest.fenced.attempts.filter(attempt => !known.has(attempt.attemptId));
    for (const attempt of fencedOnly) await record({ subjectKind: "worker", subjectId: attempt.attemptId, disposition: "blocked", reason: "fenced_attempt_missing_from_database", detail: { runId: attempt.runId, hostId: attempt.hostId } });
    for (const row of live) {
      const command: FactoryHostStopCommand = { attemptId: row.attempt_id, reservationId: row.reservation_id, workerId: row.worker_id, holderGeneration: Number(row.holder_generation), allocationGeneration: Number(row.allocation_generation), hostId: row.host_id, reason: "lease-revoked" };
      const subject = canonicalJson([row.project_id, row.run_id]);
      try {
        const receipt = await this.options.workers.stop(command, signal ?? new AbortController().signal);
        const verdict = validateFactoryStopReceipt(command, receipt, this.options.hostKeys);
        if (!verdict.ok) throw new Error(verdict.issues[0]!.code);
        await this.options.poolStops?.confirmStopped({ reservationId: command.reservationId, holderGeneration: command.holderGeneration, hostId: command.hostId }, signal);
        await record({ subjectKind: "worker", subjectId: row.attempt_id, disposition: "reconciled", reason: "physical_stop_proven", detail: { receiptDigest: receipt.receiptDigest, hostId: receipt.hostId, previousEpoch } });
      } catch (error) {
        await record({ subjectKind: "worker", subjectId: row.attempt_id, disposition: "blocked", reason: "worker_stop_unproven", detail: { error: error instanceof Error ? error.message : String(error) } });
        await record({ subjectKind: "run", subjectId: subject, disposition: "blocked", reason: "worker_unreconciled", detail: { attemptId: row.attempt_id } });
      }
    }
  }
}

/**
 * A cluster-wide Temporal disaster: every tenant on the cluster enters its
 * restore epoch before any tenant is verified, so no tenant can dispatch
 * against restored Temporal persistence while another is still being checked.
 */
export async function runFactoryClusterRestore(restores: readonly { readonly restore: FactoryRestore; readonly restoreId: string; readonly failureAtMs?: number }[], signal?: AbortSignal): Promise<readonly FactoryRestoreReport[]> {
  const sessions: { readonly restore: FactoryRestore; readonly session: FactoryRestoreSession }[] = [];
  for (const entry of restores) sessions.push({ restore: entry.restore, session: await entry.restore.open({ restoreId: entry.restoreId, mode: "cluster", ...(entry.failureAtMs === undefined ? {} : { failureAtMs: entry.failureAtMs }) }, signal) });
  const reports: FactoryRestoreReport[] = [];
  for (const { restore, session } of sessions) reports.push(await restore.verify(session, signal));
  return reports;
}

/** The digest a human signs. The report is canonical JSON, so the digest names exactly these facts. */
export function factoryRestoreReportDigest(report: FactoryRestoreReport): string { return `sha256:${digestObject(report)}`; }
