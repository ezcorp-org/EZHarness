import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { digestObject } from "../../extensions/v4/blobs";
import { factoryIdempotencyKey, idempotencyInputDigest, isFactoryIdempotencyKey } from "../../idempotency";
import { assertFactoryIdentity, encodeFactoryPayload } from "../records";
import {
  legacyWorkflowClassificationDigest,
  type LegacyWorkflowClassification,
} from "./classification";
import {
  legacyWorkflowIsTerminal,
  mapLegacyWorkflowStatus,
  type LegacyWorkflowOutcome,
  type LegacyWorkflowRunFacts,
} from "./status";

export const LEGACY_WORKFLOW_JOURNAL_SCHEMA_VERSION = "factory.legacy-journal.v1" as const;
export const LEGACY_WORKFLOW_ATTESTATION_SCHEMA_VERSION = "factory.legacy-attestation.v1" as const;

export class FactoryLegacyWorkflowError extends Error {
  constructor(readonly code:
    | "factory_legacy_invalid"
    | "factory_legacy_scope"
    | "factory_legacy_unattested"
    | "factory_legacy_conflict"
    | "factory_legacy_corrupt"
    | "factory_legacy_not_found") {
    super(code);
    this.name = "FactoryLegacyWorkflowError";
  }
}

/** The exact parent attempt a wrapped legacy run belongs to. */
export interface FactoryLegacyAttemptKey {
  readonly projectId: string;
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly candidateGeneration: number;
  readonly attemptId: string;
}

export interface FactoryLegacyStartRequest extends FactoryLegacyAttemptKey {
  readonly workflowName: string;
  readonly classification: LegacyWorkflowClassification;
  readonly input: Record<string, unknown>;
  readonly userId?: string;
}

/** A human tenant administrator's attestation for a publishing workflow. */
export interface FactoryLegacyAttestation {
  readonly schemaVersion: typeof LEGACY_WORKFLOW_ATTESTATION_SCHEMA_VERSION;
  readonly projectId: string;
  readonly workflowName: string;
  readonly definitionDigest: string;
  readonly classificationDigest: string;
  readonly attestedBy: string;
  readonly attestationDigest: string;
  readonly revoked: boolean;
}

export interface FactoryLegacyJournalRecord extends FactoryLegacyAttemptKey {
  readonly schemaVersion: typeof LEGACY_WORKFLOW_JOURNAL_SCHEMA_VERSION;
  readonly workflowName: string;
  readonly definitionDigest: string;
  readonly classificationDigest: string;
  readonly attestationDigest: string | null;
  readonly inputDigest: string;
  readonly idempotencyKey: string;
  readonly journalDigest: string;
  readonly legacyRunId: string | null;
  readonly state: "journaled" | "started" | "settled";
}

/**
 * The legacy engine, as the adapter uses it.
 *
 * A seam rather than a direct import, for three reasons: the adapter must
 * stay opaque about the engine's internal steps (C10), `lookup` must be a
 * read that provably cannot create a run, and a crash between journal and
 * start has to be reproducible without killing a process.
 */
export interface FactoryLegacyEngine {
  /** Starts the pinned workflow under the caller's `factory:` key. */
  start(request: {
    readonly workflowName: string;
    readonly idempotencyKey: string;
    readonly input: Record<string, unknown>;
    readonly projectId: string;
    readonly userId?: string;
  }): Promise<{ readonly legacyRunId: string }>;
  /** Reads a run by its key. Never starts one. */
  lookup(workflowName: string, idempotencyKey: string): Promise<{ readonly legacyRunId: string } | null>;
  /** The mapping facts for one legacy run, read at `observedAtMs`. */
  facts(legacyRunId: string, observedAtMs: number): Promise<LegacyWorkflowRunFacts | null>;
}

export interface FactoryLegacyStartResult {
  readonly legacyRunId: string;
  /**
   * True when this call did not create the run.
   *
   * Either the journal already recorded one, or the key lookup found one the
   * engine had already created before the adapter recorded it. Both are the
   * crash path, and both are indistinguishable from the engine's side, which
   * is why the lookup runs on every call rather than only after a crash.
   */
  readonly adopted: boolean;
}

