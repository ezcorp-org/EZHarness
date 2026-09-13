import { randomUUID } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { JsonValue } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { DurableDeliveryQueue, dispatchDurableDelivery, durableInputHash, type DurableDeliveryRecord, type DurableDeliveryStore } from "../delivery-queue/durable-delivery-queue";
import { digestBytes, digestObject } from "../extensions/v4/blobs";
import type { FactoryAcceptedRelease, FactoryAssurance } from "./assurance";
import { FactoryGrantError, type FactoryAction, type FactoryGrants, type FactoryPrincipal } from "./grants";
import { FactoryMutations } from "./mutations";
import { assertFactoryIdentity } from "./records";
import { protectFactoryCommandApproval } from "./assurance-commands";

const MAX_TEXT = 512;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_REASON_BYTES = 4096;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

export type FactoryReleaseState = "pending" | "executing" | "succeeded" | "failed" | "uncertain";
export type FactoryReconciliationAction = "attach_receipt" | "confirm_no_effect" | "keep_uncertain";

export interface FactoryReleaseDestination {
  readonly provider: string;
  readonly account: string;
  readonly object: string;
  readonly expectedVersion?: string;
}

export interface FactoryReleaseMaterial {
  readonly decisionId: string;
  readonly evidence: readonly unknown[];
  readonly packageTrustDigest: string;
  readonly validatorTrustDigest: string;
}

export interface FactoryReleaseRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly candidateGeneration: number;
  readonly decisionId: string;
  readonly candidateDigest: string;
  readonly action: string;
  readonly destination: FactoryReleaseDestination;
  readonly request: unknown;
  readonly estimatedSpendMicros: number;
  readonly deadlineMs: number;
}

export interface FactoryArchiveObject {
  readonly key: string;
  readonly digest: string;
  readonly versionId?: string;
}

export interface FactoryReleaseArchive {
  writeImmutable(tenantId: string, operationId: string, name: "intent" | "material" | "receipt" | "reconciliation", bytes: Uint8Array): Promise<FactoryArchiveObject>;
  read(reference: FactoryArchiveObject): Promise<Uint8Array>;
}

export interface FactoryReleaseMaterialReader {
  readPinnedInTransaction(transaction: MigrationDb, tenantId: string, accepted: FactoryAcceptedRelease): Promise<FactoryReleaseMaterial>;
}

export interface FactoryReleaseAuthority {
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly candidateGeneration: number;
  readonly candidateDigest: string;
  readonly executionEpoch: number;
  readonly cancellationEpoch: number;
  readonly releaseEnableEpoch: number;
  readonly deadlineMs: number;
  readonly status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelling" | "cancelled" | "uncertain";
  readonly packageTrustDigest: string;
  readonly validatorTrustDigest: string;
}

/** The composition implementation takes canonical project, installation, run, and lifecycle locks before it returns. */
export interface FactoryReleaseAuthorityReader {
  lockCurrentInTransaction(transaction: MigrationDb, tenantId: string, projectId: string, runId: string, nodeInstanceId: string): Promise<FactoryReleaseAuthority>;
}

/** The provider-specific implementation checks the live destination and reserves the exact expected version in the same product transaction. */
export interface FactoryDestinationReservationReader {
  reserveInTransaction(transaction: MigrationDb, tenantId: string, operation: FactoryReleaseOperation): Promise<{ readonly currentVersion: string | null }>;
}

export interface FactorySenderFence {
  proveStopped(operation: FactoryReleaseOperation, senderToken: string, evidence: unknown, signal?: AbortSignal): Promise<boolean>;
}

export interface FactoryReleaseProvider {
  publish(claim: FactoryReleaseClaim): Promise<FactoryProviderReceipt>;
  proveNoEffect(operation: FactoryReleaseOperation, evidence: unknown, signal?: AbortSignal): Promise<boolean>;
}

export interface FactoryProviderReceipt {
  readonly provider: string;
  readonly account: string;
  readonly object: string;
  readonly requestDigest: string;
  readonly operationId: string;
  readonly dispatchGeneration: number;
  readonly providerReceiptId: string;
  readonly version: string;
  readonly effectDigest: string;
}

export interface FactoryReleaseOperation extends FactoryReleaseRequest {
  readonly tenantId: string;
  readonly operationId: string;
  readonly contractDigest: string;
  readonly executionEpoch: number;
  readonly cancellationEpoch: number;
  readonly releaseEnableEpoch: number;
  readonly destinationDigest: string;
  readonly requestDigest: string;
  readonly material: FactoryReleaseMaterial;
  readonly materialDigest: string;
  readonly state: FactoryReleaseState;
  readonly dispatchGeneration: number;
  readonly dispatchStarted: boolean;
  readonly senderToken?: string;
  readonly archiveReady: boolean;
  readonly intentArchive?: FactoryArchiveObject;
  readonly materialArchive?: FactoryArchiveObject;
  readonly receiptArchive?: FactoryArchiveObject;
  readonly receipt?: FactoryProviderReceipt;
  readonly outcomeCode?: string;
  readonly authority?: { readonly kind: "approval" | "policy"; readonly id: string; readonly policyRevision?: number };
}

export interface FactoryReleaseClaim extends FactoryReleaseOperation {
  readonly state: "executing";
  readonly senderToken: string;
  readonly authority: { readonly kind: "approval" | "policy"; readonly id: string; readonly policyRevision?: number };
}

export type FactoryReleaseConsent =
  | { readonly kind: "approval"; readonly approvalId: string }
  | { readonly kind: "policy"; readonly policyId: string; readonly expectedRevision: number };

export interface FactoryAutomaticReleasePolicy {
  readonly projectId: string;
  readonly policyId: string;
  readonly principal: FactoryPrincipal;
  readonly action: string;
  readonly destinationProvider: string;
  readonly destinationAccount: string;
  readonly destinationPrefix: string;
  readonly contractDigest: string;
  readonly revision: number;
  readonly maxOperations: number;
  readonly maxSpendMicros: number;
  readonly expiresAtMs: number;
}

export interface FactoryReconciliationRequest {
  readonly projectId: string;
  readonly operationId: string;
  readonly action: FactoryReconciliationAction;
  readonly reason: string;
  readonly providerEvidence: unknown;
  readonly receipt?: FactoryProviderReceipt;
}

interface FactoryNotificationBase extends DurableDeliveryRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly deduplicationId: string;
  readonly inputHash: string;
  readonly payload: unknown;
}

export type FactoryNotification = FactoryNotificationBase & (
  | { readonly kind: "approval_requested" | "release_uncertain" | "release_settled"; readonly operationId: string }
  | { readonly kind: "command_approval_requested"; readonly approvalId: string }
);

export type FactoryVisibleReleaseNotification =
  | { readonly notificationId: string; readonly operationId: string; readonly createdAtMs: number; readonly kind: "approval_requested"; readonly approvalId: string; readonly contextDigest: string; readonly expiresAtMs: number }
  | { readonly notificationId: string; readonly operationId: string; readonly createdAtMs: number; readonly kind: "release_uncertain"; readonly dispatchGeneration: number; readonly outcomeCode: string }
  | { readonly notificationId: string; readonly operationId: string; readonly createdAtMs: number; readonly kind: "release_settled"; readonly dispatchGeneration: number; readonly outcomeCode: string }
  | { readonly notificationId: string; readonly createdAtMs: number; readonly kind: "command_approval_requested"; readonly approvalId: string; readonly runId: string; readonly commandId: string; readonly nodeInstanceId: string; readonly contextDigest: string; readonly context: JsonValue; readonly choices: readonly string[]; readonly actorScope: "owner" | "operator" | "tenant-contract-admin"; readonly expiresAtMs: number };

export interface FactoryNotificationListOptions { readonly cursor?: string; readonly limit?: number }
export interface FactoryNotificationPage { readonly items: readonly FactoryVisibleReleaseNotification[]; readonly nextCursor: string | null }

type OperationRow = {
  tenant_id: string; project_id: string; operation_id: string; run_id: string; node_instance_id: string; candidate_generation: number | string; candidate_digest: string;
  decision_id: string; contract_digest: string; execution_epoch: number | string; cancellation_epoch: number | string; release_enable_epoch: number | string;
  action: string; destination_provider: string; destination_account: string; destination_object: string; expected_destination_version: string | null; destination_digest: string;
  canonical_request: string; request_digest: string; material_json: string; material_digest: string; estimated_spend_micros: number | string; deadline_ms: number | string;
  state: FactoryReleaseState; dispatch_generation: number | string; sender_token: string | null; dispatch_started: boolean; authority_kind: "approval" | "policy" | null; authority_id: string | null; policy_revision: number | string | null;
  intent_archive_json: string | null; material_archive_json: string | null; receipt_archive_json: string | null; receipt_json: string | null; archive_ready: boolean; outcome_code: string | null;
};

