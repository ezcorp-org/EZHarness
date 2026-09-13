import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { DELIVERY_STATES, DurableDeliveryQueue, durableInputHash, type DurableDeliveryRecord, type DurableDeliveryState, type DurableDeliveryStore } from "../delivery-queue/durable-delivery-queue";
import { FactoryGrantError } from "./grants";
import { FactoryRecordError } from "./records";
import type { FactoryExecutionJournal, FactoryAttemptAdmission, FactoryAttemptAuthority, FactoryDurableAttemptAdmission, FactoryDurableRunnerRequest } from "./executions";

const MAX_ATTEMPTS = 3;
const CLAIM_SCAN_LIMIT = 32;

export interface FactoryAttemptReference {
  readonly attemptId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly candidateGeneration: number;
  readonly attemptNumber: number;
  readonly grantRevision: number;
  readonly reservationGeneration: number;
  readonly executionEpoch: number;
  readonly cancellationEpoch: number;
  readonly requestDigest: string;
  readonly deadlineAtMs: number;
}

export interface FactoryAttemptDelivery extends DurableDeliveryRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly deduplicationId: string;
  readonly inputHash: string;
  readonly reference: FactoryAttemptReference;
}

export interface ClaimedFactoryAttempt {
  readonly delivery: FactoryAttemptDelivery;
  readonly request: FactoryDurableRunnerRequest;
}

export interface StoredFactoryAttempt {
  readonly delivery: FactoryAttemptDelivery;
  readonly request: FactoryDurableRunnerRequest;
}

export class FactoryAttemptQueueError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "FactoryAttemptQueueError";
  }
}

type AttemptRow = {
  tenant_id: string;
  project_id: string;
  run_id: string;
  attempt_id: string;
  deduplication_id: string;
  input_hash: string;
  state: DurableDeliveryState;
  attempts: number | string;
  max_attempts: number | string;
  available_at: number | string;
  lease_until: number | string;
  lease_token: string | null;
  failure_code: string | null;
  reference_json: unknown;
  created_at: Date | string;
};

function identity(...values: readonly string[]): void {
  if (values.some(value => typeof value !== "string" || value.length < 1 || value.length > 512 || value.includes("\0"))) throw new FactoryAttemptQueueError("factory_attempt_identity_invalid");
}

function counter(value: number, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new FactoryAttemptQueueError("factory_attempt_reference_invalid");
}

function referenceFor(authority: FactoryAttemptAuthority): FactoryAttemptReference {
  identity(authority.attemptId, authority.tenantId, authority.projectId, authority.runId, authority.nodeInstanceId);
  for (const value of [authority.candidateGeneration, authority.attemptNumber, authority.grantRevision, authority.reservationGeneration, authority.executionEpoch, authority.cancellationEpoch]) counter(value);
  if (!/^[a-f0-9]{64}$/.test(authority.requestDigest) || !(authority.deadlineAt instanceof Date)) throw new FactoryAttemptQueueError("factory_attempt_reference_invalid");
  const deadlineAtMs = authority.deadlineAt.getTime();
  counter(deadlineAtMs, true);
  return Object.freeze({ attemptId: authority.attemptId, tenantId: authority.tenantId, projectId: authority.projectId, runId: authority.runId, nodeInstanceId: authority.nodeInstanceId, candidateGeneration: authority.candidateGeneration, attemptNumber: authority.attemptNumber, grantRevision: authority.grantRevision, reservationGeneration: authority.reservationGeneration, executionEpoch: authority.executionEpoch, cancellationEpoch: authority.cancellationEpoch, requestDigest: authority.requestDigest, deadlineAtMs });
}

function authorityFor(reference: FactoryAttemptReference): FactoryAttemptAuthority {
  return { ...reference, deadlineAt: new Date(reference.deadlineAtMs) };
}

function snapshotAdmission<Input extends FactoryAttemptAdmission | FactoryDurableAttemptAdmission>(input: Input): Input {
  const reference = referenceFor(input);
  const request = JSON.parse(canonicalJson(input.request)) as Input["request"];
  return Object.freeze({ ...authorityFor(reference), request }) as Input;
}

function scope(tenantId: string, projectId: string): string {
  return `${tenantId}\0${projectId}`;
}

function storedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { throw new FactoryAttemptQueueError("factory_attempt_corrupt"); }
}

function safeInteger(value: number | string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new FactoryAttemptQueueError("factory_attempt_corrupt");
  return parsed;
}