interface JournalRow {
  project_id: string; run_id: string; node_instance_id: string; candidate_generation: number | string; attempt_id: string;
  idempotency_key: string; workflow_name: string; definition_digest: string; classification_digest: string;
  attestation_digest: string | null; input_digest: string; journal_digest: string; legacy_run_id: string | null;
  state: "journaled" | "started" | "settled";
}

interface AttestationRow {
  project_id: string; workflow_name: string; definition_digest: string; classification_digest: string;
  attested_by: string; attestation_digest: string; revoked: boolean;
}

const journalColumns = sql.raw("project_id,run_id,node_instance_id,candidate_generation,attempt_id,idempotency_key,workflow_name,definition_digest,classification_digest,attestation_digest,input_digest,journal_digest,legacy_run_id,state");
const attestationColumns = sql.raw("project_id,workflow_name,definition_digest,classification_digest,attested_by,attestation_digest,revoked");

/**
 * The caller-facing key, in the namespace reserved for factory-owned starts.
 *
 * Derived from the exact attempt rather than supplied, so two attempts of the
 * same node can never collide and one attempt can never mint two runs. The
 * `nested:` namespace stays the engine's own, per C10.
 */
export function factoryLegacyIdempotencyKey(key: FactoryLegacyAttemptKey): string {
  return factoryIdempotencyKey(`legacy:${digestObject({
    projectId: key.projectId,
    runId: key.runId,
    nodeInstanceId: key.nodeInstanceId,
    candidateGeneration: key.candidateGeneration,
    attemptId: key.attemptId,
  })}`);
}

function assertAttemptKey(key: FactoryLegacyAttemptKey): void {
  assertFactoryIdentity(key.projectId, key.runId, key.nodeInstanceId, key.attemptId);
  if (!Number.isSafeInteger(key.candidateGeneration) || key.candidateGeneration < 0) throw new FactoryLegacyWorkflowError("factory_legacy_invalid");
}

function journalRecord(row: JournalRow): FactoryLegacyJournalRecord {
  const record: FactoryLegacyJournalRecord = {
    schemaVersion: LEGACY_WORKFLOW_JOURNAL_SCHEMA_VERSION,
    projectId: row.project_id,
    runId: row.run_id,
    nodeInstanceId: row.node_instance_id,
    candidateGeneration: Number(row.candidate_generation),
    attemptId: row.attempt_id,
    workflowName: row.workflow_name,
    definitionDigest: row.definition_digest,
    classificationDigest: row.classification_digest,
    attestationDigest: row.attestation_digest,
    inputDigest: row.input_digest,
    idempotencyKey: row.idempotency_key,
    journalDigest: row.journal_digest,
    legacyRunId: row.legacy_run_id,
    state: row.state,
  };
  if (journalDigest(record) !== row.journal_digest) throw new FactoryLegacyWorkflowError("factory_legacy_corrupt");
  return Object.freeze(record);
}

/**
 * The sealed intent, over every fact the start depends on.
 *
 * `legacyRunId` and `state` are excluded on purpose: they are what the start
 * ESTABLISHES, so including them would make the seal unverifiable the moment
 * the run exists.
 */
function journalDigest(record: Omit<FactoryLegacyJournalRecord, "journalDigest" | "legacyRunId" | "state"> & Partial<FactoryLegacyJournalRecord>): string {
  return `sha256:${digestObject({
    schemaVersion: LEGACY_WORKFLOW_JOURNAL_SCHEMA_VERSION,
    projectId: record.projectId,
    runId: record.runId,
    nodeInstanceId: record.nodeInstanceId,
    candidateGeneration: record.candidateGeneration,
    attemptId: record.attemptId,
    workflowName: record.workflowName,
    definitionDigest: record.definitionDigest,
    classificationDigest: record.classificationDigest,
    attestationDigest: record.attestationDigest,
    inputDigest: record.inputDigest,
    idempotencyKey: record.idempotencyKey,
  })}`;
}

/**
 * The attestation seal, over the facts a human was shown.
 *
 * Every field is named rather than spread: `revoked` and the seal itself are
 * excluded by construction, so a caller that hands in a whole record cannot
 * accidentally fold them in and make the seal unverifiable.
 */