type NotificationRow = { payload: string; state: FactoryNotification["state"]; input_hash: string };
type NotificationProjectionRow = NotificationRow & {
  notification_id: string;
  operation_state: FactoryReleaseState | null;
  dispatch_generation: number | string | null;
  outcome_code: string | null;
  receipt_json: string | null;
  approval_id: string | null;
  context_digest: string | null;
  approval_expires_at_ms: number | string | null;
  approval_status: "pending" | "approved" | "rejected" | "consumed" | "revoked" | null;
  command_approval_id: string | null;
  command_run_id: string | null;
  command_interpreter_id: string | null;
  command_id: string | null;
  command_node_instance_id: string | null;
  command_context_digest: string | null;
  command_context_json: string | null;
  command_choices_json: string | null;
  command_actor_scope: "owner" | "operator" | "tenant-contract-admin" | null;
  command_initiator_kind: "user" | "service" | null;
  command_initiator_id: string | null;
  command_deadline_at_ms: number | string | null;
  command_status: "pending" | "answered" | null;
  command_source_sequence: number | string | null;
  command_source_digest: string | null;
  command_candidate_generation: number | string | null;
  command_attempt: number | string | null;
  command_definition_digest: string | null;
  command_execution_epoch: number | string | null;
  command_cancellation_epoch: number | string | null;
  command_protected_digest: string | null;
  current_source_sequence: number | string | null;
  current_source_digest: string | null;
  lifecycle_status: string | null;
  lifecycle_deadline_ms: number | string | null;
  lifecycle_cancellation_epoch: number | string | null;
  installation_execution_epoch: number | string | null;
};

export class FactoryReleaseError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "FactoryReleaseError"; }
}

function text(...values: readonly string[]): void {
  if (values.some(value => typeof value !== "string" || value.length < 1 || value.length > MAX_TEXT || value.includes("\0"))) throw new FactoryReleaseError("factory_release_invalid");
}

function digest(...values: readonly string[]): void {
  if (values.some(value => !/^sha256:[a-f0-9]{64}$/.test(value))) throw new FactoryReleaseError("factory_release_invalid");
}

function count(value: number, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new FactoryReleaseError("factory_release_invalid");
}

function canonical<Value>(value: Value): Value { return JSON.parse(canonicalJson(value)) as Value; }
function hash(value: unknown): string { return `sha256:${digestObject(value)}`; }
function archiveJson(value: FactoryArchiveObject | undefined): string | null { return value ? canonicalJson(value) : null; }

function validateArchiveReference(reference: FactoryArchiveObject): void {
  text(reference.key); digest(reference.digest); if (reference.versionId !== undefined) text(reference.versionId);
}

function destinationDigest(destination: FactoryReleaseDestination): string { return hash(destination); }

function identityFor(input: FactoryReleaseRequest): object {
  return { projectId: input.projectId, runId: input.runId, nodeInstanceId: input.nodeInstanceId, candidateGeneration: input.candidateGeneration, candidateDigest: input.candidateDigest, action: input.action, destination: input.destination };
}

function validateRequest(input: FactoryReleaseRequest, now: number): void {
  text(input.projectId, input.runId, input.nodeInstanceId, input.decisionId, input.action, input.destination.provider, input.destination.account, input.destination.object);
  if (input.destination.expectedVersion !== undefined) text(input.destination.expectedVersion);
  count(input.candidateGeneration); count(input.estimatedSpendMicros);
  digest(input.candidateDigest);
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= now || encoder.encode(canonicalJson(input.request)).byteLength > MAX_REQUEST_BYTES) throw new FactoryReleaseError("factory_release_invalid");
}

function validateMaterial(material: FactoryReleaseMaterial, decisionId: string): void {
  text(material.decisionId); digest(material.packageTrustDigest, material.validatorTrustDigest);
  if (material.decisionId !== decisionId || !Array.isArray(material.evidence) || material.evidence.length < 1 || material.evidence.length > 1000) throw new FactoryReleaseError("factory_release_material_invalid");
}

function operationFromRow(row: OperationRow): FactoryReleaseOperation {
  const request = JSON.parse(row.canonical_request);
  if (request.provider !== row.destination_provider) throw new FactoryReleaseError("factory_release_corrupt");
  const material = JSON.parse(row.material_json) as FactoryReleaseMaterial;
  const destination: FactoryReleaseDestination = { provider: row.destination_provider, account: row.destination_account, object: row.destination_object, ...(row.expected_destination_version ? { expectedVersion: row.expected_destination_version } : {}) };
  if ((row.authority_kind === null) !== (row.authority_id === null) || row.authority_kind === "policy" && row.policy_revision === null || row.authority_kind !== "policy" && row.policy_revision !== null) throw new FactoryReleaseError("factory_release_corrupt");
  const operation: FactoryReleaseOperation = {
    tenantId: row.tenant_id, projectId: row.project_id, operationId: row.operation_id, runId: row.run_id, nodeInstanceId: row.node_instance_id,
    candidateGeneration: Number(row.candidate_generation), candidateDigest: row.candidate_digest, decisionId: row.decision_id, contractDigest: row.contract_digest,
    executionEpoch: Number(row.execution_epoch), cancellationEpoch: Number(row.cancellation_epoch), releaseEnableEpoch: Number(row.release_enable_epoch), action: row.action,
    destination, request: request.request, destinationDigest: row.destination_digest, requestDigest: row.request_digest, material, materialDigest: row.material_digest,
    estimatedSpendMicros: Number(row.estimated_spend_micros), deadlineMs: Number(row.deadline_ms), state: row.state, dispatchGeneration: Number(row.dispatch_generation), dispatchStarted: row.dispatch_started,
    ...(row.sender_token ? { senderToken: row.sender_token } : {}), archiveReady: row.archive_ready,
    ...(row.intent_archive_json ? { intentArchive: JSON.parse(row.intent_archive_json) } : {}), ...(row.material_archive_json ? { materialArchive: JSON.parse(row.material_archive_json) } : {}),
    ...(row.receipt_archive_json ? { receiptArchive: JSON.parse(row.receipt_archive_json) } : {}), ...(row.receipt_json ? { receipt: JSON.parse(row.receipt_json) } : {}), ...(row.outcome_code ? { outcomeCode: row.outcome_code } : {}),
    ...(row.authority_kind && row.authority_id ? { authority: { kind: row.authority_kind, id: row.authority_id, ...(row.policy_revision === null ? {} : { policyRevision: Number(row.policy_revision) }) } } : {}),
  };
  assertOperation(operation);
  return operation;
}

function assertOperation(operation: FactoryReleaseOperation): void {
  validateRequest(operation, -1);
  text(operation.tenantId, operation.operationId); digest(operation.contractDigest, operation.destinationDigest, operation.requestDigest, operation.materialDigest);
  count(operation.executionEpoch, true); count(operation.cancellationEpoch); count(operation.releaseEnableEpoch, true); count(operation.dispatchGeneration); if (typeof operation.dispatchStarted !== "boolean") throw new FactoryReleaseError("factory_release_corrupt");
  validateMaterial(operation.material, operation.decisionId);
  if (destinationDigest(operation.destination) !== operation.destinationDigest || hash({ destination: operation.destination, request: operation.request }) !== operation.requestDigest || hash(operation.material) !== operation.materialDigest || operation.operationId !== `factory-release:${digestObject(identityFor(operation))}`) throw new FactoryReleaseError("factory_release_corrupt");
  for (const reference of [operation.intentArchive, operation.materialArchive, operation.receiptArchive]) if (reference) validateArchiveReference(reference);
}

function validateReceipt(operation: FactoryReleaseOperation, receipt: FactoryProviderReceipt, generation = operation.dispatchGeneration): void {
  text(receipt.provider, receipt.account, receipt.object, receipt.operationId, receipt.providerReceiptId, receipt.version);
  digest(receipt.requestDigest, receipt.effectDigest);
  count(receipt.dispatchGeneration, true);
  if (receipt.provider !== operation.destination.provider || receipt.account !== operation.destination.account || receipt.object !== operation.destination.object || receipt.operationId !== operation.operationId || receipt.requestDigest !== operation.requestDigest || receipt.dispatchGeneration !== generation) throw new FactoryReleaseError("factory_release_foreign_receipt");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]); }

