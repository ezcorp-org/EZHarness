import { lockFactoryScope } from "./locks";
import { createCompiledExecutionManifest } from "@ezcorp/factory-sdk/compiler";
import { validateDurableInputPorts, validateValue } from "@ezcorp/factory-sdk/validation";
import type { BudgetBounds, CompiledFactory, FactoryRunDetails, FactoryRunStartBody, FactoryRunListQuery, FactoryRunSummary, FactoryDurableReceipt, FactoryCommandResource, FactoryRunError, FactoryTransportValue, JsonValue } from "@ezcorp/factory-sdk";
import type { FactoryDefinitionSource, FactoryIdentity } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryAttemptAuthority } from "./executions";
import type { FactoryDefinitions, FactoryDefinitionKey } from "./definitions";
import { FactoryGrantError, type FactoryGrants, type FactoryPrincipal } from "./grants";
import { FactoryBudgets, type FactoryBudgetAdmission } from "./budgets";
import { FactoryMutations } from "./mutations";
import { FactoryInbox } from "./inbox";
import { FactoryCommandOutbox } from "./outbox";
import { assertFactoryIdentity, encodeFactoryPayload, FactoryRecords, type FactoryRunKey } from "./records";

interface LifecycleRow { factory_id: string; factory_version: string; definition_digest: string; grant_revision: string | number; revision: string | number; cancellation_epoch: string | number; status: FactoryRunDetails["status"]; deadline_ms: string | number; parameters_json: string; parameters_digest: string; output_json: string | null; error_json: string | null; created_ms: string | number; updated_ms: string | number }
export interface FactoryRunRequest { readonly run: FactoryRunDetails; readonly receipt: FactoryDurableReceipt }
/** Lets host admission retain a bounded placeholder while the durable parameter descriptor carries artifact references. */
export interface FactoryResolvedParameters {
  readonly kind: "factory.run-resolved-parameters";
  readonly input: JsonValue;
}

export interface FactoryRunFence {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly executionEpoch: number;
  readonly cancellationEpoch: number;
  readonly grantRevision: number;
  readonly revision: number;
  readonly deadlineAtMs: number;
  readonly definitionDigest: string;
  readonly status: FactoryRunDetails["status"];
}
export interface FactoryRunProjectionState {
  readonly status: FactoryRunDetails["status"];
  readonly output?: FactoryTransportValue;
  readonly error?: FactoryRunError;
}
export interface FactoryRunLifecycleOptions {
  readonly definitions: FactoryDefinitions;
  readonly grants: FactoryGrants;
  readonly interpreterBuild: string;
  readonly interpreterCompatibility: string;
  readonly limits: Required<BudgetBounds>;
  /** Stages immutable artifacts through the configured storage service; no effects. */
  readonly stageDefinitionInTransaction: (transaction: MigrationDb, compiled: CompiledFactory, identity: FactoryIdentity) => Promise<FactoryDefinitionSource>;
  /** Resolves host-issued artifact handles and validates their scoped bytes. */
  readonly resolveParameters: (transaction: MigrationDb, principal: FactoryPrincipal, key: FactoryDefinitionKey, parameters: FactoryRunStartBody["parameters"]) => Promise<JsonValue | FactoryResolvedParameters>;
}

export class FactoryRunLifecycleError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryRunLifecycleError"; }
}

function details(key: FactoryRunKey, row: LifecycleRow): FactoryRunDetails {
  if (digestObject(JSON.parse(row.parameters_json)) !== row.parameters_digest) throw new FactoryRunLifecycleError("factory_run_corrupt");
  return { ...summary(key, row), parameters: JSON.parse(row.parameters_json), ...(row.output_json === null ? {} : { output: JSON.parse(row.output_json) }), ...(row.error_json === null ? {} : { error: JSON.parse(row.error_json) }) };
}

function summary(key: FactoryRunKey, row: LifecycleRow): FactoryRunSummary {
  return { runId: key.runId, factoryId: row.factory_id, factoryVersion: row.factory_version, definitionDigest: row.definition_digest, grantRevision: Number(row.grant_revision), revision: Number(row.revision), status: row.status, createdAtMs: Number(row.created_ms), updatedAtMs: Number(row.updated_ms) };
}

