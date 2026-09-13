import { lockFactoryScope } from "./locks";
import { createCompiledExecutionManifest } from "@ezcorp/factory-sdk/compiler";
import { validateValue } from "@ezcorp/factory-sdk/validation";
import type { BudgetBounds, CompiledFactory, FactoryRunDetails, FactoryRunStartBody, JsonValue } from "@ezcorp/factory-sdk";
import type { FactoryDefinitionSource, FactoryIdentity } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryAttemptAuthority } from "./executions";
import type { FactoryDefinitions, FactoryDefinitionKey } from "./definitions";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { FactoryBudgets, type FactoryBudgetAdmission } from "./budgets";
import { FactoryMutations } from "./mutations";
import { FactoryInbox } from "./inbox";
import { FactoryCommandOutbox } from "./outbox";
import { assertFactoryIdentity, encodeFactoryPayload, FactoryRecords, type FactoryRunKey } from "./records";

interface LifecycleRow { factory_id: string; factory_version: string; definition_digest: string; grant_revision: string | number; revision: string | number; cancellation_epoch: string | number; status: FactoryRunDetails["status"]; deadline_ms: string | number; parameters_json: string; parameters_digest: string; output_json: string | null; error_json: string | null; created_ms: string | number; updated_ms: string | number }
export interface FactoryRunLifecycleOptions {
  readonly definitions: FactoryDefinitions;
  readonly grants: FactoryGrants;
  readonly interpreterBuild: string;
  readonly interpreterCompatibility: string;
  readonly limits: Required<BudgetBounds>;
  /** Stages immutable artifacts through the configured storage service; no effects. */
  readonly stageDefinition: (compiled: CompiledFactory, identity: FactoryIdentity) => Promise<FactoryDefinitionSource>;
  /** Resolves host-issued artifact handles and validates their scoped bytes. */
  readonly resolveParameters: (transaction: MigrationDb, principal: FactoryPrincipal, key: FactoryDefinitionKey, parameters: FactoryRunStartBody["parameters"]) => Promise<JsonValue>;
}

export class FactoryRunLifecycleError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryRunLifecycleError"; }
}