function decode(row: AttemptRow): FactoryAttemptDelivery {
  try {
    const rawReference = storedJson(row.reference_json) as FactoryAttemptReference;
    const reference = referenceFor({ ...rawReference, deadlineAt: new Date(rawReference.deadlineAtMs) });
    identity(row.tenant_id, row.project_id, row.run_id, row.attempt_id, row.deduplication_id);
    const attempts = safeInteger(row.attempts, 0);
    const maxAttempts = safeInteger(row.max_attempts, 1);
    const availableAt = safeInteger(row.available_at, 0);
    const leaseUntil = safeInteger(row.lease_until, 0);
    const createdAt = new Date(row.created_at).getTime();
    counter(createdAt, true);
    if (!DELIVERY_STATES.includes(row.state) || maxAttempts > 10 || reference.tenantId !== row.tenant_id || reference.projectId !== row.project_id || reference.runId !== row.run_id || reference.attemptId !== row.attempt_id || row.deduplication_id !== row.attempt_id || durableInputHash(reference) !== row.input_hash || (row.lease_token !== null && (row.lease_token.length < 1 || row.lease_token.length > 512)) || (row.failure_code !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(row.failure_code))) throw new FactoryAttemptQueueError("factory_attempt_corrupt");
    return { id: row.attempt_id, tenantId: row.tenant_id, projectId: row.project_id, runId: row.run_id, deduplicationId: row.deduplication_id, inputHash: row.input_hash, reference, state: row.state, attempts, maxAttempts, availableAt, leaseUntil, ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }), ...(row.failure_code === null ? {} : { failureCode: row.failure_code }), createdAt };
  } catch (error) {
    if (error instanceof FactoryAttemptQueueError && error.code === "factory_attempt_corrupt") throw error;
    throw new FactoryAttemptQueueError("factory_attempt_corrupt");
  }
}

class FactoryAttemptStore implements DurableDeliveryStore<FactoryAttemptDelivery> {
  private readonly expectedScope: string;

  constructor(private readonly database: MigrationDb, private readonly tenantId: string, private readonly projectId: string, private readonly candidateId?: string) {
    this.expectedScope = scope(tenantId, projectId);
  }

  private assertScope(value: string | null): void {
    if (value !== this.expectedScope) throw new FactoryAttemptQueueError("factory_attempt_scope_mismatch");
  }

  private async one(fragment: ReturnType<typeof sql>): Promise<FactoryAttemptDelivery | null> {
    const row = rows<AttemptRow>(await this.database.execute(fragment))[0];
    return row ? decode(row) : null;
  }

  async findDuplicate(queueScope: string, deduplicationId: string): Promise<FactoryAttemptDelivery | null> {
    this.assertScope(queueScope);
    return this.one(sql`SELECT * FROM factory_attempt_queue WHERE tenant_id=${this.tenantId} AND project_id=${this.projectId} AND deduplication_id=${deduplicationId}`);
  }

  async insert(delivery: FactoryAttemptDelivery): Promise<boolean> {
    const inserted = rows(await this.database.execute(sql`INSERT INTO factory_attempt_queue
      (tenant_id,project_id,attempt_id,run_id,deduplication_id,input_hash,state,attempts,max_attempts,available_at,lease_until,lease_token,failure_code,reference_json)
      VALUES (${this.tenantId},${this.projectId},${delivery.id},${delivery.runId},${delivery.deduplicationId},${delivery.inputHash},${delivery.state},${delivery.attempts},${delivery.maxAttempts},${delivery.availableAt},${delivery.leaseUntil},${delivery.leaseToken ?? null},${delivery.failureCode ?? null},${canonicalJson(delivery.reference)}::jsonb)
      ON CONFLICT (tenant_id,project_id,deduplication_id) DO NOTHING RETURNING attempt_id`));
    return inserted.length === 1;
  }

  async claimCandidate(queueScope: string | null, now: number): Promise<FactoryAttemptDelivery | null> {
    this.assertScope(queueScope);
    if (!this.candidateId) throw new FactoryAttemptQueueError("factory_attempt_identity_invalid");
    return this.one(sql`UPDATE factory_attempt_queue SET updated_at=updated_at WHERE tenant_id=${this.tenantId} AND project_id=${this.projectId} AND attempt_id=${this.candidateId}
      AND ((state='queued' AND available_at<=${now}) OR (state='leased' AND lease_until<=${now})) RETURNING *`);
  }

