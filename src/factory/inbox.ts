import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { durableInputHash } from "../delivery-queue/durable-delivery-queue";
import { FactoryCommandOutbox, type FactoryCommandDelivery } from "./outbox";
import { assertFactoryIdentity, encodeFactoryPayload, FactoryRecords, type FactoryAuditInput, type FactoryRunKey } from "./records";

export interface FactoryInboxKey extends FactoryRunKey { readonly interpreterId: string }
export interface FactoryInboxIdentity { readonly eventId: string; readonly eventHash: string; readonly inboxSequence: number }
export interface FactoryInboxEntry extends FactoryInboxIdentity { readonly event: KernelEvent }
type InboxKind = "decision" | "partition_notification";
type InboxRow = { sequence: string | number; event_id: string; event_hash: string; kind: InboxKind; payload: string; applied_source_sequence: string | number | null; applied_digest: string | null };

export class FactoryInboxError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryInboxError"; }
}

function positive(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new FactoryInboxError("factory_inbox_sequence_invalid");
}

function identity(key: FactoryInboxKey): void { assertFactoryIdentity(key.projectId, key.runId, key.interpreterId); }

function decode(row: InboxRow): FactoryInboxEntry {
  const event = JSON.parse(row.payload) as KernelEvent;
  const inboxSequence = Number(row.sequence);
  positive(inboxSequence);
  if (event.id !== row.event_id || durableInputHash(event) !== row.event_hash) throw new FactoryInboxError("factory_inbox_corrupt");
  return { inboxSequence, eventId: row.event_id, eventHash: row.event_hash, event };
}

function appliedIdentity(payload: unknown): FactoryInboxIdentity | null {
  const value = payload as Partial<FactoryInboxIdentity> | null;
  if (value?.inboxSequence === undefined) return null;
  positive(value.inboxSequence);
  if (typeof value.eventId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.eventHash ?? "")) throw new FactoryInboxError("factory_inbox_identity_invalid");
  assertFactoryIdentity(value.eventId);
  return value as FactoryInboxIdentity;
}

