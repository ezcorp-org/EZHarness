import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** The main schema supplies these existing product records without a cycle. */
export interface FactorySchemaReferences {
  readonly projects: { readonly id: AnyPgColumn };
  readonly users: { readonly id: AnyPgColumn };
  readonly serviceAccounts: { readonly id: AnyPgColumn; readonly projectId: AnyPgColumn };
}

/** Each table receives new columns; Drizzle columns cannot be shared. */
function tenantProjectColumns() {
  return { tenantId: text("tenant_id").notNull(), projectId: text("project_id").notNull() };
}

function tenantProjectRunColumns() {
  return { ...tenantProjectColumns(), runId: text("run_id").notNull() };
}

function createdAtColumn() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}

function updatedAtColumn() {
  return timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
}

/**
 * Product Factory storage. Pool and run-control databases deliberately do
 * not belong here. `schema.ts` calls this after it creates projects and users.
 */
export function buildFactorySchema({ projects, users, serviceAccounts }: FactorySchemaReferences) {
  const factoryInstallation = pgTable("factory_installation", {
    singleton: integer("singleton").primaryKey(),
    tenantId: text("tenant_id").notNull().unique(),
    executionEpoch: integer("execution_epoch").notNull().default(1),
  }, (table) => [
    check("factory_installation_singleton_check", sql`${table.singleton} = 1`),
    check("factory_installation_execution_epoch_check", sql`${table.executionEpoch} > 0`),
  ]);

  const factoryProjects = pgTable("factory_projects", tenantProjectColumns(), (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId] }),
    foreignKey({ columns: [table.tenantId], foreignColumns: [factoryInstallation.tenantId] }).onDelete("restrict"),
    foreignKey({ columns: [table.projectId], foreignColumns: [projects.id] }).onDelete("restrict"),
  ]);

  const factoryRuns = pgTable("factory_runs", {
    ...tenantProjectRunColumns(),
    definitionDigest: text("definition_digest").notNull(),
    interpreterBuild: text("interpreter_build").notNull(),
    executionEpoch: integer("execution_epoch").notNull(),
    requestDigest: text("request_digest").notNull(),
    requestPayload: text("request_payload").notNull(),
    nextSequence: bigint("next_sequence", { mode: "number" }).notNull().default(1),
    createdAt: createdAtColumn(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.runId] }),
    foreignKey({ columns: [table.tenantId, table.projectId], foreignColumns: [factoryProjects.tenantId, factoryProjects.projectId] }).onDelete("restrict"),
    check("factory_runs_execution_epoch_check", sql`${table.executionEpoch} > 0`),
    check("factory_runs_next_sequence_check", sql`${table.nextSequence} > 0`),
  ]);

  const factoryAuditBatches = pgTable("factory_audit_batches", {
    ...tenantProjectRunColumns(),
    interpreterId: text("interpreter_id").notNull(),
    sourceSequence: bigint("source_sequence", { mode: "number" }).notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    predecessorDigest: text("predecessor_digest"),
    digest: text("digest").notNull(),
    payload: text("payload").notNull(),
    createdAt: createdAtColumn(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.runId, table.interpreterId, table.sourceSequence] }),
    uniqueIndex("factory_audit_batches_tenant_id_project_id_run_id_sequence_key").on(table.tenantId, table.projectId, table.runId, table.sequence),
    foreignKey({ columns: [table.tenantId, table.projectId, table.runId], foreignColumns: [factoryRuns.tenantId, factoryRuns.projectId, factoryRuns.runId] }).onDelete("restrict"),
    check("factory_audit_batches_source_sequence_check", sql`${table.sourceSequence} > 0`),
    check("factory_audit_batches_sequence_check", sql`${table.sequence} > 0`),
  ]);

  /** Bounded lookup only; the referenced audit batch remains the authority. */
  const factoryTransitionCommands = pgTable("factory_transition_commands", {
    ...tenantProjectRunColumns(),
    interpreterId: text("interpreter_id").notNull(),
    commandId: text("command_id").notNull(),
    sourceSequence: bigint("source_sequence", { mode: "number" }).notNull(),
    commandDigest: text("command_digest").notNull(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.runId, table.interpreterId, table.commandId] }),
    foreignKey({ columns: [table.tenantId, table.projectId, table.runId, table.interpreterId, table.sourceSequence], foreignColumns: [factoryAuditBatches.tenantId, factoryAuditBatches.projectId, factoryAuditBatches.runId, factoryAuditBatches.interpreterId, factoryAuditBatches.sourceSequence] }).onDelete("restrict"),
    check("factory_transition_commands_source_sequence_check", sql`${table.sourceSequence} > 0`),
    check("factory_transition_commands_digest_check", sql`${table.commandDigest} ~ '^sha256:[0-9a-f]{64}$'`),
  ]);

  const factoryCommandOutbox = pgTable("factory_command_outbox", {
    id: text("id").notNull(),
    ...tenantProjectColumns(),
    logicalRunId: text("logical_run_id").notNull(),
    deduplicationId: text("deduplication_id").notNull(),
    inputHash: text("input_hash").notNull(),
    state: text("state").notNull(),
    availableAt: bigint("available_at", { mode: "number" }).notNull(),
    leaseUntil: bigint("lease_until", { mode: "number" }).notNull().default(0),
    payload: text("payload").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.id] }),
    uniqueIndex("factory_command_outbox_tenant_id_project_id_deduplication_id_key").on(table.tenantId, table.projectId, table.deduplicationId),
    index("idx_factory_command_outbox_ready").on(table.tenantId, table.projectId, table.state, table.availableAt, table.leaseUntil),
    foreignKey({ columns: [table.tenantId, table.projectId, table.logicalRunId], foreignColumns: [factoryRuns.tenantId, factoryRuns.projectId, factoryRuns.runId] }).onDelete("restrict"),
    check("factory_command_outbox_input_hash_check", sql`${table.inputHash} ~ '^sha256:[0-9a-f]{64}$'`),
    check("factory_command_outbox_state_check", sql`${table.state} IN ('queued', 'leased', 'delivered', 'cancelled', 'dead_letter', 'outcome_unknown')`),
  ]);

  const factoryRunProjections = pgTable("factory_run_projections", {
    ...tenantProjectRunColumns(),
    consumerId: text("consumer_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    digest: text("digest").notNull(),
    payload: text("payload").notNull(),
    updatedAt: updatedAtColumn(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.runId, table.consumerId] }),
    foreignKey({ columns: [table.tenantId, table.projectId, table.runId], foreignColumns: [factoryRuns.tenantId, factoryRuns.projectId, factoryRuns.runId] }).onDelete("restrict"),
    check("factory_run_projections_sequence_check", sql`${table.sequence} > 0`),
  ]);

  /** Retry state schedules read-model work only; the audit cursor remains authoritative. */
  const factoryRunProjectionAttempts = pgTable("factory_run_projection_attempts", {
    ...tenantProjectRunColumns(),
    consumerId: text("consumer_id").notNull(),
    attemptCount: bigint("attempt_count", { mode: "number" }).notNull().default(1),
    lastErrorCode: text("last_error_code"),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }).notNull().defaultNow(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.runId, table.consumerId] }),
    index("idx_factory_projection_attempts_pending").on(table.tenantId, table.consumerId, table.lastAttemptedAt, table.projectId, table.runId),
    foreignKey({ columns: [table.tenantId, table.projectId, table.runId], foreignColumns: [factoryRuns.tenantId, factoryRuns.projectId, factoryRuns.runId] }).onDelete("restrict"),
    check("factory_run_projection_attempts_count_check", sql`${table.attemptCount} > 0`),
  ]);

  const factoryInboxCursors = pgTable("factory_inbox_cursors", {
    ...tenantProjectRunColumns(),
    interpreterId: text("interpreter_id").notNull(),
    nextSequence: bigint("next_sequence", { mode: "number" }).notNull().default(1),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.runId, table.interpreterId] }),
    foreignKey({ columns: [table.tenantId, table.projectId, table.runId], foreignColumns: [factoryRuns.tenantId, factoryRuns.projectId, factoryRuns.runId] }).onDelete("restrict"),
    check("factory_inbox_cursors_next_sequence_check", sql`${table.nextSequence} > 0`),
  ]);

  const factoryInboxEvents = pgTable("factory_inbox_events", {
    ...tenantProjectRunColumns(),
    interpreterId: text("interpreter_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    eventId: text("event_id").notNull(),
    eventHash: text("event_hash").notNull(),
    kind: text("kind").notNull(),
    payload: text("payload").notNull(),
    appliedSourceSequence: bigint("applied_source_sequence", { mode: "number" }),
    appliedDigest: text("applied_digest"),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.runId, table.interpreterId, table.eventId] }),
    uniqueIndex("factory_inbox_events_tenant_id_project_id_run_id_interpreter_id_sequence_key").on(table.tenantId, table.projectId, table.runId, table.interpreterId, table.sequence),
    index("idx_factory_inbox_pending").on(table.tenantId, table.projectId, table.runId, table.interpreterId, table.sequence).where(sql`${table.appliedSourceSequence} IS NULL`),
    foreignKey({ columns: [table.tenantId, table.projectId, table.runId, table.interpreterId], foreignColumns: [factoryInboxCursors.tenantId, factoryInboxCursors.projectId, factoryInboxCursors.runId, factoryInboxCursors.interpreterId] }).onDelete("restrict"),
    foreignKey({ columns: [table.tenantId, table.projectId, table.runId, table.interpreterId, table.appliedSourceSequence], foreignColumns: [factoryAuditBatches.tenantId, factoryAuditBatches.projectId, factoryAuditBatches.runId, factoryAuditBatches.interpreterId, factoryAuditBatches.sourceSequence] }).onDelete("restrict"),
    check("factory_inbox_events_sequence_check", sql`${table.sequence} > 0`),
    check("factory_inbox_events_hash_check", sql`${table.eventHash} ~ '^sha256:[0-9a-f]{64}$'`),
    check("factory_inbox_events_kind_check", sql`${table.kind} IN ('decision', 'partition_notification')`),
    check("factory_inbox_events_applied_receipt_check", sql`(${table.appliedSourceSequence} IS NULL) = (${table.appliedDigest} IS NULL)`),
  ]);

  const factoryGrants = pgTable("factory_grants", {
    ...tenantProjectColumns(),
    principalKind: text("principal_kind").notNull(),
    principalId: text("principal_id").notNull(),
    action: text("action").notNull(),
    issuerId: text("issuer_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: updatedAtColumn(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.principalKind, table.principalId, table.action] }),
    foreignKey({ columns: [table.tenantId, table.projectId], foreignColumns: [factoryProjects.tenantId, factoryProjects.projectId] }).onDelete("restrict"),
    foreignKey({ columns: [table.issuerId], foreignColumns: [users.id] }).onDelete("restrict"),
    check("factory_grants_principal_kind_check", sql`${table.principalKind} IN ('user', 'service')`),
    check("factory_grants_action_check", sql`${table.action} IN ('factory.author', 'factory.publish', 'factory.run', 'factory.operate', 'factory.approve', 'factory.release', 'factory.trust')`),
    check("factory_grants_revision_check", sql`${table.revision} > 0`),
  ]);

  const factoryServiceCredentials = pgTable("factory_service_credentials", {
    ...tenantProjectColumns(),
    serviceAccountId: text("service_account_id").notNull(),
    credentialId: text("credential_id").notNull(),
    scopes: jsonb("scopes").notNull().$type<("read" | "write" | "chat")[]>(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    issuedByUserId: text("issued_by_user_id").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: updatedAtColumn(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.serviceAccountId, table.credentialId] }),
    foreignKey({ columns: [table.tenantId, table.projectId], foreignColumns: [factoryProjects.tenantId, factoryProjects.projectId] }).onDelete("restrict"),
    foreignKey({ columns: [table.serviceAccountId, table.projectId], foreignColumns: [serviceAccounts.id, serviceAccounts.projectId] }).onDelete("cascade"),
    foreignKey({ columns: [table.issuedByUserId], foreignColumns: [users.id] }).onDelete("restrict"),
    index("idx_factory_service_credentials_live").on(table.tenantId, table.projectId, table.serviceAccountId, table.credentialId, table.revision),
    check("factory_service_credentials_revision_check", sql`${table.revision} > 0`),
    check("factory_service_credentials_expiry_check", sql`${table.expiresAt} > ${table.issuedAt}`),
    check("factory_service_credentials_max_expiry_check", sql`${table.expiresAt} <= ${table.issuedAt} + INTERVAL '1 hour'`),
    check("factory_service_credentials_scopes_check", sql`jsonb_typeof(${table.scopes}) = 'array' AND jsonb_array_length(${table.scopes}) BETWEEN 1 AND 3 AND ${table.scopes} <@ '["read","write","chat"]'::jsonb`),
  ]);

  const factoryBudgetEnvelopes = pgTable("factory_budget_envelopes", {
    ...tenantProjectRunColumns(),
    envelopeId: text("envelope_id").notNull(),
    parentId: text("parent_id"),
    requestDigest: text("request_digest").notNull(),
    limits: text("limits").notNull(),
    allocated: text("allocated").notNull(),
    spent: text("spent").notNull(),
    deadlineMs: bigint("deadline_ms", { mode: "number" }).notNull(),
    state: text("state").notNull(),
    admissionBlocked: boolean("admission_blocked").notNull().default(false),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.runId, table.envelopeId] }),
    uniqueIndex("factory_budget_root").on(table.tenantId, table.projectId, table.runId).where(sql`${table.parentId} IS NULL`),
    foreignKey({ columns: [table.tenantId, table.projectId, table.runId], foreignColumns: [factoryRuns.tenantId, factoryRuns.projectId, factoryRuns.runId] }).onDelete("restrict"),
    foreignKey({ columns: [table.tenantId, table.projectId, table.runId, table.parentId], foreignColumns: [table.tenantId, table.projectId, table.runId, table.envelopeId] }).onDelete("restrict"),
    check("factory_budget_envelopes_deadline_ms_check", sql`${table.deadlineMs} > 0`),
    check("factory_budget_envelopes_state_check", sql`${table.state} IN ('open', 'closed')`),
  ]);

  const factoryBudgetReservations = pgTable("factory_budget_reservations", {
    ...tenantProjectRunColumns(),
    reservationId: text("reservation_id").notNull(),
    envelopeId: text("envelope_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    amount: text("amount").notNull(),
    actual: text("actual"),
    receiptDigest: text("receipt_digest"),
    computeAllocation: text("compute_allocation"),
    uncertainty: text("uncertainty"),
    state: text("state").notNull(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.runId, table.reservationId] }),
    foreignKey({ columns: [table.tenantId, table.projectId, table.runId, table.envelopeId], foreignColumns: [factoryBudgetEnvelopes.tenantId, factoryBudgetEnvelopes.projectId, factoryBudgetEnvelopes.runId, factoryBudgetEnvelopes.envelopeId] }).onDelete("restrict"),
    check("factory_budget_reservations_state_check", sql`${table.state} IN ('held', 'running', 'uncertain', 'settled')`),
  ]);

  const factoryComputeAdmissions = pgTable("factory_compute_admissions", {
    ...tenantProjectRunColumns(),
    reservationId: text("reservation_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    requestJson: text("request_json").notNull(),
    state: text("state").notNull(),
    nextPollAt: bigint("next_poll_at", { mode: "number" }).notNull(),
    remoteAttempted: boolean("remote_attempted").notNull().default(false),
    pollLeaseUntil: bigint("poll_lease_until", { mode: "number" }).notNull().default(0),
    pollLeaseToken: text("poll_lease_token"),
    responseDigest: text("response_digest"),
    responseJson: text("response_json"),
    eventDigest: text("event_digest"),
    eventJson: text("event_json"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.runId, table.reservationId] }),
    index("idx_factory_compute_admissions_poll").on(table.tenantId, table.nextPollAt, table.createdAt, table.reservationId).where(sql`${table.state} IN ('pending', 'queued', 'cancelling')`),
    foreignKey({ columns: [table.tenantId, table.projectId, table.runId, table.reservationId], foreignColumns: [factoryBudgetReservations.tenantId, factoryBudgetReservations.projectId, factoryBudgetReservations.runId, factoryBudgetReservations.reservationId] }).onDelete("restrict"),
    check("factory_compute_admissions_request_digest_check", sql`${table.requestDigest} ~ '^sha256:[0-9a-f]{64}$'`),
    check("factory_compute_admissions_state_check", sql`${table.state} IN ('pending', 'queued', 'admitted', 'rejected', 'cancelling', 'cancelled')`),
    check("factory_compute_admissions_next_poll_at_check", sql`${table.nextPollAt} >= 0`),
    check("factory_compute_admissions_poll_lease_until_check", sql`${table.pollLeaseUntil} >= 0`),
    check("factory_compute_admissions_poll_lease_check", sql`(${table.pollLeaseToken} IS NULL) = (${table.pollLeaseUntil} = 0)`),
    check("factory_compute_admissions_response_check", sql`(${table.responseDigest} IS NULL) = (${table.responseJson} IS NULL)`),
    check("factory_compute_admissions_event_check", sql`(${table.eventDigest} IS NULL) = (${table.eventJson} IS NULL)`),
    check("factory_compute_admissions_terminal_event_check", sql`(${table.state} IN ('admitted', 'rejected')) = (${table.eventJson} IS NOT NULL)`),
  ]);

  const factoryMutationReceipts = pgTable("factory_mutation_receipts", {
    ...tenantProjectColumns(),
    principalKind: text("principal_kind").notNull(),
    principalId: text("principal_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputDigest: text("input_digest").notNull(),
    responseJson: text("response_json"),
    responseDigest: text("response_digest"),
    createdAt: createdAtColumn(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.principalKind, table.principalId, table.idempotencyKey] }),
    foreignKey({ columns: [table.tenantId, table.projectId], foreignColumns: [factoryProjects.tenantId, factoryProjects.projectId] }).onDelete("restrict"),
  ]);

  const factoryDrafts = pgTable("factory_drafts", {
    ...tenantProjectColumns(),
    factoryId: text("factory_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    sourceDigest: text("source_digest").notNull(),
    sourceJson: text("source_json").notNull(),
    requiredResourcesJson: text("required_resources_json").notNull().default("[]"),
    requirementsComplete: boolean("requirements_complete").notNull().default(false),
    validationDiagnosticCount: integer("validation_diagnostic_count").notNull().default(1),
    archived: boolean("archived").notNull().default(false),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.factoryId] }),
    foreignKey({ columns: [table.tenantId, table.projectId], foreignColumns: [factoryProjects.tenantId, factoryProjects.projectId] }).onDelete("restrict"),
    check("factory_drafts_revision_check", sql`${table.revision} > 0`),
    check("factory_drafts_validation_diagnostic_count_check", sql`${table.validationDiagnosticCount} >= 0`),
    check("factory_drafts_required_resources_bytes", sql`octet_length(${table.requiredResourcesJson}) <= 65536`),
  ]);

  const factoryVersions = pgTable("factory_versions", {
    ...tenantProjectColumns(),
    factoryId: text("factory_id").notNull(),
    version: text("version").notNull(),
    draftRevision: bigint("draft_revision", { mode: "number" }).notNull(),
    definitionDigest: text("definition_digest").notNull(),
    compiledBlobDigest: text("compiled_blob_digest").notNull(),
    compiledBytes: integer("compiled_bytes").notNull(),
    lockJson: text("lock_json").notNull(),
    createdAt: createdAtColumn(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.factoryId, table.version] }),
    foreignKey({ columns: [table.tenantId, table.projectId, table.factoryId], foreignColumns: [factoryDrafts.tenantId, factoryDrafts.projectId, factoryDrafts.factoryId] }).onDelete("restrict"),
    check("factory_versions_draft_revision_check", sql`${table.draftRevision} > 0`),
    check("factory_versions_compiled_bytes_check", sql`${table.compiledBytes} > 0`),
  ]);

  const factoryRunLifecycle = pgTable("factory_run_lifecycle", {
    ...tenantProjectRunColumns(),
    factoryId: text("factory_id").notNull(),
    factoryVersion: text("factory_version").notNull(),
    definitionDigest: text("definition_digest").notNull(),
    grantRevision: bigint("grant_revision", { mode: "number" }).notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    cancellationEpoch: bigint("cancellation_epoch", { mode: "number" }).notNull().default(0),
    status: text("status").notNull(),
    deadlineMs: bigint("deadline_ms", { mode: "number" }).notNull(),
    parametersJson: text("parameters_json").notNull(),
    parametersDigest: text("parameters_digest").notNull(),
    outputJson: text("output_json"),
    errorJson: text("error_json"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.runId] }),
    foreignKey({ columns: [table.tenantId, table.projectId, table.runId], foreignColumns: [factoryRuns.tenantId, factoryRuns.projectId, factoryRuns.runId] }).onDelete("restrict"),
    foreignKey({ columns: [table.tenantId, table.projectId, table.factoryId, table.factoryVersion], foreignColumns: [factoryVersions.tenantId, factoryVersions.projectId, factoryVersions.factoryId, factoryVersions.version] }).onDelete("restrict"),
    index("idx_factory_run_lifecycle_list").on(table.tenantId, table.projectId, table.factoryId, table.runId),
    check("factory_run_lifecycle_grant_revision_check", sql`${table.grantRevision} > 0`),
    check("factory_run_lifecycle_revision_check", sql`${table.revision} > 0`),
    check("factory_run_lifecycle_cancellation_epoch_check", sql`${table.cancellationEpoch} >= 0`),
    check("factory_run_lifecycle_deadline_ms_check", sql`${table.deadlineMs} > 0`),
    check("factory_run_lifecycle_status_check", sql`${table.status} IN ('queued','running','waiting','succeeded','failed','cancelling','cancelled','uncertain')`),
  ]);

  const factoryExecutions = pgTable("factory_executions", {
    attemptId: text("attempt_id").primaryKey(),
    ...tenantProjectRunColumns(),
    nodeInstanceId: text("node_instance_id").notNull(),
    candidateGeneration: bigint("candidate_generation", { mode: "number" }).notNull(),
    attemptNumber: bigint("attempt_number", { mode: "number" }).notNull(),
    grantRevision: bigint("grant_revision", { mode: "number" }).notNull(),
    reservationGeneration: bigint("reservation_generation", { mode: "number" }).notNull(),
    executionEpoch: bigint("execution_epoch", { mode: "number" }).notNull(),
    cancellationEpoch: bigint("cancellation_epoch", { mode: "number" }).notNull().default(0),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    requestHash: text("request_hash").notNull(),
    requestJson: jsonb("request_json").notNull(),
    operationInitialIndex: bigint("operation_initial_index", { mode: "number" }).notNull().default(0),
    status: text("status").notNull(),
    journalCursor: bigint("journal_cursor", { mode: "number" }).notNull().default(-1),
    cancelAcceptedAt: timestamp("cancel_accepted_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  }, (table) => [
    uniqueIndex("factory_executions_scope_attempt_key").on(table.attemptId, table.tenantId, table.projectId, table.runId),
    index("idx_factory_executions_run").on(table.tenantId, table.projectId, table.runId, table.createdAt),
    foreignKey({ columns: [table.tenantId, table.projectId, table.runId], foreignColumns: [factoryRuns.tenantId, factoryRuns.projectId, factoryRuns.runId] }).onDelete("restrict"),
    check("factory_executions_status_check", sql`${table.status} IN ('admitted', 'running', 'cancel_accepted', 'stopped', 'failed')`),
  ]);

  const factoryAttemptQueue = pgTable("factory_attempt_queue", {
    ...tenantProjectRunColumns(),
    attemptId: text("attempt_id").notNull(),
    deduplicationId: text("deduplication_id").notNull(),
    inputHash: text("input_hash").notNull(),
    state: text("state").notNull(),
    attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
    maxAttempts: bigint("max_attempts", { mode: "number" }).notNull(),
    availableAt: bigint("available_at", { mode: "number" }).notNull(),
    leaseUntil: bigint("lease_until", { mode: "number" }).notNull().default(0),
    leaseToken: text("lease_token"),
    failureCode: text("failure_code"),
    referenceJson: jsonb("reference_json").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.attemptId] }),
    uniqueIndex("factory_attempt_queue_scope_deduplication_key").on(table.tenantId, table.projectId, table.deduplicationId),
    index("idx_factory_attempt_queue_ready").on(table.tenantId, table.state, table.availableAt, table.leaseUntil, table.projectId, table.attemptId),
    foreignKey({ columns: [table.attemptId, table.tenantId, table.projectId, table.runId], foreignColumns: [factoryExecutions.attemptId, factoryExecutions.tenantId, factoryExecutions.projectId, factoryExecutions.runId] }).onDelete("restrict"),
    foreignKey({ columns: [table.tenantId, table.projectId, table.runId], foreignColumns: [factoryRuns.tenantId, factoryRuns.projectId, factoryRuns.runId] }).onDelete("restrict"),
    check("factory_attempt_queue_input_hash_check", sql`${table.inputHash} ~ '^sha256:[0-9a-f]{64}$'`),
    check("factory_attempt_queue_state_check", sql`${table.state} IN ('queued','leased','delivered','cancelled','dead_letter','outcome_unknown')`),
    check("factory_attempt_queue_attempts_check", sql`${table.attempts} >= 0`),
    check("factory_attempt_queue_max_attempts_check", sql`${table.maxAttempts} >= 1 AND ${table.maxAttempts} <= 10`),
    check("factory_attempt_queue_available_at_check", sql`${table.availableAt} >= 0`),
    check("factory_attempt_queue_lease_until_check", sql`${table.leaseUntil} >= 0`),
  ]);

  const factoryExecutionOperationCursors = pgTable("factory_execution_operation_cursors", {
    ...tenantProjectRunColumns(),
    nodeInstanceId: text("node_instance_id").notNull(),
    candidateGeneration: bigint("candidate_generation", { mode: "number" }).notNull(),
    nextOperationIndex: bigint("next_operation_index", { mode: "number" }).notNull().default(0),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.runId, table.nodeInstanceId, table.candidateGeneration] }),
    foreignKey({ columns: [table.tenantId, table.projectId, table.runId], foreignColumns: [factoryRuns.tenantId, factoryRuns.projectId, factoryRuns.runId] }).onDelete("restrict"),
  ]);

  const factoryExecutionOperations = pgTable("factory_execution_operations", {
    attemptId: text("attempt_id").notNull(),
    operationId: text("operation_id").notNull(),
    operationIndex: bigint("operation_index", { mode: "number" }).notNull(),
    kind: text("kind").notNull(),
    state: text("state").notNull(),
    requestDigest: text("request_digest").notNull(),
    providerReceiptDigest: text("provider_receipt_digest"),
    resultDigest: text("result_digest"),
    resultJson: jsonb("result_json"),
    usageJson: jsonb("usage_json"),
    workspaceCheckpoint: jsonb("workspace_checkpoint"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  }, (table) => [
    primaryKey({ columns: [table.attemptId, table.operationId] }),
    uniqueIndex("factory_execution_operations_attempt_id_operation_index_key").on(table.attemptId, table.operationIndex),
    index("idx_factory_execution_operations_cursor").on(table.attemptId, table.operationIndex),
    foreignKey({ columns: [table.attemptId], foreignColumns: [factoryExecutions.attemptId] }).onDelete("cascade"),
    check("factory_execution_operations_kind_check", sql`${table.kind} IN ('model', 'tool')`),
    check("factory_execution_operations_state_check", sql`${table.state} IN ('prepared', 'dispatched', 'completed', 'failed', 'uncertain')`),
  ]);

  return {
    factoryInstallation,
    factoryProjects,
    factoryRuns,
    factoryAuditBatches,
    factoryTransitionCommands,
    factoryCommandOutbox,
    factoryRunProjections,
    factoryRunProjectionAttempts,
    factoryInboxCursors,
    factoryInboxEvents,
    factoryGrants,
    factoryServiceCredentials,
    factoryBudgetEnvelopes,
    factoryBudgetReservations,
    factoryComputeAdmissions,
    factoryMutationReceipts,
    factoryDrafts,
    factoryVersions,
    factoryRunLifecycle,
    factoryExecutions,
    factoryAttemptQueue,
    factoryExecutionOperationCursors,
    factoryExecutionOperations,
  };
}
