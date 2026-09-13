import { lockFactoryScope } from "./locks";
import { sql } from "drizzle-orm";
import { isUnsignedDecimal, type BudgetBounds } from "@ezcorp/factory-sdk";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { digestObject } from "../extensions/v4/blobs";
import { assertFactoryIdentity, encodeFactoryPayload, type FactoryRunKey } from "./records";

export interface FactoryBudgetAmount { readonly costMicros: string; readonly tokens: number; readonly computeMs: number }
export interface FactoryBudgetKey extends FactoryRunKey { readonly envelopeId: string }
export interface FactoryBudgetEnvelope extends FactoryBudgetKey { readonly parentId?: string; readonly limits: Required<BudgetBounds>; readonly deadlineAtMs: number }
export interface FactoryBudgetRequest extends FactoryBudgetKey { readonly reservationId: string; readonly amount: FactoryBudgetAmount; readonly computeRequest: unknown }
export interface FactoryBudgetReservationKey extends FactoryRunKey { readonly reservationId: string }
export interface FactoryComputeAllocation { readonly allocationToken: string; readonly reservationGeneration: number }
export type FactoryBudgetAdmission = (transaction: MigrationDb, key: FactoryRunKey) => Promise<void>;
export type FactoryBudgetTotals = Readonly<Record<"costMicros" | "tokens" | "computeMs", string>>;
interface EnvelopeRow { envelope_id: string; parent_id: string | null; request_digest: string; limits: string; allocated: string; spent: string; deadline_ms: number | string; state: "open" | "closed"; admission_blocked: boolean }
interface ReservationRow { envelope_id: string; request_digest: string; amount: string; actual: string | null; receipt_digest: string | null; compute_allocation: string | null; uncertainty: string | null; state: "held" | "running" | "uncertain" | "settled" }
type Vector = Record<keyof FactoryBudgetTotals, bigint>;
const dimensions = ["costMicros", "tokens", "computeMs"] as const;
const zero: Vector = { costMicros: 0n, tokens: 0n, computeMs: 0n };

export class FactoryBudgetError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryBudgetError"; }
}

function counter(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new FactoryBudgetError("factory_budget_invalid");
}

function amount(value: FactoryBudgetAmount): Vector {
  if (typeof value.costMicros !== "string" || value.costMicros.length > 78 || !isUnsignedDecimal(value.costMicros)) throw new FactoryBudgetError("factory_budget_invalid");
  counter(value.tokens); counter(value.computeMs);
  return { costMicros: BigInt(value.costMicros), tokens: BigInt(value.tokens), computeMs: BigInt(value.computeMs) };
}

function totals(value: Vector): FactoryBudgetTotals {
  return { costMicros: String(value.costMicros), tokens: String(value.tokens), computeMs: String(value.computeMs) };
}

function encode(value: Vector): string { return encodeFactoryPayload(totals(value)); }
function decode(value: string): Vector {
  const parsed = JSON.parse(value) as FactoryBudgetTotals;
  if (dimensions.some(key => typeof parsed[key] !== "string" || !isUnsignedDecimal(parsed[key]))) throw new FactoryBudgetError("factory_budget_corrupt");
  return { costMicros: BigInt(parsed.costMicros), tokens: BigInt(parsed.tokens), computeMs: BigInt(parsed.computeMs) };
}
function combine(left: Vector, right: Vector, subtract = false): Vector {
  const result = { ...left };
  for (const key of dimensions) result[key] += subtract ? -right[key] : right[key];
  if (dimensions.some(key => result[key] < 0n)) throw new FactoryBudgetError("factory_budget_corrupt");
  return result;
}

/** Product budget facts survive compute ledger loss and process restart. */
export class FactoryBudgets {
  constructor(private readonly database: TransactionalDb, private readonly tenantId: string, private readonly authorizeAdmission: FactoryBudgetAdmission, private readonly now: () => number = Date.now) { assertFactoryIdentity(tenantId); }

  async openEnvelope(value: FactoryBudgetEnvelope): Promise<{ created: boolean }> {
    const snapshot = JSON.parse(encodeFactoryPayload(value)) as FactoryBudgetEnvelope;
    return this.database.transaction(transaction => this.openEnvelopeInTransaction(transaction, snapshot));
  }