  async findById(queueScope: string, id: string): Promise<FactoryAttemptDelivery | null> {
    this.assertScope(queueScope);
    return this.one(sql`SELECT * FROM factory_attempt_queue WHERE tenant_id=${this.tenantId} AND project_id=${this.projectId} AND attempt_id=${id} FOR UPDATE`);
  }

  async write(delivery: FactoryAttemptDelivery): Promise<void> {
    const updated = rows(await this.database.execute(sql`UPDATE factory_attempt_queue SET state=${delivery.state},attempts=${delivery.attempts},available_at=${delivery.availableAt},lease_until=${delivery.leaseUntil},lease_token=${delivery.leaseToken ?? null},failure_code=${delivery.failureCode ?? null},updated_at=NOW()
      WHERE tenant_id=${this.tenantId} AND project_id=${this.projectId} AND attempt_id=${delivery.id} RETURNING attempt_id`));
    if (updated.length !== 1) throw new FactoryAttemptQueueError("factory_attempt_not_found");
  }

  async inspect(queueScope: string, id: string): Promise<FactoryAttemptDelivery | null> {
    this.assertScope(queueScope);
    return this.one(sql`SELECT * FROM factory_attempt_queue WHERE tenant_id=${this.tenantId} AND project_id=${this.projectId} AND attempt_id=${id}`);
  }
}

const stateMachine = new DurableDeliveryQueue<FactoryAttemptDelivery>((code, message) => new FactoryAttemptQueueError(code, message), randomUUID);

function authorityRejected(error: unknown): boolean {
  return error instanceof FactoryGrantError || error instanceof FactoryRecordError || (error instanceof Error && ["Factory attempt is stale, cancelled, or expired.", "Factory run epoch is stale or unavailable."].includes(error.message));
}

/** Durable attempt dispatch queue. Only the execution journal stores runner request data. */
export class FactoryAttemptQueue {
  constructor(private readonly database: TransactionalDb, private readonly journal: FactoryExecutionJournal, readonly tenantId: string, private readonly now: () => number = Date.now) {
    identity(tenantId);
  }

  async enqueue(input: FactoryAttemptAdmission): Promise<FactoryAttemptDelivery> {
    const snapshot = snapshotAdmission(input);
    return this.database.transaction(transaction => this.enqueueSnapshotInTransaction(transaction, snapshot, this.now()));
  }

  async enqueueInTransaction(transaction: MigrationDb, input: FactoryAttemptAdmission): Promise<FactoryAttemptDelivery> {
    return this.enqueueSnapshotInTransaction(transaction, snapshotAdmission(input), this.now(), false);
  }

  /** Enqueue an identity that never contained an ephemeral bearer token. */
  async enqueueDurableInTransaction(transaction: MigrationDb, input: FactoryDurableAttemptAdmission): Promise<FactoryAttemptDelivery> {
    return this.enqueueSnapshotInTransaction(transaction, snapshotAdmission(input), this.now(), true);
  }

  async claim(leaseMs = 60_000): Promise<ClaimedFactoryAttempt | null> {
    const now = this.now();
    const candidates = rows<AttemptRow>(await this.database.execute(sql`SELECT * FROM factory_attempt_queue WHERE tenant_id=${this.tenantId}
      AND ((state='queued' AND available_at<=${now}) OR (state='leased' AND lease_until<=${now}))
      ORDER BY available_at,project_id,attempt_id LIMIT ${CLAIM_SCAN_LIMIT}`));
    for (const candidate of candidates) {
      let delivery: FactoryAttemptDelivery;
      try { delivery = decode(candidate); }
      catch (error) {
        if (!(error instanceof FactoryAttemptQueueError) || error.code !== "factory_attempt_corrupt") throw error;
        await this.quarantineCorrupt(candidate, now);
        continue;
      }
      const queueScope = scope(delivery.tenantId, delivery.projectId);
      if (delivery.state === "leased") {
        await this.database.transaction(transaction => stateMachine.claim(new FactoryAttemptStore(transaction, delivery.tenantId, delivery.projectId, delivery.id), queueScope, now, leaseMs));
        continue;
      }
      try {
        const claimed = await this.database.transaction(async transaction => {
          const request = await this.journal.requestInTransaction(transaction, authorityFor(delivery.reference));
          const current = await stateMachine.claim(new FactoryAttemptStore(transaction, delivery.tenantId, delivery.projectId, delivery.id), queueScope, now, leaseMs);
          return current ? { delivery: current, request } : null;
        });
        if (claimed) return claimed;
      } catch (error) {
        if (!authorityRejected(error)) throw error;
        try {
          await this.database.transaction(transaction => stateMachine.cancel(new FactoryAttemptStore(transaction, delivery.tenantId, delivery.projectId), queueScope, delivery.id, "authority_rejected"));
        } catch (cancellationError) {
          if (!(cancellationError instanceof FactoryAttemptQueueError) || !["delivery_already_dispatched", "not_found"].includes(cancellationError.code)) throw cancellationError;
        }
      }
    }
    return null;
  }

