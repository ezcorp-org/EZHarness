import { isUnsignedDecimal, type KernelEvent } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { durableInputHash } from "../delivery-queue/durable-delivery-queue";
import type { FactoryBudgets } from "./budgets";
import { type FactoryAuthorizedCommand, FactoryCommandAuthorityError, type FactoryCommandAuthority } from "./command-authority";
import type { FactoryInbox } from "./inbox";
import { FactoryInstallationCommandOutbox, type FactoryCommandDelivery } from "./outbox";
import { parsePoolDecision, type PoolAdmissionClient } from "./pool/client";
import { normalizePoolResourceVector, POOL_RESOURCE_CLASSES, type PoolDecision, type PoolLease, type PoolLeaseStatus } from "./pool/ledger";
import { assertFactoryIdentity, encodeFactoryPayload } from "./records";
import { factoryTaskReservationId, type FactoryComputeAdmissionRequest } from "./task-admission";
import { factoryExecutionFence } from "./run-lifecycle";
import type { TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

const POLL_INTERVAL_MS = 1_000;
const POLL_LEASE_MS = 60_000;
const activeStates = ["pending", "queued", "cancelling"] as const;
type ActiveState = typeof activeStates[number];
type AdmissionState = ActiveState | "admitted" | "rejected" | "cancelled";
type AdmissionEvent = Extract<KernelEvent, { kind: "admission-result" }>;

interface AdmissionRow {
  tenant_id: string;
  project_id: string;
  run_id: string;
  reservation_id: string;
  request_digest: string;
  request_json: string;
  state: AdmissionState;
  next_poll_at: number | string;
  remote_attempted: boolean;
  poll_lease_until: number | string;
  poll_lease_token: string | null;
  response_digest: string | null;
  response_json: string | null;
  event_digest: string | null;
  event_json: string | null;
}
interface BudgetReservationRow { readonly state: string; readonly compute_allocation: string | null }

interface ClaimedAdmission { readonly row: AdmissionRow; readonly input: FactoryComputeAdmissionRequest; readonly token: string }
export interface FactoryComputeAdmissionKey { readonly projectId: string; readonly runId: string; readonly reservationId: string }
export interface FactoryComputeAdmissionReceipt { readonly lease: PoolLease; readonly event: AdmissionEvent }
export interface FactoryComputeAdmissionMaterial { readonly request: FactoryComputeAdmissionRequest; readonly receipt: FactoryComputeAdmissionReceipt }
export type FactoryComputeAdmissionDispatchResult =
  | { readonly status: "idle" }
  | { readonly status: "busy"; readonly reservationId: string }
  | { readonly status: "queued"; readonly reservationId: string; readonly retryAtMs: number }
  | { readonly status: "admitted"; readonly reservationId: string; readonly receipt: FactoryComputeAdmissionReceipt }
  | { readonly status: "rejected"; readonly reservationId: string; readonly decision: PoolDecision; readonly event: AdmissionEvent }
  | { readonly status: "cancelling" | "cancelled"; readonly reservationId: string }
  | { readonly status: "retry"; readonly reservationId: string; readonly reason: string };

export class FactoryComputeAdmissionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryComputeAdmissionError"; }
}

function nowValue(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new FactoryComputeAdmissionError("factory_compute_admission_clock_invalid");
  return value;
}

function canonical<T>(value: T): { readonly value: T; readonly json: string; readonly digest: string } {
  const json = encodeFactoryPayload(value);
  return { value: JSON.parse(json) as T, json, digest: durableInputHash(JSON.parse(json)) };
}

function canonicalDecision(value: PoolDecision): ReturnType<typeof canonical<unknown>> {
  if (value.status !== "admitted") return canonical(value);
  const deadlineAt = value.lease?.deadlineAt;
  if (!(deadlineAt instanceof Date) || !Number.isFinite(deadlineAt.getTime())) throw new FactoryComputeAdmissionError("factory_compute_admission_invalid");
  return canonical({ ...value, lease: { ...value.lease, deadlineAt: deadlineAt.toISOString() } });
}