  async openEnvelopeInTransaction(transaction: MigrationDb, value: FactoryBudgetEnvelope): Promise<{ created: boolean }> {
    const input = JSON.parse(encodeFactoryPayload(value)) as FactoryBudgetEnvelope;
    assertFactoryIdentity(input.envelopeId);
    const limits = amount({ costMicros: input.limits.maxCostMicros, tokens: input.limits.maxTokens, computeMs: input.limits.maxComputeMs });
    if (!Number.isSafeInteger(input.deadlineAtMs) || input.deadlineAtMs <= this.now()) throw new FactoryBudgetError("factory_budget_deadline");
    const digest = digestObject(input);
    await this.lockRun(transaction, input);
    await this.authorizeAdmission(transaction, input);
    const prior = await this.envelope(transaction, input, false);
    if (prior) {
      if (prior.request_digest !== digest) throw new FactoryBudgetError("factory_budget_conflict");
      return { created: false };
    }
    if (input.parentId !== undefined) {
      assertFactoryIdentity(input.parentId);
      const parentKey = { ...input, envelopeId: input.parentId };
      const parent = (await this.envelope(transaction, parentKey))!;
      this.assertAvailable(parent, limits);
      if (input.deadlineAtMs > Number(parent.deadline_ms)) throw new FactoryBudgetError("factory_budget_widening");
      await this.writeTotals(transaction, parentKey, combine(decode(parent.allocated), limits), decode(parent.spent));
    }
    await transaction.execute(sql`INSERT INTO factory_budget_envelopes (tenant_id, project_id, run_id, envelope_id, parent_id, request_digest, limits, allocated, spent, deadline_ms, state) VALUES (${this.tenantId}, ${input.projectId}, ${input.runId}, ${input.envelopeId}, ${input.parentId ?? null}, ${digest}, ${encode(limits)}, ${encode(zero)}, ${encode(zero)}, ${input.deadlineAtMs}, 'open')`);
    await this.audit(transaction, input, "envelope-created", input.envelopeId, { digest, parentId: input.parentId ?? null, limits: totals(limits), deadlineAtMs: input.deadlineAtMs });
    return { created: true };
  }

  async reserve(input: FactoryBudgetRequest, enqueue: (transaction: MigrationDb, request: FactoryBudgetRequest) => Promise<void>): Promise<{ created: boolean }> {
    const snapshot = JSON.parse(encodeFactoryPayload(input)) as FactoryBudgetRequest;
    return this.database.transaction(transaction => this.reserveInTransaction(transaction, snapshot, enqueue));
  }

  async reserveInTransaction(transaction: MigrationDb, input: FactoryBudgetRequest, enqueue: (transaction: MigrationDb, request: FactoryBudgetRequest) => Promise<void>): Promise<{ created: boolean }> {
    assertFactoryIdentity(input.envelopeId, input.reservationId);
    // Snapshot before awaiting; callers cannot alter the held amount or outbox request.
    const request = JSON.parse(encodeFactoryPayload(input)) as FactoryBudgetRequest;
    const held = amount(request.amount);
    const digest = digestObject(request);
    await this.lockRun(transaction, request);
    await this.authorizeAdmission(transaction, request);
    const prior = await this.reservation(transaction, request, false);
    if (prior) {
      if (prior.request_digest !== digest) throw new FactoryBudgetError("factory_budget_conflict");
      return { created: false };
    }
    const envelope = (await this.envelope(transaction, request))!;
    this.assertAvailable(envelope, held);
    await this.writeTotals(transaction, request, combine(decode(envelope.allocated), held), decode(envelope.spent));
    await transaction.execute(sql`INSERT INTO factory_budget_reservations (tenant_id, project_id, run_id, reservation_id, envelope_id, request_digest, amount, state) VALUES (${this.tenantId}, ${request.projectId}, ${request.runId}, ${request.reservationId}, ${request.envelopeId}, ${digest}, ${encode(held)}, 'held')`);
    await this.audit(transaction, request, "reserved", request.reservationId, { digest, envelopeId: request.envelopeId, amount: totals(held) });
    await enqueue(transaction, request);
    return { created: true };
  }