  async settle(claim: ClaimedFactoryAttempt, outcome: "delivered" | "retry" | "outcome_unknown", failureCode?: string): Promise<FactoryAttemptDelivery> {
    const delivery = JSON.parse(canonicalJson(claim.delivery)) as FactoryAttemptDelivery;
    if (delivery.tenantId !== this.tenantId || delivery.inputHash !== durableInputHash(delivery.reference)) throw new FactoryAttemptQueueError("factory_attempt_corrupt");
    return this.database.transaction(transaction => stateMachine.settle(new FactoryAttemptStore(transaction, delivery.tenantId, delivery.projectId), scope(delivery.tenantId, delivery.projectId), delivery, this.now(), outcome, failureCode));
  }

  async read(projectId: string, attemptId: string): Promise<FactoryAttemptDelivery | null> {
    return this.readInTransaction(this.database, projectId, attemptId);
  }

  async readInTransaction(transaction: MigrationDb, projectId: string, attemptId: string): Promise<FactoryAttemptDelivery | null> {
    identity(projectId, attemptId);
    return stateMachine.inspect(new FactoryAttemptStore(transaction, this.tenantId, projectId), scope(this.tenantId, projectId), attemptId);
  }

  /** Recover the exact journal request and its queue reference in one transaction. */
  async readStoredInTransaction(transaction: MigrationDb, projectId: string, attemptId: string): Promise<StoredFactoryAttempt | null> {
    const delivery = await this.readInTransaction(transaction, projectId, attemptId);
    if (!delivery) return null;
    const request = await this.journal.requestInTransaction(transaction, authorityFor(delivery.reference));
    return Object.freeze({ delivery, request });
  }

  private async enqueueSnapshotInTransaction(transaction: MigrationDb, input: FactoryAttemptAdmission | FactoryDurableAttemptAdmission, now: number, durable = false): Promise<FactoryAttemptDelivery> {
    if (input.tenantId !== this.tenantId) throw new FactoryAttemptQueueError("factory_attempt_scope_mismatch");
    const reference = referenceFor(input);
    const admitted = durable
      ? await this.journal.admitDurableInTransaction(transaction, input as FactoryDurableAttemptAdmission)
      : await this.journal.admitInTransaction(transaction, input as FactoryAttemptAdmission);
    if (admitted.requestHash !== reference.requestDigest) throw new FactoryAttemptQueueError("factory_attempt_corrupt");
    const inputHash = durableInputHash(reference);
    const queueScope = scope(reference.tenantId, reference.projectId);
    return stateMachine.enqueue(new FactoryAttemptStore(transaction, reference.tenantId, reference.projectId), { scope: queueScope, deduplicationId: reference.attemptId, inputHash, hashExisting: current => current.inputHash, create: () => ({ id: reference.attemptId, tenantId: reference.tenantId, projectId: reference.projectId, runId: reference.runId, deduplicationId: reference.attemptId, inputHash, reference, state: "queued", attempts: 0, maxAttempts: MAX_ATTEMPTS, availableAt: now, leaseUntil: 0, createdAt: now }) });
  }

  private async quarantineCorrupt(candidate: AttemptRow, now: number): Promise<void> {
    await this.database.transaction(async transaction => {
      await transaction.execute(sql`UPDATE factory_attempt_queue SET state='outcome_unknown',failure_code='queue_record_corrupt',lease_until=0,lease_token=NULL,updated_at=NOW()
        WHERE tenant_id=${this.tenantId} AND project_id=${candidate.project_id} AND attempt_id=${candidate.attempt_id}
          AND ((state='queued' AND available_at<=${now}) OR (state='leased' AND lease_until<=${now}))`);
    });
  }
}