function attestationDigestOf(value: Omit<FactoryLegacyAttestation, "schemaVersion" | "attestationDigest" | "revoked">): string {
  return `sha256:${digestObject({
    schemaVersion: LEGACY_WORKFLOW_ATTESTATION_SCHEMA_VERSION,
    projectId: value.projectId,
    workflowName: value.workflowName,
    definitionDigest: value.definitionDigest,
    classificationDigest: value.classificationDigest,
    attestedBy: value.attestedBy,
  })}`;
}

function attestation(row: AttestationRow): FactoryLegacyAttestation {
  const value: FactoryLegacyAttestation = {
    schemaVersion: LEGACY_WORKFLOW_ATTESTATION_SCHEMA_VERSION,
    projectId: row.project_id,
    workflowName: row.workflow_name,
    definitionDigest: row.definition_digest,
    classificationDigest: row.classification_digest,
    attestedBy: row.attested_by,
    attestationDigest: row.attestation_digest,
    revoked: row.revoked,
  };
  if (attestationDigestOf(value) !== row.attestation_digest) throw new FactoryLegacyWorkflowError("factory_legacy_corrupt");
  return Object.freeze(value);
}

/**
 * The `legacy.workflow.v1` adapter's durable half.
 *
 * It owns three facts and nothing else: which publishing workflows a human
 * administrator attested, the journal that makes a start recoverable, and the
 * mapping from the legacy engine's row to a factory outcome. It never answers
 * an approval, never re-grants release authority, and never resumes a run the
 * engine calls terminal.
 */
export class FactoryLegacyWorkflows {
  constructor(private readonly database: TransactionalDb, readonly tenantId: string) {
    assertFactoryIdentity(tenantId);
  }

  /**
   * Records a human tenant administrator's attestation.
   *
   * Bound to the pinned definition digest AND to the classification digest,
   * so a definition change or a change in what the host could resolve when
   * the administrator looked both invalidate it. Re-attesting the same pair
   * returns the same sealed record; a different classification for the same
   * definition is a conflict, because that is two different things a human
   * could have been shown under one name.
   */
  async attest(input: { readonly projectId: string; readonly workflowName: string; readonly classification: LegacyWorkflowClassification; readonly attestedBy: string }): Promise<FactoryLegacyAttestation> {
    const captured = JSON.parse(encodeFactoryPayload(input)) as typeof input;
    assertFactoryIdentity(captured.projectId, captured.attestedBy);
    if (captured.workflowName.length === 0 || captured.workflowName.length > 256) throw new FactoryLegacyWorkflowError("factory_legacy_invalid");
    const classificationDigest = legacyWorkflowClassificationDigest(captured.classification);
    const facts = {
      projectId: captured.projectId,
      workflowName: captured.workflowName,
      definitionDigest: captured.classification.definitionDigest,
      classificationDigest,
      attestedBy: captured.attestedBy,
    };
    const digest = attestationDigestOf(facts);
    return this.database.transaction(async transaction => {
      const existing = await this.attestationInTransaction(transaction, captured.projectId, captured.workflowName, captured.classification.definitionDigest, true);
      if (existing) {
        if (existing.attestationDigest !== digest) throw new FactoryLegacyWorkflowError("factory_legacy_conflict");
        return existing;
      }
      await transaction.execute(sql`INSERT INTO factory_legacy_attestations (tenant_id,project_id,workflow_name,definition_digest,classification_digest,classification_json,attested_by,attestation_digest,revoked) VALUES (${this.tenantId},${facts.projectId},${facts.workflowName},${facts.definitionDigest},${classificationDigest},${encodeFactoryPayload(captured.classification)},${facts.attestedBy},${digest},FALSE)`);
      return Object.freeze({ schemaVersion: LEGACY_WORKFLOW_ATTESTATION_SCHEMA_VERSION, ...facts, attestationDigest: digest, revoked: false });
    });
  }

  /** Withdraws an attestation. The row is retained; a wrapped start stops being admitted. */
  async revokeAttestation(projectId: string, workflowName: string, definitionDigest: string): Promise<void> {
    assertFactoryIdentity(projectId);
    await this.database.transaction(async transaction => {
      const existing = await this.attestationInTransaction(transaction, projectId, workflowName, definitionDigest, true);
      if (!existing) throw new FactoryLegacyWorkflowError("factory_legacy_not_found");
      await transaction.execute(sql`UPDATE factory_legacy_attestations SET revoked=TRUE,updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND workflow_name=${workflowName} AND definition_digest=${definitionDigest}`);
    });
  }

