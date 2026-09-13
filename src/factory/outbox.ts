import { FACTORY_TRANSPORT_COMMAND_BYTES_LIMIT } from "@ezcorp/factory-sdk/transport-types";
import { assertJson, canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { DurableDeliveryQueue, dispatchDurableDelivery, durableInputHash, type DurableDeliveryRecord, type DurableDeliveryStore } from "../delivery-queue/durable-delivery-queue";

const MAX_COMMAND_BYTES = FACTORY_TRANSPORT_COMMAND_BYTES_LIMIT;

interface FactoryCommandBase {
  readonly projectId: string;
  readonly logicalRunId: string;
  readonly body: unknown;
}

export type FactoryCommandInput =
  | (FactoryCommandBase & { readonly kind: "start_run"; readonly interpreterId?: string })
  | (FactoryCommandBase & { readonly kind: "compute_admission"; readonly reservationId: string })
  | (FactoryCommandBase & { readonly kind: "decision"; readonly interpreterId: string; readonly decisionId: string; readonly eventSequence?: number; readonly eventHash?: string })
  | (FactoryCommandBase & { readonly kind: "partition_notification"; readonly interpreterId: string; readonly notificationId: string; readonly eventSequence?: number; readonly eventHash?: string });

export interface FactoryCommand {
  readonly commandId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly logicalRunId: string;
  readonly workflowId: string;
  readonly kind: FactoryCommandInput["kind"];
  readonly interpreterId?: string;
  readonly eventId?: string;
  readonly eventSequence?: number;
  readonly eventHash?: string;
  readonly body: unknown;
}

export interface FactoryCommandDelivery extends DurableDeliveryRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly logicalRunId: string;
  readonly deduplicationId: string;
  readonly inputHash: string;
  readonly command: FactoryCommand;
}

export class FactoryOutboxError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "FactoryOutboxError";
  }
}

type CommandRow = { payload: string; state: FactoryCommandDelivery["state"]; input_hash: string };