async function archiveAndVerify(archive: FactoryReleaseArchive, tenantId: string, operationId: string, name: "intent" | "material" | "receipt" | "reconciliation", value: unknown): Promise<FactoryArchiveObject> {
  const bytes = encoder.encode(canonicalJson(value));
  const reference = await archive.writeImmutable(tenantId, operationId, name, bytes);
  validateArchiveReference(reference);
  if (reference.digest !== `sha256:${digestBytes(bytes)}`) throw new FactoryReleaseError("factory_release_archive_corrupt");
  const restored = await archive.read(reference);
  if (!sameBytes(bytes, restored)) throw new FactoryReleaseError("factory_release_archive_unreadable");
  return reference;
}

function notificationScope(tenantId: string, projectId: string): string { return `${tenantId}\0${projectId}`; }

function decodeNotification(row: NotificationRow, tenantId: string, projectId: string): FactoryNotification {
  const notification = JSON.parse(row.payload) as FactoryNotification;
  const subject = notification.kind === "command_approval_requested" ? { approvalId: notification.approvalId } : { operationId: notification.operationId };
  if (notification.tenantId !== tenantId || notification.projectId !== projectId || !["approval_requested", "release_uncertain", "release_settled", "command_approval_requested"].includes(notification.kind) || notification.inputHash !== row.input_hash || durableInputHash({ kind: notification.kind, ...subject, payload: notification.payload }) !== row.input_hash) throw new FactoryReleaseError("factory_notification_corrupt");
  try {
    text(notification.id, notification.deduplicationId, notification.kind === "command_approval_requested" ? notification.approvalId : notification.operationId);
    count(notification.attempts); count(notification.maxAttempts, true); count(notification.availableAt); count(notification.leaseUntil); count(notification.createdAt);
  } catch { throw new FactoryReleaseError("factory_notification_corrupt"); }
  return { ...notification, state: row.state };
}

function deniedGrant(error: unknown): boolean {
  return error instanceof FactoryGrantError && (error.code === "factory_forbidden" || error.code === "factory_human_required");
}

function notificationPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FactoryReleaseError("factory_notification_corrupt");
  return value as Record<string, unknown>;
}

function notificationStore(database: MigrationDb, tenantId: string, projectId: string): DurableDeliveryStore<FactoryNotification> {
  const expectedScope = notificationScope(tenantId, projectId);
  const check = (scope: string | null): void => { if (scope !== expectedScope) throw new FactoryReleaseError("factory_notification_scope"); };
  const decode = (row: NotificationRow): FactoryNotification => decodeNotification(row, tenantId, projectId);
  return {
    async findDuplicate(scope, deduplicationId) { check(scope); const row = rows<NotificationRow>(await database.execute(sql`SELECT payload,state,input_hash FROM factory_notifications WHERE tenant_id=${tenantId} AND project_id=${projectId} AND deduplication_id=${deduplicationId}`))[0]; return row ? decode(row) : null; },
    async insert(record) { return rows(await database.execute(sql`INSERT INTO factory_notifications (tenant_id,project_id,notification_id,deduplication_id,input_hash,state,available_at,lease_until,payload) VALUES (${tenantId},${projectId},${record.id},${record.deduplicationId},${record.inputHash},${record.state},${record.availableAt},${record.leaseUntil},${canonicalJson(record)}) ON CONFLICT (tenant_id,project_id,deduplication_id) DO NOTHING RETURNING notification_id`)).length === 1; },
    async claimCandidate(scope, now) { check(scope); const row = rows<NotificationRow>(await database.execute(sql`SELECT payload,state,input_hash FROM factory_notifications WHERE tenant_id=${tenantId} AND project_id=${projectId} AND ((state='queued' AND available_at<=${now}) OR (state='leased' AND lease_until<=${now})) ORDER BY available_at,notification_id LIMIT 1 FOR UPDATE SKIP LOCKED`))[0]; return row ? decode(row) : null; },
    async findById(scope, id) { check(scope); const row = rows<NotificationRow>(await database.execute(sql`SELECT payload,state,input_hash FROM factory_notifications WHERE tenant_id=${tenantId} AND project_id=${projectId} AND notification_id=${id} FOR UPDATE`))[0]; return row ? decode(row) : null; },
    async write(record) { await database.execute(sql`UPDATE factory_notifications SET state=${record.state},available_at=${record.availableAt},lease_until=${record.leaseUntil},payload=${canonicalJson(record)},updated_at=NOW() WHERE tenant_id=${tenantId} AND project_id=${projectId} AND notification_id=${record.id}`); },
    async inspect(scope, id) { check(scope); const row = rows<NotificationRow>(await database.execute(sql`SELECT payload,state,input_hash FROM factory_notifications WHERE tenant_id=${tenantId} AND project_id=${projectId} AND notification_id=${id}`))[0]; return row ? decode(row) : null; },
  };
}

const notificationQueue = new DurableDeliveryQueue<FactoryNotification>((code, message) => new FactoryReleaseError(code, message), randomUUID);

async function boundedReconciliationProof(timeoutMs: number, prove: (signal: AbortSignal) => Promise<readonly [boolean, boolean]>): Promise<readonly [boolean, boolean]> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new FactoryReleaseError("factory_release_reconciliation_timeout")); }, timeoutMs); });
  try { return await Promise.race([prove(controller.signal), expired]); }
  finally { if (timeout) clearTimeout(timeout); controller.abort(); }
}