function initiator(request: Awaited<ReturnType<FactoryRecords["readRunRequestInTransaction"]>>): FactoryPrincipal {
  const kind = request.principalKind ?? "user";
  return { kind, id: request.principalId, authentication: kind === "user" ? "api-key" : "service", ...(request.serviceCredential === undefined ? {} : { credential: request.serviceCredential }) };
}

/** Product start/cancellation facts. Interpreter state is committed through audit. */
export class FactoryRunLifecycle {
  readonly budgets: FactoryBudgets;
  private readonly records: FactoryRecords;
  private readonly mutations: FactoryMutations;
  private readonly inbox: FactoryInbox;
  private readonly options: FactoryRunLifecycleOptions;
  constructor(private readonly database: TransactionalDb, readonly tenantId: string, options: FactoryRunLifecycleOptions, private readonly now: () => number = Date.now) {
    assertFactoryIdentity(tenantId, options.interpreterBuild, options.interpreterCompatibility);
    if (options.definitions.tenantId !== tenantId || options.grants.tenantId !== tenantId) throw new FactoryRunLifecycleError("factory_scope_mismatch");
    this.options = Object.freeze({ ...options, limits: Object.freeze({ ...options.limits }) });
    this.records = new FactoryRecords(database, tenantId);
    this.mutations = new FactoryMutations(database, tenantId, options.grants);
    this.inbox = new FactoryInbox(database, tenantId, now);
    this.budgets = new FactoryBudgets(database, tenantId, this.authorizeAdmissionInTransaction, now);
  }