function identity(...values: readonly string[]): void {
  if (values.some(value => typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0"))) {
    throw new FactoryOutboxError("factory_command_identity_invalid");
  }
}

function assertBoundedCommand(command: FactoryCommand): void {
  if (new TextEncoder().encode(canonicalJson(command)).byteLength > MAX_COMMAND_BYTES) {
    throw new FactoryOutboxError("factory_command_payload_too_large");
  }
}

function queueScope(tenantId: string, projectId: string): string {
  return `${tenantId}\0${projectId}`;
}

function decode(row: CommandRow, tenantId: string, projectId: string): FactoryCommandDelivery {
  const delivery = JSON.parse(row.payload) as FactoryCommandDelivery;
  const command = delivery.command;
  if (delivery.tenantId !== tenantId || delivery.projectId !== projectId || command.tenantId !== tenantId || command.projectId !== projectId || delivery.logicalRunId !== command.logicalRunId || delivery.id !== command.commandId || delivery.deduplicationId !== command.commandId || command.requestId !== command.commandId || delivery.inputHash !== row.input_hash || durableInputHash(command) !== row.input_hash) throw new FactoryOutboxError("factory_command_corrupt");
  return { ...delivery, state: row.state, inputHash: row.input_hash };
}

function eligibleCommands(destination: "temporal" | "pool", now: number) {
  return sql`((payload::jsonb->'command'->>'kind' = 'compute_admission') = ${destination === "pool"})
    AND ((state = 'queued' AND available_at <= ${now}) OR (state = 'leased' AND lease_until <= ${now}))`;
}

class FactoryCommandStore implements DurableDeliveryStore<FactoryCommandDelivery> {
  private readonly scope: string;

  constructor(private readonly database: MigrationDb, private readonly tenantId: string, private readonly projectId: string, private readonly destination: "temporal" | "pool") {
    this.scope = queueScope(tenantId, projectId);
  }

  private assertScope(scope: string | null): void {
    if (scope !== this.scope) throw new FactoryOutboxError("factory_command_scope_mismatch");
  }

  async findDuplicate(scope: string, deduplicationId: string): Promise<FactoryCommandDelivery | null> {
    this.assertScope(scope);
    const result = rows<CommandRow>(await this.database.execute(sql`SELECT payload, state, input_hash FROM factory_command_outbox
      WHERE tenant_id = ${this.tenantId} AND project_id = ${this.projectId} AND deduplication_id = ${deduplicationId}`));
    return result[0] ? decode(result[0], this.tenantId, this.projectId) : null;
  }

  async insert(delivery: FactoryCommandDelivery): Promise<boolean> {
    const inserted = rows(await this.database.execute(sql`INSERT INTO factory_command_outbox
      (id, tenant_id, project_id, logical_run_id, deduplication_id, input_hash, state, available_at, lease_until, payload)
      VALUES (${delivery.id}, ${this.tenantId}, ${this.projectId}, ${delivery.logicalRunId}, ${delivery.deduplicationId}, ${delivery.inputHash}, ${delivery.state}, ${delivery.availableAt}, ${delivery.leaseUntil}, ${JSON.stringify(delivery)})
      ON CONFLICT (tenant_id, project_id, deduplication_id) DO NOTHING RETURNING id`));
    return inserted.length === 1;
  }

  async claimCandidate(scope: string | null, now: number): Promise<FactoryCommandDelivery | null> {
    this.assertScope(scope);
    const result = rows<CommandRow>(await this.database.execute(sql`SELECT payload, state, input_hash FROM factory_command_outbox
      WHERE tenant_id = ${this.tenantId} AND project_id = ${this.projectId}
        AND ${eligibleCommands(this.destination, now)}
      ORDER BY available_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`));
    return result[0] ? decode(result[0], this.tenantId, this.projectId) : null;
  }

  async findById(scope: string, id: string): Promise<FactoryCommandDelivery | null> {
    this.assertScope(scope);
    const result = rows<CommandRow>(await this.database.execute(sql`SELECT payload, state, input_hash FROM factory_command_outbox
      WHERE tenant_id = ${this.tenantId} AND project_id = ${this.projectId} AND id = ${id} FOR UPDATE`));
    return result[0] ? decode(result[0], this.tenantId, this.projectId) : null;
  }

  async write(delivery: FactoryCommandDelivery): Promise<void> {
    await this.database.execute(sql`UPDATE factory_command_outbox SET state = ${delivery.state}, available_at = ${delivery.availableAt},
      lease_until = ${delivery.leaseUntil}, payload = ${JSON.stringify(delivery)}, updated_at = NOW()
      WHERE tenant_id = ${this.tenantId} AND project_id = ${this.projectId} AND id = ${delivery.id}`);
  }

  async inspect(scope: string, id: string): Promise<FactoryCommandDelivery | null> {
    this.assertScope(scope);
    const result = rows<CommandRow>(await this.database.execute(sql`SELECT payload, state, input_hash FROM factory_command_outbox
      WHERE tenant_id = ${this.tenantId} AND project_id = ${this.projectId} AND id = ${id}`));
    return result[0] ? decode(result[0], this.tenantId, this.projectId) : null;
  }
}

const stateMachine = new DurableDeliveryQueue<FactoryCommandDelivery>((code, message) => new FactoryOutboxError(code, message), () => crypto.randomUUID());

function commandFor(tenantId: string, input: FactoryCommandInput): FactoryCommand {
  identity(tenantId, input.projectId, input.logicalRunId);
  assertJson(input.body);
  if (input.kind === "compute_admission") identity(input.reservationId);
  else if (input.kind !== "start_run") identity(input.interpreterId, input.kind === "decision" ? input.decisionId : input.notificationId);
  const identityId = input.kind === "start_run" ? input.logicalRunId : input.kind === "compute_admission" ? input.reservationId : input.kind === "decision" ? input.decisionId : input.notificationId;
  const interpreter = input.kind === "compute_admission" ? undefined : input.interpreterId;
  if (interpreter !== undefined) identity(interpreter);
  let eventProof = {};
  if (input.kind === "decision" || input.kind === "partition_notification") {
    if (input.eventSequence !== undefined || input.eventHash !== undefined) {
      if (!Number.isSafeInteger(input.eventSequence) || input.eventSequence! < 1 || input.eventHash !== durableInputHash(input.body)) throw new FactoryOutboxError("factory_command_event_invalid");
      eventProof = { eventSequence: input.eventSequence, eventHash: input.eventHash };
    }
  }
  const commandId = `factory-command:${durableInputHash({ tenantId, projectId: input.projectId, logicalRunId: input.logicalRunId, kind: input.kind, identityId, ...(interpreter === undefined ? {} : { interpreterId: interpreter }) }).slice(7)}`;
  const command: FactoryCommand = {
    commandId,
    requestId: commandId,
    tenantId,
    projectId: input.projectId,
    logicalRunId: input.logicalRunId,
    workflowId: `${tenantId}/${input.logicalRunId}`,
    kind: input.kind,
    ...(interpreter === undefined ? {} : { interpreterId: interpreter }),
    ...(input.kind === "start_run" || input.kind === "compute_admission" ? {} : { eventId: identityId, ...eventProof }),
    body: input.body,
  };
  assertBoundedCommand(command);
  return JSON.parse(canonicalJson(command)) as FactoryCommand;
}

/** Tenant/project-scoped transactional commands consumed by the Node dispatcher. */
export class FactoryCommandOutbox {
  private readonly scope: string;

  constructor(private readonly database: TransactionalDb, readonly tenantId: string, readonly projectId: string, private readonly now: () => number = Date.now, private readonly destination: "temporal" | "pool" = "temporal") {
    identity(tenantId, projectId);
    this.scope = queueScope(tenantId, projectId);
  }

  async enqueue(input: FactoryCommandInput): Promise<FactoryCommandDelivery> {
    assertJson(input);
    const snapshot = JSON.parse(canonicalJson(input)) as FactoryCommandInput;
    return this.database.transaction(transaction => this.enqueueInTransaction(transaction, snapshot));
  }

  async enqueueInTransaction(transaction: MigrationDb, input: FactoryCommandInput): Promise<FactoryCommandDelivery> {
    if (input.projectId !== this.projectId) throw new FactoryOutboxError("factory_command_scope_mismatch");
    const command = commandFor(this.tenantId, input);
    const inputHash = durableInputHash(command);
    const store = new FactoryCommandStore(transaction, this.tenantId, this.projectId, this.destination);
    return stateMachine.enqueue(store, {
      scope: this.scope,
      deduplicationId: command.commandId,
      inputHash,
      hashExisting: delivery => delivery.inputHash,
      create: () => ({
        id: command.commandId,
        tenantId: this.tenantId,
        projectId: this.projectId,
        logicalRunId: input.logicalRunId,
        deduplicationId: command.commandId,
        inputHash,
        command,
        state: "queued",
        attempts: 0,
        maxAttempts: 3,
        availableAt: this.now(),
        leaseUntil: 0,
        createdAt: this.now(),
      }),
    });
  }

  async claim(leaseMs = 60_000): Promise<FactoryCommandDelivery | null> {
    return this.database.transaction(transaction => this.claimInTransaction(transaction, leaseMs));
  }

  async claimInTransaction(transaction: MigrationDb, leaseMs = 60_000): Promise<FactoryCommandDelivery | null> {
    return stateMachine.claim(new FactoryCommandStore(transaction, this.tenantId, this.projectId, this.destination), this.scope, this.now(), leaseMs);
  }

  async settle(delivery: FactoryCommandDelivery, outcome: "delivered" | "retry" | "outcome_unknown", failureCode?: string): Promise<FactoryCommandDelivery> {
    if (delivery.tenantId !== this.tenantId || delivery.projectId !== this.projectId) throw new FactoryOutboxError("factory_command_scope_mismatch");
    return this.database.transaction(transaction => stateMachine.settle(new FactoryCommandStore(transaction, this.tenantId, this.projectId, this.destination), this.scope, delivery, this.now(), outcome, failureCode));
  }

  async inspect(commandId: string): Promise<FactoryCommandDelivery | null> {
    return this.inspectInTransaction(this.database, commandId);
  }

  async inspectInTransaction(transaction: MigrationDb, commandId: string): Promise<FactoryCommandDelivery | null> {
    identity(commandId);
    return stateMachine.inspect(new FactoryCommandStore(transaction, this.tenantId, this.projectId, this.destination), this.scope, commandId);
  }

  /** Read the original durable request identity; never create a replacement. */
  async findRunCommandInTransaction(transaction: MigrationDb, runId: string, kind: "start_run" | "decision", eventId?: string): Promise<FactoryCommandDelivery | null> {
    identity(runId);
    if (eventId !== undefined) identity(eventId);
    const found = rows<CommandRow>(await transaction.execute(sql`SELECT payload, state, input_hash FROM factory_command_outbox WHERE tenant_id=${this.tenantId} AND project_id=${this.projectId} AND logical_run_id=${runId} AND payload::jsonb->'command'->>'kind'=${kind} ${eventId === undefined ? sql`` : sql`AND payload::jsonb->'command'->>'eventId'=${eventId}`} LIMIT 2`));
    if (found.length > 1) throw new FactoryOutboxError("factory_command_corrupt");
    const delivery = found[0] ? decode(found[0], this.tenantId, this.projectId) : null;
    if (delivery && delivery.logicalRunId !== runId) throw new FactoryOutboxError("factory_command_corrupt");
    return delivery;
  }

  async dispatch(handler: (delivery: FactoryCommandDelivery) => Promise<void>): Promise<FactoryCommandDelivery | null> {
    return dispatchDurableDelivery(() => this.claim(), (delivery, outcome, code) => this.settle(delivery, outcome, code), handler, error => error instanceof FactoryRetryableCommandError ? error.code : null);
  }
}

/** One installation dispatcher claims existing project queues without accepting a tenant selector. */
export class FactoryInstallationCommandOutbox {
  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly now: () => number = Date.now, private readonly destination: "temporal" | "pool" = "temporal") { identity(tenantId); }

  async claim(): Promise<FactoryCommandDelivery | null> {
    return this.database.transaction(async transaction => {
      const candidate = rows<{ project_id: string }>(await transaction.execute(sql`SELECT project_id FROM factory_command_outbox WHERE tenant_id=${this.tenantId} AND ${eligibleCommands(this.destination, this.now())} ORDER BY available_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`))[0];
      return candidate ? this.project(candidate.project_id).claimInTransaction(transaction) : null;
    });
  }

  async inspect(commandId: string, projectId: string): Promise<FactoryCommandDelivery | null> { return this.project(projectId).inspect(commandId); }

  async settle(delivery: FactoryCommandDelivery, outcome: "delivered" | "retry" | "outcome_unknown", failureCode?: string): Promise<FactoryCommandDelivery> {
    if (delivery.tenantId !== this.tenantId) throw new FactoryOutboxError("factory_command_scope_mismatch");
    return this.project(delivery.projectId).settle(delivery, outcome, failureCode);
  }

  private project(projectId: string): FactoryCommandOutbox { return new FactoryCommandOutbox(this.database, this.tenantId, projectId, this.now, this.destination); }
}

export class FactoryRetryableCommandError extends Error {
  constructor(readonly code: string) {
    super("Factory command failed before Temporal acknowledged it.");
    this.name = "FactoryRetryableCommandError";
  }
}