/** C04 release operation store. All authority-bearing collaborators are mandatory and transaction-bound. */
export class FactoryReleases {
  private readonly mutations: FactoryMutations;
  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly grants: FactoryGrants,
    private readonly assurance: FactoryAssurance,
    private readonly materials: FactoryReleaseMaterialReader,
    private readonly authority: FactoryReleaseAuthorityReader,
    private readonly destinations: FactoryDestinationReservationReader,
    private readonly archive: FactoryReleaseArchive,
    private readonly senderFence: FactorySenderFence,
    private readonly now: () => number = Date.now,
    private readonly reconciliationProofTimeoutMs = 10_000,
  ) {
    assertFactoryIdentity(tenantId);
    if (grants.tenantId !== tenantId || assurance.tenantId !== tenantId) throw new FactoryReleaseError("factory_release_scope");
    count(reconciliationProofTimeoutMs, true);
    this.mutations = new FactoryMutations(database, tenantId, grants);
  }

  async prepare(requester: FactoryPrincipal, input: FactoryReleaseRequest, idempotencyKey: string): Promise<FactoryReleaseOperation> {
    [requester, input] = canonical([requester, input]);
    validateRequest(input, this.now());
    const locator = await this.mutations.execute({ principal: requester, projectId: input.projectId, action: "factory.release", idempotencyKey, input: { kind: "release.prepare", request: input } }, async transaction => {
      const current = await this.authority.lockCurrentInTransaction(transaction, this.tenantId, input.projectId, input.runId, input.nodeInstanceId);
      const accepted = await this.assurance.assertAcceptedReleaseInTransaction(transaction, input);
      this.assertCurrent(input, current, accepted);
      const material = canonical(await this.materials.readPinnedInTransaction(transaction, this.tenantId, accepted));
      validateMaterial(material, input.decisionId);
      if (material.packageTrustDigest !== current.packageTrustDigest || material.validatorTrustDigest !== current.validatorTrustDigest) throw new FactoryReleaseError("factory_release_trust_changed");
      const destination = canonical(input.destination);
      const canonicalRequest = canonicalJson({ provider: destination.provider, request: input.request });
      const operationId = `factory-release:${digestObject(identityFor(input))}`;
      const destinationHash = destinationDigest(destination);
      const requestHash = hash({ destination, request: input.request });
      const materialHash = hash(material);
      await transaction.execute(sql`INSERT INTO factory_release_operations (tenant_id,project_id,operation_id,run_id,node_instance_id,candidate_generation,candidate_digest,decision_id,contract_digest,execution_epoch,cancellation_epoch,release_enable_epoch,action,destination_provider,destination_account,destination_object,expected_destination_version,destination_digest,canonical_request,request_digest,material_json,material_digest,estimated_spend_micros,deadline_ms,state) VALUES (${this.tenantId},${input.projectId},${operationId},${input.runId},${input.nodeInstanceId},${input.candidateGeneration},${input.candidateDigest},${input.decisionId},${accepted.contractDigest},${accepted.executionEpoch},${accepted.cancellationEpoch},${current.releaseEnableEpoch},${input.action},${destination.provider},${destination.account},${destination.object},${destination.expectedVersion ?? null},${destinationHash},${canonicalRequest},${requestHash},${canonicalJson(material)},${materialHash},${input.estimatedSpendMicros},${input.deadlineMs},'pending') ON CONFLICT (tenant_id,project_id,run_id,node_instance_id,candidate_generation,action,destination_provider,destination_account,destination_object) DO NOTHING`);
      const saved = await this.readInTransaction(transaction, input.projectId, operationId, "share");
      if (!saved || saved.requestDigest !== requestHash || saved.materialDigest !== materialHash || saved.destinationDigest !== destinationHash || saved.deadlineMs !== input.deadlineMs) throw new FactoryReleaseError("factory_release_conflict");
      await insertTransactionalAuditEntry(transaction, `factory-release-prepared:${operationId}`, requester.kind === "user" ? requester.id : null, "factory.release.prepared", operationId, { tenantId: this.tenantId, projectId: input.projectId, operationId, principalKind: requester.kind, principalId: requester.id, requestDigest: requestHash, destinationDigest: destinationHash });
      return { projectId: saved.projectId, operationId: saved.operationId };
    });
    const operation = await this.inspect(locator.projectId, locator.operationId);
    if (!operation) throw new FactoryReleaseError("factory_release_corrupt");
    if (operation.archiveReady) return operation;
    const intent = { operationId: operation.operationId, tenantId: this.tenantId, projectId: operation.projectId, runId: operation.runId, nodeInstanceId: operation.nodeInstanceId, candidateGeneration: operation.candidateGeneration, candidateDigest: operation.candidateDigest, decisionId: operation.decisionId, contractDigest: operation.contractDigest, executionEpoch: operation.executionEpoch, cancellationEpoch: operation.cancellationEpoch, releaseEnableEpoch: operation.releaseEnableEpoch, action: operation.action, destination: operation.destination, request: operation.request, requestDigest: operation.requestDigest, materialDigest: operation.materialDigest, deadlineMs: operation.deadlineMs };
    const intentArchive = await archiveAndVerify(this.archive, this.tenantId, operation.operationId, "intent", intent);
    const materialArchive = await archiveAndVerify(this.archive, this.tenantId, operation.operationId, "material", operation.material);
    return this.database.transaction(async transaction => {
      const updated = rows(await transaction.execute(sql`UPDATE factory_release_operations SET intent_archive_json=${archiveJson(intentArchive)},material_archive_json=${archiveJson(materialArchive)},archive_ready=TRUE,updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${operation.projectId} AND operation_id=${operation.operationId} AND state='pending' AND request_digest=${operation.requestDigest} AND material_digest=${operation.materialDigest} RETURNING operation_id`));
      if (!updated.length) throw new FactoryReleaseError("factory_release_stale");
      await insertTransactionalAuditEntry(transaction, `factory-release-archived:${operation.operationId}`, requester.kind === "user" ? requester.id : null, "factory.release.archived", operation.operationId, { tenantId: this.tenantId, projectId: operation.projectId, intentArchive, materialArchive });
      return (await this.readInTransaction(transaction, operation.projectId, operation.operationId, "share"))!;
    });
  }

  async createPolicy(actor: FactoryPrincipal, policy: FactoryAutomaticReleasePolicy, idempotencyKey: string): Promise<void> {
    [actor, policy] = canonical([actor, policy]);
    text(policy.projectId, policy.policyId, policy.principal.id, policy.action, policy.destinationProvider, policy.destinationAccount, policy.destinationPrefix); digest(policy.contractDigest);
    count(policy.revision, true); count(policy.maxOperations, true); count(policy.maxSpendMicros);
    if (actor.kind !== "user" || actor.authentication !== "session" || policy.revision !== 1 || policy.expiresAtMs <= this.now() || policy.expiresAtMs - this.now() > THIRTY_DAYS_MS) throw new FactoryReleaseError("factory_release_policy_invalid");
    await this.mutations.execute({ principal: actor, projectId: policy.projectId, action: "factory.approve", idempotencyKey, input: { kind: "release.policy.create", policy } }, async transaction => {
      const inserted = rows(await transaction.execute(sql`INSERT INTO factory_release_policies (tenant_id,project_id,policy_id,principal_kind,principal_id,action,destination_provider,destination_account,destination_prefix,contract_digest,revision,max_operations,max_spend_micros,expires_at_ms,created_by) VALUES (${this.tenantId},${policy.projectId},${policy.policyId},${policy.principal.kind},${policy.principal.id},${policy.action},${policy.destinationProvider},${policy.destinationAccount},${policy.destinationPrefix},${policy.contractDigest},${policy.revision},${policy.maxOperations},${policy.maxSpendMicros},${policy.expiresAtMs},${actor.id}) ON CONFLICT DO NOTHING RETURNING policy_id`));
      if (!inserted.length) throw new FactoryReleaseError("factory_release_policy_conflict");
      await insertTransactionalAuditEntry(transaction, `factory-release-policy-created:${policy.policyId}:${policy.revision}`, actor.id, "factory.release.policy.created", policy.policyId, { tenantId: this.tenantId, projectId: policy.projectId, policy });
      return { policyId: policy.policyId, revision: policy.revision };
    });
  }

  async revokePolicy(actor: FactoryPrincipal, projectId: string, policyId: string, expectedRevision: number, idempotencyKey: string): Promise<void> {
    [actor, projectId, policyId] = canonical([actor, projectId, policyId]); text(projectId, policyId); count(expectedRevision, true);
    if (actor.kind !== "user" || actor.authentication !== "session") throw new FactoryReleaseError("factory_release_policy_invalid");
    await this.mutations.execute({ principal: actor, projectId, action: "factory.approve", idempotencyKey, input: { kind: "release.policy.revoke", policyId, expectedRevision } }, async transaction => {
      const changed = rows(await transaction.execute(sql`UPDATE factory_release_policies SET revoked_at_ms=${this.now()},revision=revision+1 WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND policy_id=${policyId} AND revision=${expectedRevision} AND revoked_at_ms IS NULL RETURNING policy_id`));
      if (!changed.length) throw new FactoryReleaseError("factory_release_policy_stale");
      await insertTransactionalAuditEntry(transaction, `factory-release-policy-revoked:${policyId}:${expectedRevision}`, actor.id, "factory.release.policy.revoked", policyId, { tenantId: this.tenantId, projectId, policyId, expectedRevision });
      return { policyId, revision: expectedRevision + 1 };
    });
  }

  async requestApproval(actor: FactoryPrincipal, projectId: string, operationId: string, expiresAtMs: number, expectedGeneration: number, idempotencyKey: string): Promise<{ approvalId: string; contextDigest: string }> {
    [actor, projectId, operationId] = canonical([actor, projectId, operationId]); text(projectId, operationId);
    count(expectedGeneration); return this.mutations.execute({ principal: actor, projectId, action: "factory.approve", idempotencyKey, input: { kind: "release.approval.request", operationId, expiresAtMs, expectedGeneration } }, async transaction => {
      const operation = await this.readInTransaction(transaction, projectId, operationId, "update");
      if (operation?.state !== "pending" || operation.dispatchGeneration !== expectedGeneration || !operation.archiveReady || expiresAtMs > operation.deadlineMs) throw new FactoryReleaseError("factory_release_not_claimable");
      const approval = await this.assurance.requestApprovalInTransaction(transaction, actor, { projectId, operationId, decisionId: operation.decisionId, destinationDigest: operation.destinationDigest, expectedGeneration: operation.dispatchGeneration + 1, expiresAtMs });
      await this.enqueueNotificationInTransaction(transaction, projectId, "approval_requested", operationId, { approvalId: approval.approvalId, expiresAtMs });
      return approval;
    });
  }

  async claim(requester: FactoryPrincipal, projectId: string, operationId: string, consent: FactoryReleaseConsent): Promise<FactoryReleaseClaim> {
    [requester, projectId, operationId, consent] = canonical([requester, projectId, operationId, consent]); text(projectId, operationId, requester.id, consent.kind === "approval" ? consent.approvalId : consent.policyId);
    return this.database.transaction(async transaction => {
      const observed = await this.readInTransaction(transaction, projectId, operationId, "none");
      if (!observed) throw new FactoryReleaseError("factory_release_not_claimable");
      const current = await this.authority.lockCurrentInTransaction(transaction, this.tenantId, projectId, observed.runId, observed.nodeInstanceId);
      const operation = await this.readInTransaction(transaction, projectId, operationId, "update");
      if (operation?.state !== "pending" || !operation.archiveReady || !operation.intentArchive || !operation.materialArchive || operation.deadlineMs <= this.now()) throw new FactoryReleaseError("factory_release_not_claimable");
      if (operation.runId !== observed.runId || operation.requestDigest !== observed.requestDigest || operation.materialDigest !== observed.materialDigest) throw new FactoryReleaseError("factory_release_stale");
      const accepted = await this.assurance.assertAcceptedReleaseInTransaction(transaction, operation);
      this.assertCurrent(operation, current, accepted);
      await this.grants.authorizeInTransaction(transaction, requester, projectId, "factory.release");
      const destination = await this.destinations.reserveInTransaction(transaction, this.tenantId, operation);
      if ((operation.destination.expectedVersion ?? null) !== destination.currentVersion) throw new FactoryReleaseError("factory_release_destination_changed");
      const generation = operation.dispatchGeneration + 1;
      let policyRevision: number | undefined;
      if (consent.kind === "approval") {
        await this.assurance.consumeApprovalInTransaction(transaction, { projectId, operationId, decisionId: operation.decisionId, destinationDigest: operation.destinationDigest, expectedGeneration: generation, expiresAtMs: operation.deadlineMs, approvalId: consent.approvalId, requester, runId: operation.runId });
      } else {
        policyRevision = await this.consumePolicy(transaction, requester, operation, consent.policyId, consent.expectedRevision);
      }
      const senderToken = randomUUID();
      const reserved = rows(await transaction.execute(sql`INSERT INTO factory_release_destination_reservations (tenant_id,project_id,destination_provider,destination_account,destination_object,operation_id,expected_version,dispatch_generation,state) VALUES (${this.tenantId},${projectId},${operation.destination.provider},${operation.destination.account},${operation.destination.object},${operationId},${operation.destination.expectedVersion ?? null},${generation},'held') ON CONFLICT (tenant_id,destination_provider,destination_account,destination_object) DO UPDATE SET project_id=EXCLUDED.project_id,operation_id=EXCLUDED.operation_id,expected_version=EXCLUDED.expected_version,dispatch_generation=EXCLUDED.dispatch_generation,state='held',updated_at=NOW() WHERE factory_release_destination_reservations.state='released' OR factory_release_destination_reservations.operation_id=EXCLUDED.operation_id RETURNING operation_id`));
      if (!reserved.length) throw new FactoryReleaseError("factory_release_destination_reserved");
      const changed = rows(await transaction.execute(sql`UPDATE factory_release_operations SET state='executing',dispatch_generation=${generation},sender_token=${senderToken},authority_kind=${consent.kind},authority_id=${consent.kind === "approval" ? consent.approvalId : consent.policyId},policy_revision=${policyRevision ?? null},updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND operation_id=${operationId} AND state='pending' AND dispatch_generation=${operation.dispatchGeneration} RETURNING operation_id`));
      if (!changed.length) throw new FactoryReleaseError("factory_release_claim_lost");
      await insertTransactionalAuditEntry(transaction, `factory-release-claimed:${operationId}:${generation}`, requester.kind === "user" ? requester.id : null, "factory.release.claimed", operationId, { tenantId: this.tenantId, projectId, operationId, generation, authorityKind: consent.kind, authorityId: consent.kind === "approval" ? consent.approvalId : consent.policyId, principalKind: requester.kind, principalId: requester.id });
      return { ...(await this.readInTransaction(transaction, projectId, operationId, "share"))!, state: "executing", senderToken, authority: { kind: consent.kind, id: consent.kind === "approval" ? consent.approvalId : consent.policyId, ...(policyRevision === undefined ? {} : { policyRevision }) } };
    });
  }

  async dispatch(claim: FactoryReleaseClaim, provider: FactoryReleaseProvider): Promise<FactoryReleaseOperation> {
    claim = canonical(claim); assertOperation(claim);
    const current = await this.inspect(claim.projectId, claim.operationId);
    if (current?.state !== "executing" || current.dispatchStarted || current.dispatchGeneration !== claim.dispatchGeneration || current.senderToken !== claim.senderToken || !current.authority) throw new FactoryReleaseError("factory_release_sender_fenced");
    const sealedClaim: FactoryReleaseClaim = { ...current, state: "executing", senderToken: current.senderToken, authority: current.authority };
    if (canonicalJson(claim) !== canonicalJson(sealedClaim)) throw new FactoryReleaseError("factory_release_sender_fenced");
    const startedClaim = await this.beginDispatch(sealedClaim);
    let receipt: FactoryProviderReceipt;
    try { receipt = canonical(await provider.publish(startedClaim)); }
    catch { return this.markUncertain(startedClaim, "provider_response_unknown"); }
    try {
      validateReceipt(startedClaim, receipt);
      const receiptArchive = await archiveAndVerify(this.archive, this.tenantId, startedClaim.operationId, "receipt", receipt);
      return await this.settleReceipt(startedClaim, receipt, receiptArchive, "dispatch");
    } catch { return this.markUncertain(startedClaim, "receipt_archive_unknown"); }
  }

  async reconcile(operator: FactoryPrincipal, request: FactoryReconciliationRequest, expectedGeneration: number, provider: FactoryReleaseProvider, idempotencyKey: string): Promise<FactoryReleaseOperation> {
    [operator, request] = canonical([operator, request]);
    text(request.projectId, request.operationId, request.reason); count(expectedGeneration, true); if (encoder.encode(request.reason).byteLength > MAX_REASON_BYTES || encoder.encode(canonicalJson(request.providerEvidence)).byteLength > MAX_REQUEST_BYTES || !request.providerEvidence || typeof request.providerEvidence !== "object" || Array.isArray(request.providerEvidence) || !Object.keys(request.providerEvidence).length || operator.kind !== "user" || operator.authentication !== "session") throw new FactoryReleaseError("factory_release_reconciliation_invalid");
    return this.mutations.execute({ principal: operator, projectId: request.projectId, action: "factory.operate", idempotencyKey, input: { kind: "release.reconcile", request, expectedGeneration } }, async transaction => {
      const locked = await this.readInTransaction(transaction, request.projectId, request.operationId, "update");
      if (!locked?.senderToken || locked.dispatchGeneration !== expectedGeneration || locked.state !== "uncertain" && !(locked.state === "executing" && locked.dispatchStarted)) throw new FactoryReleaseError("factory_release_reconciliation_stale");
      if (request.action === "attach_receipt") {
        if (!request.receipt) throw new FactoryReleaseError("factory_release_reconciliation_invalid");
        validateReceipt(locked, request.receipt);
      } else if (request.receipt) throw new FactoryReleaseError("factory_release_reconciliation_invalid");
      if (request.action === "confirm_no_effect") {
        const [stopped, absent] = await boundedReconciliationProof(this.reconciliationProofTimeoutMs, signal => Promise.all([this.senderFence.proveStopped(locked, locked.senderToken!, request.providerEvidence, signal), provider.proveNoEffect(locked, request.providerEvidence, signal)]));
        if (!stopped || !absent) throw new FactoryReleaseError("factory_release_absence_unproved");
      }
      const evidence = { action: request.action, reason: request.reason, providerEvidence: request.providerEvidence, ...(request.receipt ? { receipt: request.receipt } : {}) };
      const evidenceArchive = await archiveAndVerify(this.archive, this.tenantId, locked.operationId, "reconciliation", evidence);
      await this.recordReconciliation(transaction, operator, locked, request, evidenceArchive, true);
      if (request.action === "attach_receipt") {
        const receiptArchive = await archiveAndVerify(this.archive, this.tenantId, locked.operationId, "receipt", request.receipt!);
        return this.settleReceiptInTransaction(transaction, locked, request.receipt!, receiptArchive, "reconciliation");
      }
      if (request.action === "confirm_no_effect") {
        await transaction.execute(sql`UPDATE factory_release_operations SET state='pending',sender_token=NULL,dispatch_started=FALSE,outcome_code='confirmed_no_effect',updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${locked.projectId} AND operation_id=${locked.operationId}`);
        await transaction.execute(sql`UPDATE factory_release_destination_reservations SET state='released',updated_at=NOW() WHERE tenant_id=${this.tenantId} AND operation_id=${locked.operationId}`);
      } else if (locked.state === "executing") {
        await transaction.execute(sql`UPDATE factory_release_operations SET state='uncertain',outcome_code='operator_kept_uncertain',updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${locked.projectId} AND operation_id=${locked.operationId}`);
      }
      return (await this.readInTransaction(transaction, locked.projectId, locked.operationId, "share"))!;
    });
  }

  async claimNotification(projectId: string, leaseMs = 60_000): Promise<FactoryNotification | null> { text(projectId); return this.database.transaction(transaction => notificationQueue.claim(notificationStore(transaction, this.tenantId, projectId), notificationScope(this.tenantId, projectId), this.now(), leaseMs)); }
  async settleNotification(projectId: string, notification: FactoryNotification, outcome: "delivered" | "retry" | "outcome_unknown", code?: string): Promise<FactoryNotification> { text(projectId); return this.database.transaction(transaction => notificationQueue.settle(notificationStore(transaction, this.tenantId, projectId), notificationScope(this.tenantId, projectId), notification, this.now(), outcome, code)); }
  async inspectNotification(projectId: string, notificationId: string): Promise<FactoryNotification | null> { text(projectId, notificationId); return notificationQueue.inspect(notificationStore(this.database, this.tenantId, projectId), notificationScope(this.tenantId, projectId), notificationId); }
  async dispatchNotification(projectId: string, handler: (notification: FactoryNotification) => Promise<void>): Promise<FactoryNotification | null> { return dispatchDurableDelivery(() => this.claimNotification(projectId), (notification, outcome, code) => this.settleNotification(projectId, notification, outcome, code), handler, () => null); }

  /** Generic approval requests share the same durable in-app notification queue. */
  async enqueueCommandApprovalInTransaction(transaction: MigrationDb, projectId: string, approvalId: string): Promise<FactoryNotification> {
    text(projectId, approvalId);
    const kind = "command_approval_requested" as const;
    const payload = { approvalId };
    const deduplicationId = `${kind}:${approvalId}`;
    const inputHash = durableInputHash({ kind, approvalId, payload });
    return notificationQueue.enqueue(notificationStore(transaction, this.tenantId, projectId), { scope: notificationScope(this.tenantId, projectId), deduplicationId, inputHash, hashExisting: record => record.inputHash, create: () => ({ id: randomUUID(), tenantId: this.tenantId, projectId, deduplicationId, inputHash, kind, approvalId, payload, state: "queued", attempts: 0, maxAttempts: 5, availableAt: this.now(), leaseUntil: 0, createdAt: this.now() }) });
  }

  /** The transaction itself is the local inbox delivery boundary; no external acknowledgement is involved. */
  async deliverNextNotification(projectId: string): Promise<FactoryNotification | null> {
    text(projectId);
    return this.database.transaction(async transaction => {
      const store = notificationStore(transaction, this.tenantId, projectId);
      const deliveredAt = this.now();
      const claimed = await notificationQueue.claim(store, notificationScope(this.tenantId, projectId), deliveredAt, 60_000);
      return claimed ? notificationQueue.settle(store, notificationScope(this.tenantId, projectId), claimed, deliveredAt, "delivered") : null;
    });
  }

  /** Current category authorization and the bounded inbox projection share one product transaction. */
  async listDeliveredNotifications(actor: FactoryPrincipal, projectId: string, options: FactoryNotificationListOptions = {}): Promise<FactoryNotificationPage> {
    [actor, projectId, options] = canonical([actor, projectId, options]);
    text(projectId); if (options.cursor !== undefined) text(options.cursor);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new FactoryReleaseError("factory_page_invalid");
    if (actor.kind !== "user" || actor.authentication !== "session") return { items: [], nextCursor: null };
    return this.database.transaction(async transaction => {
      const readAt = this.now();
      const permitted = new Set<FactoryAction>();
      for (const action of ["factory.approve", "factory.operate", "factory.release", "factory.trust"] as const) {
        try { await this.grants.authorizeInTransaction(transaction, actor, projectId, action); permitted.add(action); }
        catch (error) { if (!deniedGrant(error)) throw error; }
      }
      if (!permitted.size) return { items: [], nextCursor: null };
      const cursor = options.cursor ?? "";
      const found = rows<NotificationProjectionRow>(await transaction.execute(sql`
        SELECT n.notification_id,n.payload,n.state,n.input_hash,
          o.state AS operation_state,o.dispatch_generation,o.outcome_code,o.receipt_json,
          a.approval_id,a.context_digest,a.expires_at_ms AS approval_expires_at_ms,a.status AS approval_status,
          ca.approval_id AS command_approval_id,ca.run_id AS command_run_id,ca.interpreter_id AS command_interpreter_id,ca.command_id,ca.node_instance_id AS command_node_instance_id,
          ca.context_digest AS command_context_digest,ca.context_json AS command_context_json,ca.choices_json AS command_choices_json,
          ca.actor_scope AS command_actor_scope,ca.initiator_kind AS command_initiator_kind,ca.initiator_id AS command_initiator_id,
          ca.deadline_at_ms AS command_deadline_at_ms,ca.status AS command_status,ca.source_sequence AS command_source_sequence,ca.source_digest AS command_source_digest,
          ca.candidate_generation AS command_candidate_generation,ca.attempt AS command_attempt,ca.definition_digest AS command_definition_digest,
          ca.execution_epoch AS command_execution_epoch,ca.cancellation_epoch AS command_cancellation_epoch,ca.protected_digest AS command_protected_digest,
          (SELECT h.source_sequence FROM factory_audit_batches h WHERE h.tenant_id=ca.tenant_id AND h.project_id=ca.project_id AND h.run_id=ca.run_id AND h.interpreter_id=ca.interpreter_id ORDER BY h.source_sequence DESC LIMIT 1) AS current_source_sequence,
          (SELECT h.digest FROM factory_audit_batches h WHERE h.tenant_id=ca.tenant_id AND h.project_id=ca.project_id AND h.run_id=ca.run_id AND h.interpreter_id=ca.interpreter_id ORDER BY h.source_sequence DESC LIMIT 1) AS current_source_digest,
          l.status AS lifecycle_status,l.deadline_ms AS lifecycle_deadline_ms,l.cancellation_epoch AS lifecycle_cancellation_epoch,
          i.execution_epoch AS installation_execution_epoch
        FROM factory_notifications n
        LEFT JOIN factory_release_operations o
          ON o.tenant_id=n.tenant_id AND o.project_id=n.project_id AND o.operation_id=n.payload::jsonb->>'operationId'
        LEFT JOIN factory_release_approvals a
          ON a.tenant_id=n.tenant_id AND a.project_id=n.project_id AND a.operation_id=o.operation_id
          AND a.approval_id=n.payload::jsonb#>>'{payload,approvalId}'
        LEFT JOIN factory_command_approvals ca
          ON ca.tenant_id=n.tenant_id AND ca.project_id=n.project_id AND ca.approval_id=n.payload::jsonb->>'approvalId'
        LEFT JOIN factory_run_lifecycle l
          ON l.tenant_id=ca.tenant_id AND l.project_id=ca.project_id AND l.run_id=ca.run_id
        LEFT JOIN factory_installation i ON i.tenant_id=n.tenant_id
        WHERE n.tenant_id=${this.tenantId} AND n.project_id=${projectId} AND n.state='delivered' AND n.notification_id>${cursor}
        ORDER BY n.notification_id LIMIT ${limit + 1}`));
      const selected = found.slice(0, limit);
      const items: FactoryVisibleReleaseNotification[] = [];
      for (const row of selected) {
        const notification = decodeNotification(row, this.tenantId, projectId);
        if (notification.id !== row.notification_id) throw new FactoryReleaseError("factory_notification_corrupt");
        const payload = notificationPayload(notification.payload);
        if (notification.kind === "command_approval_requested") {
          if (notification.approvalId !== row.command_approval_id || payload.approvalId !== row.command_approval_id || row.command_status !== "pending" || Number(row.command_deadline_at_ms) <= readAt || Number(row.command_source_sequence) !== Number(row.current_source_sequence) || row.command_source_digest !== row.current_source_digest || Number(row.command_execution_epoch) !== Number(row.installation_execution_epoch) || Number(row.command_cancellation_epoch) !== Number(row.lifecycle_cancellation_epoch) || !["queued", "running", "waiting"].includes(row.lifecycle_status ?? "") || Number(row.lifecycle_deadline_ms) <= readAt) continue;
          const allowed = row.command_actor_scope === "operator" ? permitted.has("factory.approve") : row.command_actor_scope === "owner" ? permitted.has("factory.approve") && row.command_initiator_kind === "user" && row.command_initiator_id === actor.id : row.command_actor_scope === "tenant-contract-admin" ? permitted.has("factory.approve") && permitted.has("factory.trust") : false;
          if (!allowed) continue;
          let context: JsonValue, choices: unknown;
          try { context = JSON.parse(row.command_context_json ?? ""); choices = JSON.parse(row.command_choices_json ?? ""); } catch { throw new FactoryReleaseError("factory_notification_corrupt"); }
          if (!Array.isArray(choices) || choices.length < 1 || choices.some(value => typeof value !== "string") || !row.command_run_id || !row.command_interpreter_id || !row.command_id || !row.command_node_instance_id || !row.command_context_digest || !row.command_source_digest || !row.command_definition_digest || !row.command_initiator_kind || !row.command_initiator_id || !row.command_actor_scope || !row.command_protected_digest || !/^[a-f0-9]{64}$/.test(row.command_context_digest)) throw new FactoryReleaseError("factory_notification_corrupt");
          const sealed = protectFactoryCommandApproval({ tenantId: this.tenantId, projectId, runId: row.command_run_id, interpreterId: row.command_interpreter_id, commandId: row.command_id, sourceSequence: Number(row.command_source_sequence), sourceDigest: row.command_source_digest, nodeInstanceId: row.command_node_instance_id, candidateGeneration: Number(row.command_candidate_generation), attempt: Number(row.command_attempt), initiator: { kind: row.command_initiator_kind, id: row.command_initiator_id }, actorScope: row.command_actor_scope, choices, context, deadlineAtMs: Number(row.command_deadline_at_ms), definitionDigest: row.command_definition_digest, executionEpoch: Number(row.command_execution_epoch), cancellationEpoch: Number(row.command_cancellation_epoch) });
          if (sealed.contextDigest !== row.command_context_digest || sealed.protectedDigest !== row.command_protected_digest) throw new FactoryReleaseError("factory_notification_corrupt");
          items.push({ notificationId: notification.id, createdAtMs: notification.createdAt, kind: notification.kind, approvalId: row.command_approval_id, runId: row.command_run_id, commandId: row.command_id, nodeInstanceId: row.command_node_instance_id, contextDigest: row.command_context_digest, context, choices, actorScope: row.command_actor_scope!, expiresAtMs: Number(row.command_deadline_at_ms) });
          continue;
        }
        if (row.operation_state === null) throw new FactoryReleaseError("factory_notification_corrupt");
        if (notification.kind === "approval_requested") {
          if (!permitted.has("factory.approve") || row.operation_state !== "pending" || row.approval_status !== "pending" || Number(row.approval_expires_at_ms) <= readAt) continue;
          if (typeof payload.approvalId !== "string" || payload.approvalId !== row.approval_id || payload.expiresAtMs !== Number(row.approval_expires_at_ms) || !row.context_digest || !/^[a-f0-9]{64}$/.test(row.context_digest)) throw new FactoryReleaseError("factory_notification_corrupt");
          items.push({ notificationId: notification.id, operationId: notification.operationId, createdAtMs: notification.createdAt, kind: notification.kind, approvalId: row.approval_id, contextDigest: row.context_digest, expiresAtMs: Number(row.approval_expires_at_ms) });
          continue;
        }
        const generation = Number(row.dispatch_generation);
        if (!Number.isSafeInteger(generation) || generation < 1 || payload.dispatchGeneration !== generation || typeof row.outcome_code !== "string") {
          if (notification.kind === "release_uncertain" && row.operation_state !== "uncertain" || notification.kind === "release_settled" && row.operation_state !== "succeeded") continue;
          throw new FactoryReleaseError("factory_notification_corrupt");
        }
        if (notification.kind === "release_uncertain") {
          if (!permitted.has("factory.operate") || row.operation_state !== "uncertain") continue;
          if (payload.code !== row.outcome_code) throw new FactoryReleaseError("factory_notification_corrupt");
          items.push({ notificationId: notification.id, operationId: notification.operationId, createdAtMs: notification.createdAt, kind: notification.kind, dispatchGeneration: generation, outcomeCode: row.outcome_code });
          continue;
        }
        if (!permitted.has("factory.release") || row.operation_state !== "succeeded") continue;
        let receipt: { providerReceiptId?: unknown };
        try { receipt = JSON.parse(row.receipt_json ?? "null") as { providerReceiptId?: unknown }; } catch { throw new FactoryReleaseError("factory_notification_corrupt"); }
        if (!receipt || typeof receipt.providerReceiptId !== "string" || payload.providerReceiptId !== receipt.providerReceiptId) throw new FactoryReleaseError("factory_notification_corrupt");
        items.push({ notificationId: notification.id, operationId: notification.operationId, createdAtMs: notification.createdAt, kind: notification.kind, dispatchGeneration: generation, outcomeCode: row.outcome_code });
      }
      return { items, nextCursor: found.length > limit ? selected[selected.length - 1]!.notification_id : null };
    });
  }

  async inspect(projectId: string, operationId: string): Promise<FactoryReleaseOperation | null> { text(projectId, operationId); return this.readInTransaction(this.database, projectId, operationId, "none"); }

  private assertCurrent(input: Pick<FactoryReleaseRequest, "runId" | "nodeInstanceId" | "candidateGeneration" | "candidateDigest" | "deadlineMs"> & Partial<Pick<FactoryReleaseOperation, "executionEpoch" | "cancellationEpoch" | "releaseEnableEpoch">>, current: FactoryReleaseAuthority, accepted: FactoryAcceptedRelease): void {
    if (current.runId !== input.runId || current.nodeInstanceId !== input.nodeInstanceId || current.candidateGeneration !== input.candidateGeneration || current.candidateDigest !== input.candidateDigest || !["queued", "running", "waiting"].includes(current.status) || current.deadlineMs < input.deadlineMs || current.deadlineMs <= this.now() || accepted.runId !== input.runId || accepted.nodeInstanceId !== input.nodeInstanceId || accepted.candidateGeneration !== input.candidateGeneration || accepted.candidateDigest !== input.candidateDigest || input.executionEpoch !== undefined && (current.executionEpoch !== input.executionEpoch || accepted.executionEpoch !== input.executionEpoch) || input.cancellationEpoch !== undefined && (current.cancellationEpoch !== input.cancellationEpoch || accepted.cancellationEpoch !== input.cancellationEpoch) || input.releaseEnableEpoch !== undefined && current.releaseEnableEpoch !== input.releaseEnableEpoch) throw new FactoryReleaseError("factory_release_authority_stale");
  }

  private async consumePolicy(transaction: MigrationDb, requester: FactoryPrincipal, operation: FactoryReleaseOperation, policyId: string, expectedRevision: number): Promise<number> {
    count(expectedRevision, true);
    const policy = rows<{ principal_kind: string; principal_id: string; action: string; destination_provider: string; destination_account: string; destination_prefix: string; contract_digest: string; revision: number | string; max_operations: number | string; used_operations: number | string; max_spend_micros: number | string; used_spend_micros: number | string; expires_at_ms: number | string; revoked_at_ms: number | string | null }>(await transaction.execute(sql`SELECT principal_kind,principal_id,action,destination_provider,destination_account,destination_prefix,contract_digest,revision,max_operations,used_operations,max_spend_micros,used_spend_micros,expires_at_ms,revoked_at_ms FROM factory_release_policies WHERE tenant_id=${this.tenantId} AND project_id=${operation.projectId} AND policy_id=${policyId} FOR UPDATE`))[0];
    if (!policy || policy.principal_kind !== requester.kind || policy.principal_id !== requester.id || policy.action !== operation.action || policy.destination_provider !== operation.destination.provider || policy.destination_account !== operation.destination.account || !operation.destination.object.startsWith(policy.destination_prefix) || policy.contract_digest !== operation.contractDigest || Number(policy.revision) !== expectedRevision || policy.revoked_at_ms !== null || Number(policy.expires_at_ms) <= this.now() || Number(policy.used_operations) >= Number(policy.max_operations) || Number(policy.used_spend_micros) + operation.estimatedSpendMicros > Number(policy.max_spend_micros)) throw new FactoryReleaseError("factory_release_policy_denied");
    const changed = rows(await transaction.execute(sql`UPDATE factory_release_policies SET used_operations=used_operations+1,used_spend_micros=used_spend_micros+${operation.estimatedSpendMicros} WHERE tenant_id=${this.tenantId} AND project_id=${operation.projectId} AND policy_id=${policyId} AND revision=${expectedRevision} AND revoked_at_ms IS NULL AND used_operations<max_operations AND used_spend_micros+${operation.estimatedSpendMicros}<=max_spend_micros RETURNING policy_id`));
    if (!changed.length) throw new FactoryReleaseError("factory_release_policy_denied");
    return Number(policy.revision);
  }

  private async beginDispatch(claim: FactoryReleaseClaim): Promise<FactoryReleaseClaim> {
    return this.database.transaction(async transaction => {
      const changed = rows(await transaction.execute(sql`UPDATE factory_release_operations SET dispatch_started=TRUE,updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${claim.projectId} AND operation_id=${claim.operationId} AND state='executing' AND dispatch_generation=${claim.dispatchGeneration} AND sender_token=${claim.senderToken} AND dispatch_started=FALSE RETURNING operation_id`));
      if (!changed.length) throw new FactoryReleaseError("factory_release_sender_fenced");
      await insertTransactionalAuditEntry(transaction, `factory-release-dispatch-started:${claim.operationId}:${claim.dispatchGeneration}`, null, "factory.release.dispatch.started", claim.operationId, { tenantId: this.tenantId, projectId: claim.projectId, operationId: claim.operationId, dispatchGeneration: claim.dispatchGeneration, senderTokenDigest: hash({ senderToken: claim.senderToken }) });
      const started = await this.readInTransaction(transaction, claim.projectId, claim.operationId, "share");
      if (!started?.senderToken || !started.authority) throw new FactoryReleaseError("factory_release_corrupt");
      return { ...started, state: "executing", senderToken: started.senderToken, authority: started.authority };
    });
  }

  private async markUncertain(claim: FactoryReleaseClaim, code: string): Promise<FactoryReleaseOperation> {
    return this.database.transaction(async transaction => {
      const changed = rows(await transaction.execute(sql`UPDATE factory_release_operations SET state='uncertain',outcome_code=${code},updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${claim.projectId} AND operation_id=${claim.operationId} AND state='executing' AND dispatch_generation=${claim.dispatchGeneration} AND sender_token=${claim.senderToken} RETURNING operation_id`));
      if (!changed.length) throw new FactoryReleaseError("factory_release_sender_fenced");
      await insertTransactionalAuditEntry(transaction, `factory-release-uncertain:${claim.operationId}:${claim.dispatchGeneration}`, null, "factory.release.uncertain", claim.operationId, { tenantId: this.tenantId, projectId: claim.projectId, operationId: claim.operationId, dispatchGeneration: claim.dispatchGeneration, code });
      await this.enqueueNotificationInTransaction(transaction, claim.projectId, "release_uncertain", claim.operationId, { dispatchGeneration: claim.dispatchGeneration, code });
      return (await this.readInTransaction(transaction, claim.projectId, claim.operationId, "share"))!;
    });
  }

  private async settleReceipt(claim: FactoryReleaseClaim, receipt: FactoryProviderReceipt, receiptArchive: FactoryArchiveObject, source: string): Promise<FactoryReleaseOperation> {
    return this.database.transaction(transaction => this.settleReceiptInTransaction(transaction, claim, receipt, receiptArchive, source));
  }

  private async settleReceiptInTransaction(transaction: MigrationDb, operation: FactoryReleaseOperation, receipt: FactoryProviderReceipt, receiptArchive: FactoryArchiveObject, source: string): Promise<FactoryReleaseOperation> {
    validateReceipt(operation, receipt);
    const changed = rows(await transaction.execute(sql`UPDATE factory_release_operations SET state='succeeded',receipt_json=${canonicalJson(receipt)},receipt_archive_json=${archiveJson(receiptArchive)},outcome_code='confirmed',updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${operation.projectId} AND operation_id=${operation.operationId} AND state IN ('executing','uncertain') AND dispatch_generation=${operation.dispatchGeneration} RETURNING operation_id`));
    if (!changed.length) throw new FactoryReleaseError("factory_release_settlement_stale");
    await transaction.execute(sql`UPDATE factory_release_destination_reservations SET state='confirmed',updated_at=NOW() WHERE tenant_id=${this.tenantId} AND operation_id=${operation.operationId} AND dispatch_generation=${operation.dispatchGeneration}`);
    await insertTransactionalAuditEntry(transaction, `factory-release-receipt:${operation.operationId}:${operation.dispatchGeneration}`, null, "factory.release.receipt.confirmed", operation.operationId, { tenantId: this.tenantId, projectId: operation.projectId, operationId: operation.operationId, dispatchGeneration: operation.dispatchGeneration, receiptDigest: hash(receipt), receiptArchive, source });
    await this.enqueueNotificationInTransaction(transaction, operation.projectId, "release_settled", operation.operationId, { dispatchGeneration: operation.dispatchGeneration, providerReceiptId: receipt.providerReceiptId });
    return (await this.readInTransaction(transaction, operation.projectId, operation.operationId, "share"))!;
  }

  private async recordReconciliation(transaction: MigrationDb, operator: FactoryPrincipal, operation: FactoryReleaseOperation, request: FactoryReconciliationRequest, evidenceArchive: FactoryArchiveObject, authorityChecked = false): Promise<void> {
    if (!authorityChecked) await this.grants.authorizeInTransaction(transaction, operator, operation.projectId, "factory.operate");
    const reconciliationId = randomUUID();
    const evidenceJson = canonicalJson(request.providerEvidence);
    await transaction.execute(sql`INSERT INTO factory_release_reconciliations (tenant_id,project_id,reconciliation_id,operation_id,action,operator_id,reason,provider_evidence_json,provider_evidence_digest,evidence_archive_json) VALUES (${this.tenantId},${operation.projectId},${reconciliationId},${operation.operationId},${request.action},${operator.id},${request.reason},${evidenceJson},${hash(request.providerEvidence)},${archiveJson(evidenceArchive)})`);
    await insertTransactionalAuditEntry(transaction, `factory-release-reconciliation:${reconciliationId}`, operator.id, "factory.release.reconciled", operation.operationId, { tenantId: this.tenantId, projectId: operation.projectId, operationId: operation.operationId, reconciliationId, action: request.action, reason: request.reason, evidenceDigest: hash(request.providerEvidence) });
  }

  private async enqueueNotificationInTransaction(transaction: MigrationDb, projectId: string, kind: "approval_requested" | "release_uncertain" | "release_settled", operationId: string, payload: unknown): Promise<FactoryNotification> {
    const deduplicationId = `${kind}:${operationId}:${hash(payload)}`;
    const inputHash = durableInputHash({ kind, operationId, payload });
    return notificationQueue.enqueue(notificationStore(transaction, this.tenantId, projectId), { scope: notificationScope(this.tenantId, projectId), deduplicationId, inputHash, hashExisting: record => record.inputHash, create: () => ({ id: randomUUID(), tenantId: this.tenantId, projectId, deduplicationId, inputHash, kind, operationId, payload, state: "queued", attempts: 0, maxAttempts: 5, availableAt: this.now(), leaseUntil: 0, createdAt: this.now() }) });
  }

  private async readInTransaction(database: MigrationDb, projectId: string, operationId: string, lock: "update" | "share" | "none"): Promise<FactoryReleaseOperation | null> {
    const clause = lock === "update" ? sql`FOR UPDATE` : lock === "share" ? sql`FOR SHARE` : sql``;
    const row = rows<OperationRow>(await database.execute(sql`SELECT tenant_id,project_id,operation_id,run_id,node_instance_id,candidate_generation,candidate_digest,decision_id,contract_digest,execution_epoch,cancellation_epoch,release_enable_epoch,action,destination_provider,destination_account,destination_object,expected_destination_version,destination_digest,canonical_request,request_digest,material_json,material_digest,estimated_spend_micros,deadline_ms,state,dispatch_generation,sender_token,dispatch_started,authority_kind,authority_id,policy_revision,intent_archive_json,material_archive_json,receipt_archive_json,receipt_json,archive_ready,outcome_code FROM factory_release_operations WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND operation_id=${operationId} ${clause}`))[0];
    return row ? operationFromRow(row) : null;
  }
}