  /**
   * Decides whether this classification may be wrapped at all.
   *
   * A `non-publishing` verdict needs nothing. A `publishing` one needs a live
   * attestation whose definition digest and classification digest both match,
   * which is what makes any definition change invalidate it.
   */
  async admitInTransaction(transaction: MigrationDb, projectId: string, workflowName: string, classification: LegacyWorkflowClassification): Promise<string | null> {
    if (classification.verdict === "non-publishing") return null;
    const digest = legacyWorkflowClassificationDigest(classification);
    const existing = await this.attestationInTransaction(transaction, projectId, workflowName, classification.definitionDigest, false);
    if (!existing || existing.revoked || existing.classificationDigest !== digest) throw new FactoryLegacyWorkflowError("factory_legacy_unattested");
    return existing.attestationDigest;
  }

  /**
   * Journals the intent, then starts the legacy run.
   *
   * The journal row commits in its own transaction BEFORE the engine is
   * called, so a crash at any point afterwards leaves a durable record of a
   * start that may or may not have happened. The key lookup then runs on
   * every call, not only after a crash: the engine cannot tell the two apart,
   * and a path taken only in recovery is a path nothing exercises.
   */
  async ensureStarted(request: FactoryLegacyStartRequest, engine: FactoryLegacyEngine): Promise<FactoryLegacyStartResult> {
    const captured = JSON.parse(encodeFactoryPayload(request)) as FactoryLegacyStartRequest;
    const journaled = await this.journal(captured);
    if (journaled.legacyRunId !== null) return Object.freeze({ legacyRunId: journaled.legacyRunId, adopted: true });
    const found = await engine.lookup(captured.workflowName, journaled.idempotencyKey);
    if (found) return Object.freeze({ legacyRunId: await this.record(journaled, found.legacyRunId), adopted: true });
    const started = await engine.start({
      workflowName: captured.workflowName,
      idempotencyKey: journaled.idempotencyKey,
      input: captured.input,
      projectId: captured.projectId,
      ...(captured.userId === undefined ? {} : { userId: captured.userId }),
    });
    return Object.freeze({ legacyRunId: await this.record(journaled, started.legacyRunId), adopted: false });
  }

  /** Reads the journal for one attempt. */
  async read(key: FactoryLegacyAttemptKey): Promise<FactoryLegacyJournalRecord | null> {
    assertAttemptKey(key);
    return this.database.transaction(transaction => this.journalInTransaction(transaction, key, false));
  }