function details(key: FactoryRunKey, row: LifecycleRow): FactoryRunDetails {
  if (digestObject(JSON.parse(row.parameters_json)) !== row.parameters_digest) throw new FactoryRunLifecycleError("factory_run_corrupt");
  return { runId: key.runId, factoryId: row.factory_id, factoryVersion: row.factory_version, definitionDigest: row.definition_digest, grantRevision: Number(row.grant_revision), revision: Number(row.revision), status: row.status, parameters: JSON.parse(row.parameters_json), ...(row.output_json === null ? {} : { output: JSON.parse(row.output_json) }), ...(row.error_json === null ? {} : { error: JSON.parse(row.error_json) }), createdAtMs: Number(row.created_ms), updatedAtMs: Number(row.updated_ms) };
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

  async start(principal: FactoryPrincipal, key: FactoryDefinitionKey, body: FactoryRunStartBody, expectedRevision: number, idempotencyKey: string): Promise<FactoryRunDetails> {
    const snapshot = JSON.parse(encodeFactoryPayload({ principal, key, body })) as { principal: FactoryPrincipal; key: FactoryDefinitionKey; body: FactoryRunStartBody };
    principal = snapshot.principal; key = snapshot.key; body = snapshot.body;
    if (expectedRevision !== 0) throw new FactoryRunLifecycleError("factory_revision_conflict");
    return this.mutations.execute({ principal, projectId: key.projectId, action: "factory.run", idempotencyKey, expectedGrantRevision: body.grantRevision, input: { kind: "run.start", ...key, expectedRevision, body } }, async transaction => {
      await this.options.grants.authorizeInTransaction(transaction, principal, key.projectId, "factory.run", body.grantRevision);
      const { version, compiled } = await this.options.definitions.readVersionInTransaction(transaction, principal, key, body.factoryVersion);
      if (version.definitionDigest !== body.definitionDigest) throw new FactoryRunLifecycleError("factory_definition_conflict");
      if (compiled.lock.interpreter !== this.options.interpreterCompatibility) throw new FactoryRunLifecycleError("factory_interpreter_unavailable");
      const input = await this.options.resolveParameters(transaction, principal, key, body.parameters);
      const ports = compiled.definition.inputPorts;
      if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).some(name => !Object.hasOwn(ports, name)) || Object.entries(ports).some(([name, schema]) => !Object.hasOwn(input, name) || !validateValue(schema, input[name]!).ok)) throw new FactoryRunLifecycleError("factory_input_invalid");
      const startedAtMs = this.now();
      const deadlineAtMs = startedAtMs + createCompiledExecutionManifest(compiled).bounds.runDeadlineMs;
      if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || !Number.isSafeInteger(deadlineAtMs)) throw new FactoryRunLifecycleError("factory_deadline_invalid");
      const runId = crypto.randomUUID();
      const identity = { tenantId: this.tenantId, projectId: key.projectId, logicalRunId: runId, interpreterId: "root" };
      const definition = await this.options.stageDefinition(compiled, identity);
      if (definition.definitionDigest !== body.definitionDigest) throw new FactoryRunLifecycleError("factory_definition_conflict");
      const workflowInput = JSON.parse(encodeFactoryPayload({ ...identity, startedAtMs, deadlineAtMs, definition, input })) as JsonValue;
      const installation = (await lockFactoryScope(transaction, this.tenantId, key.projectId, "write"))!;
      await this.records.createRunInTransaction(transaction, { projectId: key.projectId, runId, definitionDigest: body.definitionDigest, interpreterBuild: this.options.interpreterBuild, executionEpoch: installation.executionEpoch, input, principalId: principal.id, principalKind: principal.kind }, async tx => {
        await tx.execute(sql`INSERT INTO factory_run_lifecycle (tenant_id, project_id, run_id, factory_id, factory_version, definition_digest, grant_revision, status, deadline_ms, parameters_json, parameters_digest) VALUES (${this.tenantId}, ${key.projectId}, ${runId}, ${key.factoryId}, ${body.factoryVersion}, ${body.definitionDigest}, ${body.grantRevision}, 'queued', ${deadlineAtMs}, ${encodeFactoryPayload(body.parameters)}, ${digestObject(body.parameters)})`);
        await this.budgets.openEnvelopeInTransaction(tx, { projectId: key.projectId, runId, envelopeId: "root", limits: this.options.limits, deadlineAtMs });
        await new FactoryCommandOutbox(this.database, this.tenantId, key.projectId, this.now).enqueueInTransaction(tx, { kind: "start_run", projectId: key.projectId, logicalRunId: runId, interpreterId: "root", body: workflowInput });
      });
      const runKey = { projectId: key.projectId, runId };
      return details(runKey, await this.row(transaction, runKey));
    });
  }

  async cancel(principal: FactoryPrincipal, key: FactoryRunKey, expectedRevision: number, idempotencyKey: string, reason = "Operator requested cancellation"): Promise<FactoryRunDetails> {
    const snapshot = JSON.parse(encodeFactoryPayload({ principal, key })) as { principal: FactoryPrincipal; key: FactoryRunKey };
    principal = snapshot.principal; key = snapshot.key;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER || !reason || reason.length > 2048) throw new FactoryRunLifecycleError("factory_revision_invalid");
    return this.mutations.execute({ principal, projectId: key.projectId, action: "factory.operate", idempotencyKey, input: { kind: "run.cancel", ...key, expectedRevision, reason } }, async transaction => {
      const row = await this.row(transaction, key, true);
      if (Number(row.revision) !== expectedRevision) throw new FactoryRunLifecycleError("factory_revision_conflict");
      if (row.status === "succeeded" || row.status === "failed") throw new FactoryRunLifecycleError("factory_run_terminal");
      if (row.status === "cancelled" || row.status === "cancelling") return details(key, row);
      const epoch = Number(row.cancellation_epoch) + 1;
      if (!Number.isSafeInteger(epoch)) throw new FactoryRunLifecycleError("factory_epoch_invalid");
      await transaction.execute(sql`UPDATE factory_run_lifecycle SET status='cancelling', revision=${expectedRevision + 1}, cancellation_epoch=${epoch}, updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId}`);
      const eventId = `factory-cancel:${digestObject({ tenantId: this.tenantId, ...key, epoch })}`;
      await this.inbox.enqueueInTransaction(transaction, { ...key, interpreterId: "root" }, { kind: "cancel", id: eventId, atMs: this.now(), reason });
      await insertTransactionalAuditEntry(transaction, eventId, principal.kind === "user" ? principal.id : null, "factory.run.cancel.requested", key.runId, { tenantId: this.tenantId, projectId: key.projectId, cancellationEpoch: epoch, reason, principalId: principal.id, principalKind: principal.kind });
      return details(key, await this.row(transaction, key));
    });
  }

  async read(principal: FactoryPrincipal, key: FactoryRunKey): Promise<FactoryRunDetails> {
    const snapshot = JSON.parse(encodeFactoryPayload({ principal, key })) as { principal: FactoryPrincipal; key: FactoryRunKey };
    return this.database.transaction(async transaction => {
      await this.options.grants.authorizeInTransaction(transaction, snapshot.principal, snapshot.key.projectId, "read");
      return details(snapshot.key, await this.row(transaction, snapshot.key));
    });
  }

  readonly authorizeAdmissionInTransaction: FactoryBudgetAdmission = async (transaction, key) => {
    const row = await this.row(transaction, key, true);
    const request = await this.records.readRunRequestInTransaction(transaction, key);
    const installation = rows<{ execution_epoch: number }>(await transaction.execute(sql`SELECT execution_epoch FROM factory_installation WHERE tenant_id=${this.tenantId}`))[0];
    if (!installation || installation.execution_epoch !== request.executionEpoch) throw new FactoryRunLifecycleError("factory_run_fence_changed");
    if (!["queued", "running", "waiting"].includes(row.status) || Number(row.deadline_ms) <= this.now()) throw new FactoryRunLifecycleError("factory_run_stopped");
    const kind = request.principalKind ?? "user";
    await this.options.grants.authorizeInTransaction(transaction, { kind, id: request.principalId, authentication: kind === "user" ? "api-key" : "service" }, key.projectId, "factory.run", Number(row.grant_revision));
  };

  readonly authorizeAttemptInTransaction = async (transaction: MigrationDb, authority: FactoryAttemptAuthority & { readonly cancellationEpoch: number }): Promise<void> => {
    authority = { ...authority, deadlineAt: new Date(authority.deadlineAt) };
    if (authority.tenantId !== this.tenantId) throw new FactoryRunLifecycleError("factory_scope_mismatch");
    await this.authorizeAdmissionInTransaction(transaction, authority);
    const row = await this.row(transaction, authority);
    const request = await this.records.readRunRequestInTransaction(transaction, authority);
    if (authority.cancellationEpoch !== Number(row.cancellation_epoch) || authority.executionEpoch !== request.executionEpoch || authority.grantRevision !== Number(row.grant_revision) || !Number.isSafeInteger(authority.deadlineAt.getTime()) || authority.deadlineAt.getTime() <= this.now() || authority.deadlineAt.getTime() > Number(row.deadline_ms)) throw new FactoryRunLifecycleError("factory_run_fence_changed");
  };

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