function snapshotRequest(value: FactoryComputeAdmissionRequest, tenantId: string): ReturnType<typeof canonical<FactoryComputeAdmissionRequest>> {
  const snapshot = canonical(value).value;
  if (snapshot.schemaVersion !== "factory.compute-admission.v1") throw new FactoryComputeAdmissionError("factory_compute_admission_invalid");
  assertFactoryIdentity(snapshot.reference.tenantId, snapshot.reference.projectId, snapshot.reference.logicalRunId, snapshot.reference.interpreterId, snapshot.reference.commandId, snapshot.request.reservationId);
  if (snapshot.reference.tenantId !== tenantId || snapshot.fence.tenantId !== tenantId || snapshot.reference.projectId !== snapshot.fence.projectId || snapshot.reference.logicalRunId !== snapshot.fence.runId || snapshot.request.grantScope !== `${tenantId}:factory` || snapshot.request.grantRevision !== snapshot.fence.grantRevision) throw new FactoryComputeAdmissionError("factory_compute_admission_scope");
  if (!Number.isSafeInteger(snapshot.memoryBytes) || snapshot.memoryBytes < 1 || typeof snapshot.budget.costMicros !== "string" || snapshot.budget.costMicros.length > 78 || !isUnsignedDecimal(snapshot.budget.costMicros) || !Number.isSafeInteger(snapshot.budget.tokens) || snapshot.budget.tokens < 0 || !Number.isSafeInteger(snapshot.budget.computeMs) || snapshot.budget.computeMs < 0) throw new FactoryComputeAdmissionError("factory_compute_admission_invalid");
  const deadline = Date.parse(snapshot.request.admissionDeadline);
  if (!Number.isSafeInteger(deadline) || new Date(deadline).toISOString() !== snapshot.request.admissionDeadline) throw new FactoryComputeAdmissionError("factory_compute_admission_invalid");
  return canonical({ ...snapshot, request: { ...snapshot.request, resources: normalizePoolResourceVector(snapshot.request.resources) } });
}