  /**
   * Maps the engine's current row to a factory outcome and settles when it is terminal.
   *
   * `observedAtMs` is the caller's, never this module's clock: the lease
   * comparison is relative to the instant the row was read.
   */
  async observe(key: FactoryLegacyAttemptKey, engine: FactoryLegacyEngine, observedAtMs: number): Promise<LegacyWorkflowOutcome> {
    assertAttemptKey(key);
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) throw new FactoryLegacyWorkflowError("factory_legacy_invalid");
    const journal = await this.database.transaction(transaction => this.journalInTransaction(transaction, key, false));
    if (!journal || journal.legacyRunId === null) throw new FactoryLegacyWorkflowError("factory_legacy_not_found");
    const facts = await engine.facts(journal.legacyRunId, observedAtMs);
    if (!facts) throw new FactoryLegacyWorkflowError("factory_legacy_not_found");
    const outcome = mapLegacyWorkflowStatus(facts);
    if (legacyWorkflowIsTerminal(outcome) && journal.state !== "settled") {
      await this.database.transaction(transaction => transaction.execute(sql`UPDATE factory_legacy_workflow_starts SET state='settled',updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND node_instance_id=${key.nodeInstanceId} AND candidate_generation=${key.candidateGeneration} AND attempt_id=${key.attemptId} AND state='started'`));
    }
    return outcome;
  }

  private async journal(request: FactoryLegacyStartRequest): Promise<FactoryLegacyJournalRecord> {
    assertAttemptKey(request);
    if (request.workflowName.length === 0 || request.workflowName.length > 256) throw new FactoryLegacyWorkflowError("factory_legacy_invalid");
    const idempotencyKey = factoryLegacyIdempotencyKey(request);
    if (!isFactoryIdempotencyKey(idempotencyKey)) throw new FactoryLegacyWorkflowError("factory_legacy_invalid");
    const classificationDigest = legacyWorkflowClassificationDigest(request.classification);
    const inputDigest = idempotencyInputDigest({ input: request.input, projectId: request.projectId, userId: request.userId ?? null });
    return this.database.transaction(async transaction => {
      const attestationDigest = await this.admitInTransaction(transaction, request.projectId, request.workflowName, request.classification);
      const existing = await this.journalInTransaction(transaction, request, true);
      const intent = {
        schemaVersion: LEGACY_WORKFLOW_JOURNAL_SCHEMA_VERSION,
        projectId: request.projectId,
        runId: request.runId,
        nodeInstanceId: request.nodeInstanceId,
        candidateGeneration: request.candidateGeneration,
        attemptId: request.attemptId,
        workflowName: request.workflowName,
        definitionDigest: request.classification.definitionDigest,
        classificationDigest,
        attestationDigest,
        inputDigest,
        idempotencyKey,
      };
      const digest = journalDigest(intent);
      if (existing) {
        if (existing.journalDigest !== digest) throw new FactoryLegacyWorkflowError("factory_legacy_conflict");
        return existing;
      }
      await transaction.execute(sql`INSERT INTO factory_legacy_workflow_starts (tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_id,idempotency_key,workflow_name,definition_digest,classification_digest,attestation_digest,input_digest,journal_digest,legacy_run_id,state) VALUES (${this.tenantId},${intent.projectId},${intent.runId},${intent.nodeInstanceId},${intent.candidateGeneration},${intent.attemptId},${intent.idempotencyKey},${intent.workflowName},${intent.definitionDigest},${intent.classificationDigest},${intent.attestationDigest},${intent.inputDigest},${digest},NULL,'journaled')`);
      return Object.freeze({ ...intent, journalDigest: digest, legacyRunId: null, state: "journaled" as const });
    });
  }

  /**
   * Binds the legacy run to the journal, once.
   *
   * The conditional update is the fence: a second writer that raced to start
   * a different run finds `state='journaled'` already gone and loses, and the
   * re-read reports the winner's run rather than its own.
   */
  private async record(journal: FactoryLegacyJournalRecord, legacyRunId: string): Promise<string> {
    if (legacyRunId.length === 0) throw new FactoryLegacyWorkflowError("factory_legacy_invalid");
    return this.database.transaction(async transaction => {
      await transaction.execute(sql`UPDATE factory_legacy_workflow_starts SET legacy_run_id=${legacyRunId},state='started',updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${journal.projectId} AND run_id=${journal.runId} AND node_instance_id=${journal.nodeInstanceId} AND candidate_generation=${journal.candidateGeneration} AND attempt_id=${journal.attemptId} AND state='journaled'`);
      const current = await this.journalInTransaction(transaction, journal, true);
      if (!current || current.legacyRunId === null) throw new FactoryLegacyWorkflowError("factory_legacy_corrupt");
      return current.legacyRunId;
    });
  }

  private async journalInTransaction(transaction: MigrationDb, key: FactoryLegacyAttemptKey, lock: boolean): Promise<FactoryLegacyJournalRecord | null> {
    const found = rows<JournalRow>(await transaction.execute(sql`SELECT ${journalColumns} FROM factory_legacy_workflow_starts WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND node_instance_id=${key.nodeInstanceId} AND candidate_generation=${key.candidateGeneration} AND attempt_id=${key.attemptId} ${lock ? sql`FOR UPDATE` : sql``}`))[0];
    return found ? journalRecord(found) : null;
  }

  private async attestationInTransaction(transaction: MigrationDb, projectId: string, workflowName: string, definitionDigest: string, lock: boolean): Promise<FactoryLegacyAttestation | null> {
    const found = rows<AttestationRow>(await transaction.execute(sql`SELECT ${attestationColumns} FROM factory_legacy_attestations WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND workflow_name=${workflowName} AND definition_digest=${definitionDigest} ${lock ? sql`FOR UPDATE` : sql``}`))[0];
    return found ? attestation(found) : null;
  }
}