  async markRunning(key: FactoryBudgetReservationKey, allocation: FactoryComputeAllocation): Promise<void> {
    assertFactoryIdentity(allocation.allocationToken);
    counter(allocation.reservationGeneration);
    if (allocation.reservationGeneration === 0) throw new FactoryBudgetError("factory_budget_invalid");
    const encoded = encodeFactoryPayload(allocation);
    await this.database.transaction(async transaction => {
      await this.lockRun(transaction, key);
      await this.authorizeAdmission(transaction, key);
      const row = (await this.reservation(transaction, key))!;
      if (row.state === "running" && row.compute_allocation === encoded) return;
      if (row.state !== "held") throw new FactoryBudgetError("factory_budget_conflict");
      this.assertAvailable((await this.envelope(transaction, { ...key, envelopeId: row.envelope_id }))!, zero);
      await transaction.execute(sql`UPDATE factory_budget_reservations SET state='running', compute_allocation=${encoded} WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND reservation_id=${key.reservationId}`);
      await this.audit(transaction, key, "running", key.reservationId, { allocationDigest: digestObject(JSON.parse(encoded)) });
    });
  }

  async markUncertain(key: FactoryBudgetReservationKey, reason: string): Promise<void> {
    assertFactoryIdentity(reason);
    await this.database.transaction(async transaction => {
      await this.lockRun(transaction, key);
      const row = (await this.reservation(transaction, key))!;
      if (row.state === "uncertain" && row.uncertainty === reason) return;
      if (row.state === "settled" || row.state === "uncertain") throw new FactoryBudgetError("factory_budget_conflict");
      await transaction.execute(sql`UPDATE factory_budget_reservations SET state='uncertain', uncertainty=${reason} WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND reservation_id=${key.reservationId}`);
      await this.audit(transaction, key, "uncertain", key.reservationId, { reason, held: totals(decode(row.amount)) });
    });
  }

  /** Only a trusted provider/stop receipt resolves a hold, including a zero-use hold. */
  async settle(key: FactoryBudgetReservationKey, actual: FactoryBudgetAmount, receiptDigest: string): Promise<void> {
    const used = amount(actual);
    if (!/^sha256:[a-f0-9]{64}$/.test(receiptDigest)) throw new FactoryBudgetError("factory_budget_receipt_invalid");
    await this.database.transaction(async transaction => {
      await this.lockRun(transaction, key);
      const row = (await this.reservation(transaction, key))!;
      if (row.state === "settled") {
        if (row.actual !== encode(used) || row.receipt_digest !== receiptDigest) throw new FactoryBudgetError("factory_budget_conflict");
        return;
      }
      const envelopeKey = { ...key, envelopeId: row.envelope_id };
      const envelope = (await this.envelope(transaction, envelopeKey))!;
      const exceededReservation = dimensions.some(dimension => used[dimension] > decode(row.amount)[dimension]);
      if (exceededReservation) await transaction.execute(sql`UPDATE factory_budget_envelopes SET admission_blocked=TRUE WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId}`);
      await this.writeTotals(transaction, envelopeKey, combine(decode(envelope.allocated), decode(row.amount), true), combine(decode(envelope.spent), used));
      await transaction.execute(sql`UPDATE factory_budget_reservations SET state='settled', actual=${encode(used)}, receipt_digest=${receiptDigest} WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND reservation_id=${key.reservationId}`);
      await this.audit(transaction, key, "settled", key.reservationId, { actual: totals(used), receiptDigest, exceededReservation });
    });
  }