/** Internal product inbox. The HTTP boundary supplies authenticated installation scope. */
export class FactoryInbox {
  private readonly records: FactoryRecords;
  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly now: () => number = Date.now) {
    assertFactoryIdentity(tenantId);
    this.records = new FactoryRecords(database, tenantId);
  }

  async enqueue(key: FactoryInboxKey, event: KernelEvent, kind: InboxKind = "decision"): Promise<FactoryCommandDelivery> {
    const snapshot = JSON.parse(encodeFactoryPayload({ key, event, kind })) as { key: FactoryInboxKey; event: KernelEvent; kind: InboxKind };
    return this.database.transaction(transaction => this.enqueueInTransaction(transaction, snapshot.key, snapshot.event, snapshot.kind));
  }

  async enqueueInTransaction(transaction: MigrationDb, key: FactoryInboxKey, event: KernelEvent, kind: InboxKind = "decision"): Promise<FactoryCommandDelivery> {
    const snapshot = JSON.parse(encodeFactoryPayload({ key, event, kind })) as { key: FactoryInboxKey; event: KernelEvent; kind: InboxKind };
    key = snapshot.key; event = snapshot.event; kind = snapshot.kind;
    identity(key);
    assertFactoryIdentity(event.id, event.kind);
    if (!Number.isSafeInteger(event.atMs) || event.atMs < 0 || (kind !== "decision" && kind !== "partition_notification")) throw new FactoryInboxError("factory_inbox_event_invalid");
    await this.lockRun(transaction, key);
    await transaction.execute(sql`INSERT INTO factory_inbox_cursors (tenant_id, project_id, run_id, interpreter_id) VALUES (${this.tenantId}, ${key.projectId}, ${key.runId}, ${key.interpreterId}) ON CONFLICT DO NOTHING`);
    const prior = await this.find(transaction, key, event.id);
    const eventHash = durableInputHash(event);
    let sequence: number;
    if (prior) {
      const entry = decode(prior);
      if (entry.eventHash !== eventHash || prior.kind !== kind) throw new FactoryInboxError("factory_inbox_conflict");
      sequence = entry.inboxSequence;
    } else {
      const cursor = rows<{ next_sequence: number | string }>(await transaction.execute(sql`SELECT next_sequence FROM factory_inbox_cursors WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND interpreter_id=${key.interpreterId} FOR UPDATE`))[0]!;
      sequence = Number(cursor.next_sequence);
      positive(sequence); positive(sequence + 1);
      const pending = rows<{ sequence: number | string }>(await transaction.execute(sql`SELECT sequence FROM factory_inbox_events WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND interpreter_id=${key.interpreterId} AND applied_source_sequence IS NULL ORDER BY sequence LIMIT 1`))[0];
      if (pending && sequence - Number(pending.sequence) >= 128) throw new FactoryInboxError("factory_inbox_full");
      await transaction.execute(sql`INSERT INTO factory_inbox_events (tenant_id, project_id, run_id, interpreter_id, sequence, event_id, event_hash, kind, payload) VALUES (${this.tenantId}, ${key.projectId}, ${key.runId}, ${key.interpreterId}, ${sequence}, ${event.id}, ${eventHash}, ${kind}, ${encodeFactoryPayload(event)})`);
      await transaction.execute(sql`UPDATE factory_inbox_cursors SET next_sequence=${sequence + 1} WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND interpreter_id=${key.interpreterId}`);
    }
    const outbox = new FactoryCommandOutbox(this.database, this.tenantId, key.projectId, this.now);
    const input = { projectId: key.projectId, logicalRunId: key.runId, interpreterId: key.interpreterId, eventSequence: sequence, eventHash, body: event };
    return outbox.enqueueInTransaction(transaction, kind === "decision" ? { ...input, kind, decisionId: event.id } : { ...input, kind, notificationId: event.id });
  }

  /** The caller stages and verifies immutable transition artifacts before this commit. */
  async commitTransition(request: FactoryAuditInput): Promise<void> {
    const input = JSON.parse(encodeFactoryPayload(request)) as FactoryAuditInput;
    return this.database.transaction(transaction => this.commitTransitionInTransaction(transaction, input));
  }

  /** Commits the canonical audit batch and its exact inbox receipt together. */
  async commitTransitionInTransaction(transaction: MigrationDb, request: FactoryAuditInput): Promise<void> {
    const input = JSON.parse(encodeFactoryPayload(request)) as FactoryAuditInput;
    const proof = appliedIdentity(input.payload);
    const batch = await this.records.appendAuditInTransaction(transaction, input);
    if (!proof) return;
    const row = await this.find(transaction, input, proof.eventId);
    if (!row || decode(row).inboxSequence !== proof.inboxSequence || row.event_hash !== proof.eventHash) throw new FactoryInboxError("factory_inbox_applied_conflict");
    if (row.applied_source_sequence !== null && (Number(row.applied_source_sequence) !== input.sourceSequence || row.applied_digest !== batch.digest)) throw new FactoryInboxError("factory_inbox_applied_conflict");
    await transaction.execute(sql`UPDATE factory_inbox_events SET applied_source_sequence=${input.sourceSequence}, applied_digest=${batch.digest} WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND run_id=${input.runId} AND interpreter_id=${input.interpreterId} AND event_id=${proof.eventId}`);
  }

  async confirmApplied(key: FactoryInboxKey, proof: FactoryInboxIdentity): Promise<boolean> {
    const snapshot = JSON.parse(encodeFactoryPayload({ key, proof })) as { key: FactoryInboxKey; proof: FactoryInboxIdentity };
    key = snapshot.key; proof = snapshot.proof;
    identity(key);
    if (!appliedIdentity(proof)) throw new FactoryInboxError("factory_inbox_identity_invalid");
    return this.database.transaction(async transaction => {
      const row = await this.find(transaction, key, proof.eventId);
      if (!row) return false;
      const entry = decode(row);
      if (entry.inboxSequence !== proof.inboxSequence || entry.eventHash !== proof.eventHash || row.applied_source_sequence === null) return false;
      const batch = await this.records.readAuditBatchInTransaction(transaction, key, Number(row.applied_source_sequence));
      const applied = batch && appliedIdentity(batch.payload);
      if (!batch || batch.digest !== row.applied_digest || !applied || applied.inboxSequence !== proof.inboxSequence || applied.eventId !== proof.eventId || applied.eventHash !== proof.eventHash) throw new FactoryInboxError("factory_inbox_receipt_corrupt");
      return true;
    });
  }

  private async lockRun(transaction: MigrationDb, key: FactoryInboxKey): Promise<void> {
    const run = rows(await transaction.execute(sql`SELECT run_id FROM factory_runs WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} FOR UPDATE`))[0];
    if (!run) throw new FactoryInboxError("factory_inbox_scope");
  }

  private async find(transaction: MigrationDb, key: FactoryInboxKey, eventId: string): Promise<InboxRow | undefined> {
    return rows<InboxRow>(await transaction.execute(sql`SELECT sequence, event_id, event_hash, kind, payload, applied_source_sequence, applied_digest FROM factory_inbox_events WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND interpreter_id=${key.interpreterId} AND event_id=${eventId}`))[0];
  }
}