  async start(principal: FactoryPrincipal, key: FactoryDefinitionKey, body: FactoryRunStartBody, expectedRevision: number, idempotencyKey: string): Promise<FactoryRunRequest> {
    const snapshot = JSON.parse(encodeFactoryPayload({ principal, key, body })) as { principal: FactoryPrincipal; key: FactoryDefinitionKey; body: FactoryRunStartBody };
    principal = snapshot.principal; key = snapshot.key; body = snapshot.body;
    if (expectedRevision !== 0) throw new FactoryRunLifecycleError("factory_revision_conflict");
    return this.mutations.execute({ principal, projectId: key.projectId, action: "factory.run", idempotencyKey, expectedGrantRevision: body.grantRevision, input: { kind: "run.start", ...key, expectedRevision, body } }, async transaction => {
      await this.options.grants.authorizeInTransaction(transaction, principal, key.projectId, "factory.run", body.grantRevision);
      const { version, compiled } = await this.options.definitions.readVersionInTransaction(transaction, principal, key, body.factoryVersion);
      if (version.definitionDigest !== body.definitionDigest) throw new FactoryRunLifecycleError("factory_definition_conflict");
      if (compiled.lock.interpreter !== this.options.interpreterCompatibility) throw new FactoryRunLifecycleError("factory_interpreter_unavailable");
      const resolved = await this.options.resolveParameters(transaction, principal, key, body.parameters);
      const resolvedDescriptor = typeof resolved === "object" && resolved !== null && !Array.isArray(resolved) && (resolved as { kind?: unknown }).kind === "factory.run-resolved-parameters";
      const input = resolvedDescriptor ? (resolved as FactoryResolvedParameters).input : resolved as JsonValue;
      const ports = compiled.definition.inputPorts;
      const durable = resolvedDescriptor ? { schemaVersion: "factory.lazy-input.v1" as const, parameters: body.parameters } : undefined;
      if (durable !== undefined) {
        if (!validateDurableInputPorts(ports, input, durable).ok) throw new FactoryRunLifecycleError("factory_input_invalid");
      } else if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).some(name => !Object.hasOwn(ports, name)) || Object.entries(ports).some(([name, schema]) => !Object.hasOwn(input, name) || !validateValue(schema, input[name]!).ok)) throw new FactoryRunLifecycleError("factory_input_invalid");
      const startedAtMs = this.now();
      const deadlineAtMs = startedAtMs + createCompiledExecutionManifest(compiled).bounds.runDeadlineMs;
      if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || !Number.isSafeInteger(deadlineAtMs)) throw new FactoryRunLifecycleError("factory_deadline_invalid");
      const runId = crypto.randomUUID();
      const identity = { tenantId: this.tenantId, projectId: key.projectId, logicalRunId: runId, interpreterId: "root" };
      const installation = (await lockFactoryScope(transaction, this.tenantId, key.projectId, "write"))!;
      await this.records.createRunInTransaction(transaction, { projectId: key.projectId, runId, definitionDigest: body.definitionDigest, interpreterBuild: this.options.interpreterBuild, executionEpoch: installation.executionEpoch, input, principalId: principal.id, principalKind: principal.kind, ...(principal.credential === undefined ? {} : { serviceCredential: principal.credential }) }, async tx => {
        const definition = await this.options.stageDefinitionInTransaction(tx, compiled, identity);
        if (definition.definitionDigest !== body.definitionDigest) throw new FactoryRunLifecycleError("factory_definition_conflict");
        const workflowInput = JSON.parse(encodeFactoryPayload({ ...identity, startedAtMs, deadlineAtMs, definition, input, durableInput: { schemaVersion: "factory.lazy-input.v1", parameters: body.parameters } })) as JsonValue;
        await tx.execute(sql`INSERT INTO factory_run_lifecycle (tenant_id, project_id, run_id, factory_id, factory_version, definition_digest, grant_revision, status, deadline_ms, parameters_json, parameters_digest) VALUES (${this.tenantId}, ${key.projectId}, ${runId}, ${key.factoryId}, ${body.factoryVersion}, ${body.definitionDigest}, ${body.grantRevision}, 'queued', ${deadlineAtMs}, ${encodeFactoryPayload(body.parameters)}, ${digestObject(body.parameters)})`);
        await this.budgets.openEnvelopeInTransaction(tx, { projectId: key.projectId, runId, envelopeId: "root", limits: this.options.limits, deadlineAtMs });
        await new FactoryCommandOutbox(this.database, this.tenantId, key.projectId, this.now).enqueueInTransaction(tx, { kind: "start_run", projectId: key.projectId, logicalRunId: runId, interpreterId: "root", body: workflowInput });
      });
      const runKey = { projectId: key.projectId, runId };
      return this.requestResult(transaction, runKey, await this.row(transaction, runKey), "start_run");
    });
  }

  async cancel(principal: FactoryPrincipal, key: FactoryRunKey, expectedRevision: number, idempotencyKey: string, reason = "Operator requested cancellation"): Promise<FactoryRunRequest> {
    const snapshot = JSON.parse(encodeFactoryPayload({ principal, key })) as { principal: FactoryPrincipal; key: FactoryRunKey };
    principal = snapshot.principal; key = snapshot.key;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER || !reason || reason.length > 2048) throw new FactoryRunLifecycleError("factory_revision_invalid");
    return this.mutations.execute({ principal, projectId: key.projectId, action: "factory.operate", idempotencyKey, input: { kind: "run.cancel", ...key, expectedRevision, reason } }, async transaction => {
      const row = await this.row(transaction, key, true);
      if (Number(row.revision) !== expectedRevision) throw new FactoryRunLifecycleError("factory_revision_conflict");
      if (row.status === "succeeded" || row.status === "failed") throw new FactoryRunLifecycleError("factory_run_terminal");
      if (row.status === "cancelled" || row.status === "cancelling") return this.requestResult(transaction, key, row, "decision", this.cancellationEventId(key, Number(row.cancellation_epoch)));
      const epoch = Number(row.cancellation_epoch) + 1;
      if (!Number.isSafeInteger(epoch)) throw new FactoryRunLifecycleError("factory_epoch_invalid");
      await transaction.execute(sql`UPDATE factory_run_lifecycle SET status='cancelling', revision=${expectedRevision + 1}, cancellation_epoch=${epoch}, updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId}`);
      const eventId = this.cancellationEventId(key, epoch);
      await this.inbox.enqueueInTransaction(transaction, { ...key, interpreterId: "root" }, { kind: "cancel", id: eventId, atMs: this.now(), reason });
      await insertTransactionalAuditEntry(transaction, eventId, principal.kind === "user" ? principal.id : null, "factory.run.cancel.requested", key.runId, { tenantId: this.tenantId, projectId: key.projectId, cancellationEpoch: epoch, reason, principalId: principal.id, principalKind: principal.kind });
      return this.requestResult(transaction, key, await this.row(transaction, key), "decision", eventId);
    }, transaction => this.authorizeCancellation(transaction, principal, key));
  }

  async read(principal: FactoryPrincipal, key: FactoryRunKey): Promise<FactoryRunDetails> {
    const snapshot = JSON.parse(encodeFactoryPayload({ principal, key })) as { principal: FactoryPrincipal; key: FactoryRunKey };
    return this.database.transaction(async transaction => {
      await this.options.grants.authorizeInTransaction(transaction, snapshot.principal, snapshot.key.projectId, "read");
      return details(snapshot.key, await this.row(transaction, snapshot.key));
    });
  }

  async list(principal: FactoryPrincipal, projectId: string, query: FactoryRunListQuery = {}): Promise<{ items: readonly FactoryRunSummary[]; nextCursor: string | null }> {
    const input = JSON.parse(encodeFactoryPayload({ principal, projectId, query })) as { principal: FactoryPrincipal; projectId: string; query: FactoryRunListQuery };
    const { limit = 50, cursor = "", factoryId, status, search } = input.query;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || cursor.length > 2048 || (search !== undefined && (!search || search.length > 512)) || (status !== undefined && !["queued", "running", "waiting", "cancelling", "succeeded", "failed", "cancelled", "uncertain"].includes(status))) throw new FactoryRunLifecycleError("factory_page_invalid");
    if (factoryId !== undefined) assertFactoryIdentity(factoryId);
    return this.database.transaction(async transaction => {
      await this.options.grants.authorizeInTransaction(transaction, input.principal, input.projectId, "read");
      const found = rows<LifecycleRow & { run_id: string }>(await transaction.execute(sql`SELECT run_id, factory_id, factory_version, definition_digest, grant_revision, revision, status, FLOOR(EXTRACT(EPOCH FROM created_at) * 1000) AS created_ms, FLOOR(EXTRACT(EPOCH FROM updated_at) * 1000) AS updated_ms FROM factory_run_lifecycle WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND run_id > ${cursor} ${factoryId === undefined ? sql`` : sql`AND factory_id=${factoryId}`} ${status === undefined ? sql`` : sql`AND status=${status}`} ${search === undefined ? sql`` : sql`AND (strpos(lower(run_id), lower(${search})) > 0 OR strpos(lower(factory_id), lower(${search})) > 0)`} ORDER BY run_id LIMIT ${limit + 1}`));
      const items = found.slice(0, limit).map(row => summary({ projectId: input.projectId, runId: row.run_id }, row));
      return { items, nextCursor: found.length > limit ? items[items.length - 1]!.runId : null };
    });
  }

  async readCommand(principal: FactoryPrincipal, key: FactoryRunKey, commandId: string): Promise<FactoryCommandResource> {
    const input = JSON.parse(encodeFactoryPayload({ principal, key, commandId })) as { principal: FactoryPrincipal; key: FactoryRunKey; commandId: string };
    return this.database.transaction(async transaction => {
      await this.options.grants.authorizeInTransaction(transaction, input.principal, input.key.projectId, "read");
      const command = await new FactoryCommandOutbox(this.database, this.tenantId, input.key.projectId, this.now).inspectInTransaction(transaction, input.commandId);
      if (!command || command.logicalRunId !== input.key.runId) throw new FactoryRunLifecycleError("factory_command_not_found");
      return { commandId: command.id, runId: command.logicalRunId, kind: command.command.kind, state: command.state, attempts: command.attempts, createdAtMs: command.createdAt, ...(command.failureCode === undefined ? {} : { failureCode: command.failureCode }) };
    });
  }

  /** Applies a verified transition-derived view without changing human revision or fences. */
  async applyProjectionInTransaction(transaction: MigrationDb, key: FactoryRunKey, next: FactoryRunProjectionState): Promise<boolean> {
    const row = await this.row(transaction, key, true);
    if (!['queued', 'running', 'waiting', 'cancelling', 'succeeded', 'failed', 'cancelled', 'uncertain'].includes(next.status)) throw new FactoryRunLifecycleError("factory_projection_invalid");
    if (next.output !== undefined && next.error !== undefined) throw new FactoryRunLifecycleError("factory_projection_invalid");
    if (["succeeded", "failed", "cancelled"].includes(row.status)) return false;
    if ((row.status === "cancelling" && next.status !== "cancelled") || (row.status === "uncertain" && next.status === "succeeded")) return false;
    const output = next.output === undefined ? null : encodeFactoryPayload(next.output);
    const error = next.error === undefined ? null : encodeFactoryPayload(next.error);
    await transaction.execute(sql`UPDATE factory_run_lifecycle SET status=${next.status}, output_json=${output}, error_json=${error}, updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId}`);
    return true;
  }

  /** Internal worker guard for a scoped durable read-model update. */
  async assertProjectionScopeInTransaction(transaction: MigrationDb, key: FactoryRunKey): Promise<void> {
    await this.row(transaction, key, true);
  }

  private cancellationEventId(key: FactoryRunKey, epoch: number): string {
    return `factory-cancel:${digestObject({ tenantId: this.tenantId, ...key, epoch })}`;
  }

  private async requestResult(transaction: MigrationDb, key: FactoryRunKey, row: LifecycleRow, kind: "start_run" | "decision", eventId?: string): Promise<FactoryRunRequest> {
    const command = await new FactoryCommandOutbox(this.database, this.tenantId, key.projectId, this.now).findRunCommandInTransaction(transaction, key.runId, kind, eventId);
    if (!command) throw new FactoryRunLifecycleError("factory_command_not_found");
    const segments = [key.projectId, key.runId, command.id].map(encodeURIComponent);
    return { run: details(key, row), receipt: { resourceId: key.runId, commandId: command.id, statusUrl: `/api/factories/projects/${segments[0]}/runs/${segments[1]}/commands/${segments[2]}` } };
  }

  readonly authorizeAdmissionInTransaction: FactoryBudgetAdmission = async (transaction, key) => {
    await this.authorizeRunInTransaction(transaction, key);
  };

  /** Trusted service boundary: lock the durable run and recheck its live authority. */
  async authorizeRunInTransaction(transaction: MigrationDb, key: FactoryRunKey): Promise<FactoryRunFence> {
    key = { projectId: key.projectId, runId: key.runId };
    const row = await this.row(transaction, key, true);
    const request = await this.records.readRunRequestInTransaction(transaction, key);
    const installation = rows<{ execution_epoch: number }>(await transaction.execute(sql`SELECT execution_epoch FROM factory_installation WHERE tenant_id=${this.tenantId}`))[0];
    if (!installation || installation.execution_epoch !== request.executionEpoch) throw new FactoryRunLifecycleError("factory_run_fence_changed");
    const fence = Object.freeze({ tenantId: this.tenantId, ...key, executionEpoch: request.executionEpoch, cancellationEpoch: Number(row.cancellation_epoch), grantRevision: Number(row.grant_revision), revision: Number(row.revision), deadlineAtMs: Number(row.deadline_ms), definitionDigest: row.definition_digest, status: row.status });
    if (![fence.revision, fence.grantRevision, fence.deadlineAtMs].every(value => Number.isSafeInteger(value) && value > 0) || !Number.isSafeInteger(fence.cancellationEpoch) || fence.cancellationEpoch < 0 || fence.definitionDigest !== request.definitionDigest) throw new FactoryRunLifecycleError("factory_run_corrupt");
    if (!["queued", "running", "waiting"].includes(row.status) || Number(row.deadline_ms) <= this.now()) throw new FactoryRunLifecycleError("factory_run_stopped");
    await this.options.grants.authorizeInTransaction(transaction, initiator(request), key.projectId, "factory.run", Number(row.grant_revision));
    return fence;
  }

  readonly authorizeAttemptInTransaction = async (transaction: MigrationDb, authority: FactoryAttemptAuthority): Promise<void> => {
    authority = { ...authority, deadlineAt: new Date(authority.deadlineAt) };
    if (authority.tenantId !== this.tenantId) throw new FactoryRunLifecycleError("factory_scope_mismatch");
    const fence = await this.authorizeRunInTransaction(transaction, { projectId: authority.projectId, runId: authority.runId });
    if (authority.cancellationEpoch !== fence.cancellationEpoch || authority.executionEpoch !== fence.executionEpoch || authority.grantRevision !== fence.grantRevision || !Number.isSafeInteger(authority.deadlineAt.getTime()) || authority.deadlineAt.getTime() <= this.now() || authority.deadlineAt.getTime() > fence.deadlineAtMs) throw new FactoryRunLifecycleError("factory_run_fence_changed");
  };

  /** Private command admission uses the exact published plan and the live initiator. */
  async readExecutionPlanInTransaction(transaction: MigrationDb, key: FactoryRunKey): Promise<{ readonly fence: FactoryRunFence; readonly compiled: CompiledFactory; readonly initiator: FactoryPrincipal }> {
    key = { projectId: key.projectId, runId: key.runId };
    const fence = await this.authorizeRunInTransaction(transaction, key);
    const row = await this.row(transaction, key);
    const request = await this.records.readRunRequestInTransaction(transaction, key);
    const principal = initiator(request);
    const { compiled } = await this.options.definitions.readVersionInTransaction(transaction, principal, { projectId: key.projectId, factoryId: row.factory_id }, row.factory_version);
    if (compiled.digest !== fence.definitionDigest || compiled.lock.interpreter !== this.options.interpreterCompatibility) throw new FactoryRunLifecycleError("factory_definition_conflict");
    return { fence, compiled, initiator: principal };
  }

  private async authorizeCancellation(transaction: MigrationDb, principal: FactoryPrincipal, key: FactoryRunKey): Promise<void> {
    await this.options.grants.authorizeInTransaction(transaction, principal, key.projectId, "read");
    const row = await this.row(transaction, key, true);
    const request = await this.records.readRunRequestInTransaction(transaction, key);
    if (request.principalId === principal.id && (request.principalKind ?? "user") === principal.kind) {
      try {
        await this.options.grants.authorizeInTransaction(transaction, principal, key.projectId, "factory.run", Number(row.grant_revision));
        return;
      } catch (error) {
        if (!(error instanceof FactoryGrantError) || !["factory_forbidden", "factory_grant_stale"].includes(error.code)) throw error;
      }
    }
    await this.options.grants.authorizeInTransaction(transaction, principal, key.projectId, "factory.operate");
  }

  private async row(transaction: MigrationDb, key: FactoryRunKey, lock = false): Promise<LifecycleRow> {
    assertFactoryIdentity(key.projectId, key.runId);
    if (lock) {
      if (!await lockFactoryScope(transaction, this.tenantId, key.projectId)) throw new FactoryRunLifecycleError("factory_run_not_found");
      await transaction.execute(sql`SELECT run_id FROM factory_runs WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} FOR UPDATE`);
    }
    const row = rows<LifecycleRow>(await transaction.execute(sql`SELECT factory_id, factory_version, definition_digest, grant_revision, revision, cancellation_epoch, status, deadline_ms, parameters_json, parameters_digest, output_json, error_json, FLOOR(EXTRACT(EPOCH FROM created_at) * 1000) AS created_ms, FLOOR(EXTRACT(EPOCH FROM updated_at) * 1000) AS updated_ms FROM factory_run_lifecycle WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} ${lock ? sql`FOR UPDATE` : sql``}`))[0];
    if (!row) throw new FactoryRunLifecycleError("factory_run_not_found");
    return row;
  }
}