  async closeEnvelope(key: FactoryBudgetKey): Promise<void> {
    await this.database.transaction(async transaction => {
      await this.lockRun(transaction, key);
      const row = (await this.envelope(transaction, key))!;
      if (row.state === "closed") return;
      const active = rows(await transaction.execute(sql`SELECT reservation_id FROM factory_budget_reservations WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND envelope_id=${key.envelopeId} AND state<>'settled' LIMIT 1`));
      const children = rows(await transaction.execute(sql`SELECT envelope_id FROM factory_budget_envelopes WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND parent_id=${key.envelopeId} AND state='open' LIMIT 1`));
      if (active.length || children.length || dimensions.some(dimension => decode(row.allocated)[dimension] !== 0n)) throw new FactoryBudgetError("factory_budget_pending");
      if (row.parent_id !== null) {
        const parentKey = { ...key, envelopeId: row.parent_id };
        const parent = (await this.envelope(transaction, parentKey))!;
        await this.writeTotals(transaction, parentKey, combine(decode(parent.allocated), decode(row.limits), true), combine(decode(parent.spent), decode(row.spent)));
      }
      await transaction.execute(sql`UPDATE factory_budget_envelopes SET state='closed' WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND envelope_id=${key.envelopeId}`);
      await this.audit(transaction, key, "envelope-closed", key.envelopeId, { spent: totals(decode(row.spent)) });
    });
  }

  async inspect(key: FactoryBudgetKey): Promise<{ state: "open" | "closed"; admissionBlocked: boolean; limits: FactoryBudgetTotals; allocated: FactoryBudgetTotals; spent: FactoryBudgetTotals }> {
    return this.database.transaction(async transaction => {
      await this.lockRun(transaction, key);
      const row = (await this.envelope(transaction, key))!;
      return { state: row.state, admissionBlocked: row.admission_blocked, limits: totals(decode(row.limits)), allocated: totals(decode(row.allocated)), spent: totals(decode(row.spent)) };
    });
  }

  private assertAvailable(row: EnvelopeRow, requested: Vector): void {
    if (row.state !== "open" || Number(row.deadline_ms) <= this.now()) throw new FactoryBudgetError("factory_budget_deadline");
    if (row.admission_blocked) throw new FactoryBudgetError("factory_budget_reconciliation_required");
    const committed = combine(combine(decode(row.allocated), decode(row.spent)), requested);
    const limits = decode(row.limits);
    if (dimensions.some(key => committed[key] > limits[key])) throw new FactoryBudgetError("factory_budget_exhausted");
  }

  private async lockRun(transaction: MigrationDb, key: FactoryRunKey): Promise<void> {
    assertFactoryIdentity(key.projectId, key.runId);
    if (!await lockFactoryScope(transaction, this.tenantId, key.projectId)) throw new FactoryBudgetError("factory_budget_scope");
    const run = rows(await transaction.execute(sql`SELECT run_id FROM factory_runs WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} FOR UPDATE`))[0];
    if (!run) throw new FactoryBudgetError("factory_budget_scope");
  }

  private async envelope(transaction: MigrationDb, key: FactoryBudgetKey, required = true): Promise<EnvelopeRow | undefined> {
    assertFactoryIdentity(key.envelopeId);
    const row = rows<EnvelopeRow>(await transaction.execute(sql`SELECT * FROM factory_budget_envelopes WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND envelope_id=${key.envelopeId} FOR UPDATE`))[0];
    if (!row && required) throw new FactoryBudgetError("factory_budget_not_found");
    return row;
  }

  private async reservation(transaction: MigrationDb, key: FactoryBudgetReservationKey, required = true): Promise<ReservationRow | undefined> {
    assertFactoryIdentity(key.reservationId);
    const row = rows<ReservationRow>(await transaction.execute(sql`SELECT * FROM factory_budget_reservations WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND reservation_id=${key.reservationId} FOR UPDATE`))[0];
    if (!row && required) throw new FactoryBudgetError("factory_budget_not_found");
    return row;
  }

  private async writeTotals(transaction: MigrationDb, key: FactoryBudgetKey, allocated: Vector, spent: Vector): Promise<void> {
    await transaction.execute(sql`UPDATE factory_budget_envelopes SET allocated=${encode(allocated)}, spent=${encode(spent)} WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND envelope_id=${key.envelopeId}`);
  }

  private async audit(transaction: MigrationDb, key: FactoryRunKey, action: string, target: string, metadata: Record<string, unknown>): Promise<void> {
    const id = digestObject({ tenantId: this.tenantId, projectId: key.projectId, runId: key.runId, action, target });
    await insertTransactionalAuditEntry(transaction, `factory-budget:${id}`, null, `factory.budget.${action}`, target, { tenantId: this.tenantId, projectId: key.projectId, runId: key.runId, ...metadata });
  }
}