function decodeRequest(row: AdmissionRow, tenantId: string): FactoryComputeAdmissionRequest {
  let value: unknown;
  try { value = JSON.parse(row.request_json); }
  catch { throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt"); }
  const input = snapshotRequest(value as FactoryComputeAdmissionRequest, tenantId);
  if (input.digest !== row.request_digest || input.value.reference.projectId !== row.project_id || input.value.reference.logicalRunId !== row.run_id || input.value.request.reservationId !== row.reservation_id || row.tenant_id !== tenantId) throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt");
  return input.value;
}

function decodeResponse(row: AdmissionRow): unknown {
  if (row.response_json === null || row.response_digest === null) return undefined;
  let value: unknown;
  try { value = JSON.parse(row.response_json); }
  catch { throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt"); }
  if (durableInputHash(value) !== row.response_digest) throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt");
  return value;
}

function decodeEvent(row: AdmissionRow): AdmissionEvent {
  if (row.event_json === null || row.event_digest === null) throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt");
  let value: unknown;
  try { value = JSON.parse(row.event_json); }
  catch { throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt"); }
  if (durableInputHash(value) !== row.event_digest || (value as AdmissionEvent).kind !== "admission-result") throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt");
  return value as AdmissionEvent;
}

function decodeDecision(row: AdmissionRow): PoolDecision {
  try { return parsePoolDecision(decodeResponse(row)); }
  catch (error) {
    if (error instanceof FactoryComputeAdmissionError) throw error;
    throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt");
  }
}

function assertDecisionBinding(decision: PoolDecision, input: FactoryComputeAdmissionRequest): void {
  if (decision.reservationId !== input.request.reservationId) throw new FactoryComputeAdmissionError("factory_compute_admission_invalid");
  if (decision.status !== "admitted") return;
  const lease = decision.lease!;
  if (lease.tenantId !== input.reference.tenantId || lease.grantRevision !== input.request.grantRevision || lease.deadlineAt.getTime() > Date.parse(input.request.admissionDeadline) || POOL_RESOURCE_CLASSES.some(resourceClass => lease.resources[resourceClass] !== input.request.resources[resourceClass])) throw new FactoryComputeAdmissionError("factory_compute_admission_invalid");
}

function validatedDecision(value: PoolDecision, input: FactoryComputeAdmissionRequest): PoolDecision {
  let decision: PoolDecision;
  try { decision = parsePoolDecision(JSON.parse(canonicalDecision(value).json)); }
  catch (error) {
    if (error instanceof FactoryComputeAdmissionError) throw error;
    throw new FactoryComputeAdmissionError("factory_compute_admission_invalid");
  }
  assertDecisionBinding(decision, input);
  return decision;
}

function terminalResult(row: AdmissionRow, input: FactoryComputeAdmissionRequest): FactoryComputeAdmissionDispatchResult | undefined {
  if (row.state === "admitted" || row.state === "rejected") {
    const decision = decodeDecision(row);
    const event = decodeEvent(row);
    if (decision.reservationId !== row.reservation_id || event.granted !== (row.state === "admitted") || event.commandId !== input.reference.commandId || !Number.isSafeInteger(event.atMs) || event.atMs < 0 || !Number.isSafeInteger(event.candidateGeneration) || event.candidateGeneration < 1) throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt");
    if (row.state === "admitted") {
      if (decision.status !== "admitted") throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt");
      try { assertDecisionBinding(decision, input); }
      catch { throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt"); }
      return { status: "admitted", reservationId: row.reservation_id, receipt: { lease: decision.lease!, event } };
    }
    if (decision.status !== "rejected" && decision.status !== "cancelled") throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt");
    return { status: "rejected", reservationId: row.reservation_id, decision, event };
  }
  if (row.state === "cancelled") return { status: "cancelled", reservationId: row.reservation_id };
  return undefined;
}

function rowResult<Result>(result: readonly Result[]): Result | undefined { return result[0]; }
function retryCode(error: unknown): string { return error instanceof FactoryComputeAdmissionError ? error.code : "factory_compute_admission_transport"; }
function authorityLost(error: unknown): boolean {
  if (error instanceof FactoryCommandAuthorityError) return true;
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && ["factory_forbidden", "factory_grant_stale", "factory_run_fence_changed", "factory_run_not_found", "factory_run_stopped", "factory_scope_mismatch", "factory_service_credential_forbidden"].includes(code);
}

function decodeAllocation(row: BudgetReservationRow): { readonly allocationToken: string; readonly reservationGeneration: number } {
  let value: unknown;
  try { value = row.compute_allocation === null ? null : JSON.parse(row.compute_allocation); }
  catch { throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt"); }
  const allocation = value as { allocationToken?: unknown; reservationGeneration?: unknown } | null;
  if (!allocation || Object.keys(allocation).sort().join(",") !== "allocationToken,reservationGeneration" || typeof allocation.allocationToken !== "string" || !Number.isSafeInteger(allocation.reservationGeneration) || Number(allocation.reservationGeneration) < 1) throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt");
  return { allocationToken: allocation.allocationToken, reservationGeneration: Number(allocation.reservationGeneration) };
}

/** Product-side scheduler for exact, recoverable C03 pool admissions. */
export class FactoryComputeAdmissions {
  private readonly outbox: FactoryInstallationCommandOutbox;

  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly authority: FactoryCommandAuthority, private readonly budgets: FactoryBudgets, private readonly inbox: FactoryInbox, private readonly pool: PoolAdmissionClient, private readonly now: () => number = Date.now) {
    assertFactoryIdentity(tenantId);
    if (authority.tenantId !== tenantId || inbox.tenantId !== tenantId) throw new FactoryComputeAdmissionError("factory_compute_admission_scope");
    nowValue(now);
    this.outbox = new FactoryInstallationCommandOutbox(database, tenantId, now, "pool");
  }

  /** Called only inside the task-admission budget transaction. */
  async enlistInTransaction(transaction: MigrationDb, value: FactoryComputeAdmissionRequest): Promise<{ readonly created: boolean }> {
    const input = snapshotRequest(value, this.tenantId);
    const reference = input.value.reference;
    const timestamp = nowValue(this.now);
    const inserted = rows(await transaction.execute(sql`INSERT INTO factory_compute_admissions
      (tenant_id, project_id, run_id, reservation_id, request_digest, request_json, state, next_poll_at)
      VALUES (${this.tenantId}, ${reference.projectId}, ${reference.logicalRunId}, ${input.value.request.reservationId}, ${input.digest}, ${input.json}, 'pending', ${timestamp})
      ON CONFLICT DO NOTHING RETURNING reservation_id`));
    if (inserted.length === 1) return { created: true };
    const prior = rowResult(rows<AdmissionRow>(await transaction.execute(sql`SELECT * FROM factory_compute_admissions WHERE tenant_id=${this.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} AND reservation_id=${input.value.request.reservationId} FOR UPDATE`)));
    if (!prior || prior.request_digest !== input.digest || prior.request_json !== input.json) throw new FactoryComputeAdmissionError("factory_compute_admission_conflict");
    decodeRequest(prior, this.tenantId);
    return { created: false };
  }

  async dispatchNext(service: TrustedFactoryServiceIdentity, signal?: AbortSignal): Promise<FactoryComputeAdmissionDispatchResult> {
    this.authority.assertService(service);
    const delivery = await this.outbox.claim();
    if (!delivery) return { status: "idle" };
    let reservationId = delivery.command.commandId;
    try {
      const key = this.deliveryKey(delivery);
      reservationId = key.reservationId;
      const result = await this.recover(service, key, signal);
      await this.outbox.settle(delivery, result.status === "busy" || result.status === "retry" ? "retry" : "delivered", result.status === "busy" || result.status === "retry" ? "compute_admission_retry" : undefined);
      return result;
    } catch (error) {
      const corrupt = error instanceof FactoryComputeAdmissionError && ["factory_compute_admission_corrupt", "factory_compute_admission_conflict", "factory_compute_admission_invalid", "factory_compute_admission_scope"].includes(error.code);
      await this.outbox.settle(delivery, corrupt ? "outcome_unknown" : "retry", retryCode(error));
      return { status: "retry", reservationId, reason: retryCode(error) };
    }
  }

  async pollNext(service: TrustedFactoryServiceIdentity, signal?: AbortSignal): Promise<FactoryComputeAdmissionDispatchResult> {
    this.authority.assertService(service);
    const claim = await this.claimNext();
    if (!claim) return { status: "idle" };
    return this.process(service, claim, signal);
  }

  async recover(service: TrustedFactoryServiceIdentity, key: FactoryComputeAdmissionKey, signal?: AbortSignal): Promise<FactoryComputeAdmissionDispatchResult> {
    this.authority.assertService(service);
    const row = await this.readRow(key);
    if (!row) throw new FactoryComputeAdmissionError("factory_compute_admission_not_found");
    const input = decodeRequest(row, this.tenantId);
    const terminal = terminalResult(row, input);
    if (terminal) return terminal;
    const claim = await this.claim(key);
    return claim ? this.process(service, claim, signal) : { status: "busy", reservationId: key.reservationId };
  }

  /** Read an admitted allocation while the caller holds the run authority transaction. */
  async readAdmittedInTransaction(transaction: MigrationDb, key: FactoryComputeAdmissionKey): Promise<FactoryComputeAdmissionMaterial> {
    assertFactoryIdentity(key.projectId, key.runId, key.reservationId);
    const budget = rowResult(rows<BudgetReservationRow>(await transaction.execute(sql`SELECT state,compute_allocation FROM factory_budget_reservations WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND reservation_id=${key.reservationId} FOR UPDATE`)));
    if (budget?.state !== "running") throw new FactoryComputeAdmissionError("factory_compute_admission_not_admitted");
    const allocation = decodeAllocation(budget);
    const row = rowResult(rows<AdmissionRow>(await transaction.execute(sql`SELECT * FROM factory_compute_admissions WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND reservation_id=${key.reservationId} FOR UPDATE`)));
    if (!row) throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt");
    const request = decodeRequest(row, this.tenantId);
    const result = terminalResult(row, request);
    if (result?.status !== "admitted") throw new FactoryComputeAdmissionError("factory_compute_admission_not_admitted");
    if (result.receipt.lease.allocationToken !== allocation.allocationToken || result.receipt.lease.allocationGeneration !== allocation.reservationGeneration) throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt");
    return Object.freeze({ request: Object.freeze(request), receipt: Object.freeze({ lease: Object.freeze(result.receipt.lease), event: Object.freeze(result.receipt.event) }) });
  }

  private deliveryKey(delivery: FactoryCommandDelivery): FactoryComputeAdmissionKey {
    if (delivery.command.kind !== "compute_admission" || delivery.tenantId !== this.tenantId) throw new FactoryComputeAdmissionError("factory_compute_admission_scope");
    const input = snapshotRequest(delivery.command.body as FactoryComputeAdmissionRequest, this.tenantId);
    if (delivery.projectId !== input.value.reference.projectId || delivery.logicalRunId !== input.value.reference.logicalRunId) throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt");
    return { projectId: delivery.projectId, runId: delivery.logicalRunId, reservationId: input.value.request.reservationId };
  }

  private async process(service: TrustedFactoryServiceIdentity, claim: ClaimedAdmission, signal?: AbortSignal): Promise<FactoryComputeAdmissionDispatchResult> {
    if (claim.row.state === "cancelling") return this.cancelClaim(claim, signal);
    try {
      await this.assertCurrent(service, claim.input);
    } catch (error) {
      if (authorityLost(error) || error instanceof FactoryComputeAdmissionError) return this.cancelClaim(claim, signal);
      await this.release(claim, "queued");
      throw error;
    }
    await this.markAttempted(claim);
    let decision: PoolDecision;
    try { decision = validatedDecision(await this.pool.request(claim.input.request, signal), claim.input); }
    catch (error) { await this.release(claim, claim.row.state === "pending" ? "pending" : "queued"); throw error; }
    if (decision.status === "queued") {
      return await this.recordQueued(claim, decision) ?? { status: "queued", reservationId: claim.row.reservation_id, retryAtMs: nowValue(this.now) + POLL_INTERVAL_MS };
    }
    try { return await this.commitDecision(service, claim, decision); }
    catch (error) {
      if (authorityLost(error) || error instanceof FactoryComputeAdmissionError && error.code === "factory_compute_admission_stale") {
        const current = await this.readRow({ projectId: claim.row.project_id, runId: claim.row.run_id, reservationId: claim.row.reservation_id });
        if (current) {
          const terminal = terminalResult(current, decodeRequest(current, this.tenantId));
          if (terminal) return terminal;
        }
        return this.cancelClaim(claim, signal);
      }
      await this.release(claim, "queued");
      throw error;
    }
  }

  private async assertCurrent(service: TrustedFactoryServiceIdentity, input: FactoryComputeAdmissionRequest): Promise<void> {
    await this.authority.withCurrent(service, input.reference, async (_transaction, context) => { this.assertContext(input, context); });
  }

  private assertContext(input: FactoryComputeAdmissionRequest, context: FactoryAuthorizedCommand): void {
    if (context.command.kind !== "request-admission" || encodeFactoryPayload(factoryExecutionFence(context.fence)) !== encodeFactoryPayload(factoryExecutionFence(input.fence)) || factoryTaskReservationId(input.reference, context) !== input.request.reservationId || new Date(context.command.deadlineAtMs).toISOString() !== input.request.admissionDeadline) throw new FactoryComputeAdmissionError("factory_compute_admission_stale");
  }

  private async commitDecision(service: TrustedFactoryServiceIdentity, claim: ClaimedAdmission, decision: PoolDecision): Promise<FactoryComputeAdmissionDispatchResult> {
    return this.authority.withCurrent(service, claim.input.reference, async (transaction, context) => {
      this.assertContext(claim.input, context);
      const admitted = decision.status === "admitted";
      if (admitted) await this.budgets.markRunningInTransaction(transaction, { projectId: claim.row.project_id, runId: claim.row.run_id, reservationId: claim.row.reservation_id }, { allocationToken: decision.lease!.allocationToken, reservationGeneration: decision.lease!.allocationGeneration });
      const current = rowResult(rows<AdmissionRow>(await transaction.execute(sql`SELECT * FROM factory_compute_admissions WHERE tenant_id=${this.tenantId} AND project_id=${claim.row.project_id} AND run_id=${claim.row.run_id} AND reservation_id=${claim.row.reservation_id} FOR UPDATE`)));
      if (!current) throw new FactoryComputeAdmissionError("factory_compute_admission_corrupt");
      decodeRequest(current, this.tenantId);
      const terminal = terminalResult(current, claim.input);
      if (terminal) {
        if (canonicalDecision(decision).digest !== current.response_digest) throw new FactoryComputeAdmissionError("factory_compute_admission_conflict");
        return terminal;
      }
      if (!activeStates.includes(current.state as ActiveState)) throw new FactoryComputeAdmissionError("factory_compute_admission_conflict");
      const timestamp = nowValue(this.now);
      const event: AdmissionEvent = {
        kind: "admission-result",
        id: `factory-admission:${durableInputHash({ tenantId: this.tenantId, projectId: current.project_id, runId: current.run_id, reservationId: current.reservation_id, granted: admitted }).slice(7)}`,
        atMs: timestamp,
        nodeId: context.command.nodeId,
        commandId: context.command.id,
        candidateGeneration: context.command.candidateGeneration,
        granted: admitted,
      };
      const encodedDecision = canonicalDecision(decision);
      const encodedEvent = canonical(event);
      await this.inbox.enqueueInTransaction(transaction, { projectId: current.project_id, runId: current.run_id, interpreterId: claim.input.reference.interpreterId }, encodedEvent.value);
      await transaction.execute(sql`UPDATE factory_compute_admissions SET state=${admitted ? "admitted" : "rejected"}, response_digest=${encodedDecision.digest}, response_json=${encodedDecision.json}, event_digest=${encodedEvent.digest}, event_json=${encodedEvent.json}, next_poll_at=0, poll_lease_until=0, poll_lease_token=NULL, updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${current.project_id} AND run_id=${current.run_id} AND reservation_id=${current.reservation_id}`);
      return admitted
        ? { status: "admitted", reservationId: current.reservation_id, receipt: { lease: decision.lease!, event } }
        : { status: "rejected", reservationId: current.reservation_id, decision, event };
    });
  }

  private async cancelClaim(claim: ClaimedAdmission, signal?: AbortSignal): Promise<FactoryComputeAdmissionDispatchResult> {
    if (!claim.row.remote_attempted) {
      await this.finishCancellation(claim, undefined, "cancelled");
      return { status: "cancelled", reservationId: claim.row.reservation_id };
    }
    let status: PoolLeaseStatus | undefined;
    try { status = await this.pool.status(claim.row.reservation_id, signal); }
    catch (error) { await this.releaseCancellation(claim); throw error; }
    if (!status) {
      await this.finishCancellation(claim, undefined, "cancelling");
      return { status: "cancelling", reservationId: claim.row.reservation_id };
    }
    let cancelled: PoolLeaseStatus;
    try { cancelled = await this.pool.cancel(claim.row.reservation_id, status.allocationGeneration, signal); }
    catch (error) { await this.releaseCancellation(claim); throw error; }
    const state = cancelled.state === "settled" || cancelled.state === "rejected" ? "cancelled" : "cancelling";
    await this.finishCancellation(claim, cancelled, state);
    return { status: state, reservationId: claim.row.reservation_id };
  }

  private async releaseCancellation(claim: ClaimedAdmission): Promise<void> {
    await this.database.transaction(transaction => transaction.execute(sql`UPDATE factory_compute_admissions SET state='cancelling', next_poll_at=${nowValue(this.now) + POLL_INTERVAL_MS}, poll_lease_until=0, poll_lease_token=NULL, updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${claim.row.project_id} AND run_id=${claim.row.run_id} AND reservation_id=${claim.row.reservation_id} AND poll_lease_token=${claim.token}`));
  }

  private async finishCancellation(claim: ClaimedAdmission, response: PoolLeaseStatus | undefined, state: "cancelling" | "cancelled"): Promise<void> {
    const encoded = response === undefined ? undefined : canonical(response);
    await this.database.transaction(async transaction => {
      const updated = rows(await transaction.execute(sql`UPDATE factory_compute_admissions SET state=${state}, next_poll_at=${state === "cancelling" ? nowValue(this.now) + POLL_INTERVAL_MS : 0}, poll_lease_until=0, poll_lease_token=NULL, response_digest=${encoded?.digest ?? null}, response_json=${encoded?.json ?? null}, updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${claim.row.project_id} AND run_id=${claim.row.run_id} AND reservation_id=${claim.row.reservation_id} AND poll_lease_token=${claim.token} RETURNING reservation_id`));
      if (updated.length === 0) await this.assertCompatibleTerminal(transaction, claim);
    });
  }

  private async recordQueued(claim: ClaimedAdmission, decision: PoolDecision): Promise<FactoryComputeAdmissionDispatchResult | undefined> {
    const encoded = canonicalDecision(decision);
    return this.database.transaction(async transaction => {
      const updated = rows(await transaction.execute(sql`UPDATE factory_compute_admissions SET state='queued', next_poll_at=${nowValue(this.now) + POLL_INTERVAL_MS}, poll_lease_until=0, poll_lease_token=NULL, response_digest=${encoded.digest}, response_json=${encoded.json}, updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${claim.row.project_id} AND run_id=${claim.row.run_id} AND reservation_id=${claim.row.reservation_id} AND poll_lease_token=${claim.token} RETURNING reservation_id`));
      if (updated.length !== 0) return undefined;
      return this.assertCompatibleTerminal(transaction, claim);
    });
  }

  private async markAttempted(claim: ClaimedAdmission): Promise<void> {
    const updated = await this.database.transaction(transaction => transaction.execute(sql`UPDATE factory_compute_admissions SET remote_attempted=TRUE, updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${claim.row.project_id} AND run_id=${claim.row.run_id} AND reservation_id=${claim.row.reservation_id} AND poll_lease_token=${claim.token} RETURNING reservation_id`));
    if (rows(updated).length === 0) throw new FactoryComputeAdmissionError("factory_compute_admission_busy");
    claim.row.remote_attempted = true;
  }

  private async release(claim: ClaimedAdmission, state: "pending" | "queued"): Promise<void> {
    await this.database.transaction(transaction => transaction.execute(sql`UPDATE factory_compute_admissions SET state=${state}, next_poll_at=${nowValue(this.now) + POLL_INTERVAL_MS}, poll_lease_until=0, poll_lease_token=NULL, updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${claim.row.project_id} AND run_id=${claim.row.run_id} AND reservation_id=${claim.row.reservation_id} AND poll_lease_token=${claim.token}`));
  }

  private async assertCompatibleTerminal(transaction: MigrationDb, claim: ClaimedAdmission): Promise<FactoryComputeAdmissionDispatchResult> {
    const row = rowResult(rows<AdmissionRow>(await transaction.execute(sql`SELECT * FROM factory_compute_admissions WHERE tenant_id=${this.tenantId} AND project_id=${claim.row.project_id} AND run_id=${claim.row.run_id} AND reservation_id=${claim.row.reservation_id}`)));
    const terminal = row && terminalResult(row, decodeRequest(row, this.tenantId));
    if (!terminal) throw new FactoryComputeAdmissionError("factory_compute_admission_busy");
    return terminal;
  }

  private async claimNext(): Promise<ClaimedAdmission | undefined> {
    const timestamp = nowValue(this.now);
    return this.database.transaction(async transaction => {
      const row = rowResult(rows<AdmissionRow>(await transaction.execute(sql`SELECT * FROM factory_compute_admissions WHERE tenant_id=${this.tenantId} AND state IN ('pending','queued','cancelling') AND next_poll_at<=${timestamp} AND poll_lease_until<=${timestamp} ORDER BY next_poll_at, created_at, reservation_id LIMIT 1 FOR UPDATE SKIP LOCKED`)));
      return row ? this.claimRow(transaction, row, timestamp) : undefined;
    });
  }

  private async claim(key: FactoryComputeAdmissionKey): Promise<ClaimedAdmission | undefined> {
    assertFactoryIdentity(key.projectId, key.runId, key.reservationId);
    const timestamp = nowValue(this.now);
    return this.database.transaction(async transaction => {
      const row = rowResult(rows<AdmissionRow>(await transaction.execute(sql`SELECT * FROM factory_compute_admissions WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND reservation_id=${key.reservationId} FOR UPDATE`)));
      if (!row || !activeStates.includes(row.state as ActiveState) || Number(row.poll_lease_until) > timestamp) return undefined;
      return this.claimRow(transaction, row, timestamp);
    });
  }

  private async claimRow(transaction: MigrationDb, row: AdmissionRow, timestamp: number): Promise<ClaimedAdmission> {
    const input = decodeRequest(row, this.tenantId);
    const token = crypto.randomUUID();
    await transaction.execute(sql`UPDATE factory_compute_admissions SET poll_lease_until=${timestamp + POLL_LEASE_MS}, poll_lease_token=${token}, updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${row.project_id} AND run_id=${row.run_id} AND reservation_id=${row.reservation_id}`);
    row.poll_lease_until = timestamp + POLL_LEASE_MS;
    row.poll_lease_token = token;
    return { row, input, token };
  }

  private async readRow(key: FactoryComputeAdmissionKey): Promise<AdmissionRow | undefined> {
    assertFactoryIdentity(key.projectId, key.runId, key.reservationId);
    return rowResult(rows<AdmissionRow>(await this.database.execute(sql`SELECT * FROM factory_compute_admissions WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND reservation_id=${key.reservationId}`)));
  }
}
