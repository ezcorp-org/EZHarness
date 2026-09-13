import { randomUUID } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { DurableDeliveryQueue, dispatchDurableDelivery, durableInputHash, type DurableDeliveryRecord, type DurableDeliveryStore } from "../delivery-queue/durable-delivery-queue";
import { digestBytes, digestObject } from "../extensions/v4/blobs";
import type { FactoryAcceptedRelease, FactoryAssurance } from "./assurance";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { assertFactoryIdentity } from "./records";

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
  proveStopped(operation: FactoryReleaseOperation, senderToken: string, evidence: unknown): Promise<boolean>;
}

export interface FactoryReleaseProvider {
  publish(claim: FactoryReleaseClaim): Promise<FactoryProviderReceipt>;
  proveNoEffect(operation: FactoryReleaseOperation, evidence: unknown): Promise<boolean>;
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

export interface FactoryNotification extends DurableDeliveryRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly deduplicationId: string;
  readonly inputHash: string;
  readonly kind: "approval_requested" | "release_uncertain" | "release_settled";
  readonly operationId: string;
  readonly payload: unknown;
}

type OperationRow = {
  tenant_id: string; project_id: string; operation_id: string; run_id: string; node_instance_id: string; candidate_generation: number | string; candidate_digest: string;
  decision_id: string; contract_digest: string; execution_epoch: number | string; cancellation_epoch: number | string; release_enable_epoch: number | string;
  action: string; destination_provider: string; destination_account: string; destination_object: string; expected_destination_version: string | null; destination_digest: string;
  canonical_request: string; request_digest: string; material_json: string; material_digest: string; estimated_spend_micros: number | string; deadline_ms: number | string;
  state: FactoryReleaseState; dispatch_generation: number | string; sender_token: string | null; dispatch_started: boolean; authority_kind: "approval" | "policy" | null; authority_id: string | null; policy_revision: number | string | null;
  intent_archive_json: string | null; material_archive_json: string | null; receipt_archive_json: string | null; receipt_json: string | null; archive_ready: boolean; outcome_code: string | null;
};

type NotificationRow = { payload: string; state: FactoryNotification["state"]; input_hash: string };

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
  if (notification.tenantId !== tenantId || notification.projectId !== projectId || notification.inputHash !== row.input_hash || durableInputHash({ kind: notification.kind, operationId: notification.operationId, payload: notification.payload }) !== row.input_hash) throw new FactoryReleaseError("factory_notification_corrupt");
  return { ...notification, state: row.state };
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

/** C04 release operation store. All authority-bearing collaborators are mandatory and transaction-bound. */
export class FactoryReleases {
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
  ) {
    assertFactoryIdentity(tenantId);
    if (grants.tenantId !== tenantId || assurance.tenantId !== tenantId) throw new FactoryReleaseError("factory_release_scope");
  }

  async prepare(requester: FactoryPrincipal, input: FactoryReleaseRequest): Promise<FactoryReleaseOperation> {
    [requester, input] = canonical([requester, input]);
    validateRequest(input, this.now());
    const operation = await this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, requester, input.projectId, "factory.release");
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
      return saved;
    });
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

  async createPolicy(actor: FactoryPrincipal, policy: FactoryAutomaticReleasePolicy): Promise<void> {
    [actor, policy] = canonical([actor, policy]);
    text(policy.projectId, policy.policyId, policy.principal.id, policy.action, policy.destinationProvider, policy.destinationAccount, policy.destinationPrefix); digest(policy.contractDigest);
    count(policy.revision, true); count(policy.maxOperations, true); count(policy.maxSpendMicros);
    if (actor.kind !== "user" || actor.authentication !== "session" || policy.expiresAtMs <= this.now() || policy.expiresAtMs - this.now() > THIRTY_DAYS_MS) throw new FactoryReleaseError("factory_release_policy_invalid");
    await this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, actor, policy.projectId, "factory.approve");
      const inserted = rows(await transaction.execute(sql`INSERT INTO factory_release_policies (tenant_id,project_id,policy_id,principal_kind,principal_id,action,destination_provider,destination_account,destination_prefix,contract_digest,revision,max_operations,max_spend_micros,expires_at_ms,created_by) VALUES (${this.tenantId},${policy.projectId},${policy.policyId},${policy.principal.kind},${policy.principal.id},${policy.action},${policy.destinationProvider},${policy.destinationAccount},${policy.destinationPrefix},${policy.contractDigest},${policy.revision},${policy.maxOperations},${policy.maxSpendMicros},${policy.expiresAtMs},${actor.id}) ON CONFLICT DO NOTHING RETURNING policy_id`));
      if (!inserted.length) throw new FactoryReleaseError("factory_release_policy_conflict");
      await insertTransactionalAuditEntry(transaction, `factory-release-policy-created:${policy.policyId}:${policy.revision}`, actor.id, "factory.release.policy.created", policy.policyId, { tenantId: this.tenantId, projectId: policy.projectId, policy });
    });
  }

  async revokePolicy(actor: FactoryPrincipal, projectId: string, policyId: string, expectedRevision: number): Promise<void> {
    [actor, projectId, policyId] = canonical([actor, projectId, policyId]); text(projectId, policyId); count(expectedRevision, true);
    if (actor.kind !== "user" || actor.authentication !== "session") throw new FactoryReleaseError("factory_release_policy_invalid");
    await this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, actor, projectId, "factory.approve");
      const changed = rows(await transaction.execute(sql`UPDATE factory_release_policies SET revoked_at_ms=${this.now()},revision=revision+1 WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND policy_id=${policyId} AND revision=${expectedRevision} AND revoked_at_ms IS NULL RETURNING policy_id`));
      if (!changed.length) throw new FactoryReleaseError("factory_release_policy_stale");
      await insertTransactionalAuditEntry(transaction, `factory-release-policy-revoked:${policyId}:${expectedRevision}`, actor.id, "factory.release.policy.revoked", policyId, { tenantId: this.tenantId, projectId, policyId, expectedRevision });
    });
  }

  async requestApproval(actor: FactoryPrincipal, projectId: string, operationId: string, expiresAtMs: number): Promise<{ approvalId: string; contextDigest: string }> {
    [actor, projectId, operationId] = canonical([actor, projectId, operationId]); text(projectId, operationId);
    return this.database.transaction(async transaction => {
      const operation = await this.readInTransaction(transaction, projectId, operationId, "update");
      if (operation?.state !== "pending" || !operation.archiveReady || expiresAtMs > operation.deadlineMs) throw new FactoryReleaseError("factory_release_not_claimable");
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

  async reconcile(operator: FactoryPrincipal, request: FactoryReconciliationRequest, provider: FactoryReleaseProvider): Promise<FactoryReleaseOperation> {
    [operator, request] = canonical([operator, request]);
    text(request.projectId, request.operationId, request.reason); if (encoder.encode(request.reason).byteLength > MAX_REASON_BYTES || encoder.encode(canonicalJson(request.providerEvidence)).byteLength > MAX_REQUEST_BYTES || !request.providerEvidence || typeof request.providerEvidence !== "object" || Array.isArray(request.providerEvidence) || !Object.keys(request.providerEvidence).length || operator.kind !== "user" || operator.authentication !== "session") throw new FactoryReleaseError("factory_release_reconciliation_invalid");
    await this.database.transaction(transaction => this.grants.authorizeInTransaction(transaction, operator, request.projectId, "factory.operate"));
    const operation = await this.inspect(request.projectId, request.operationId);
    if (!operation?.senderToken || operation.state !== "uncertain" && !(operation.state === "executing" && operation.dispatchStarted)) throw new FactoryReleaseError("factory_release_reconciliation_stale");
    if (request.action === "attach_receipt") {
      if (!request.receipt) throw new FactoryReleaseError("factory_release_reconciliation_invalid");
      validateReceipt(operation, request.receipt);
    } else if (request.receipt) throw new FactoryReleaseError("factory_release_reconciliation_invalid");
    if (request.action === "confirm_no_effect") {
      const [stopped, absent] = await Promise.all([this.senderFence.proveStopped(operation, operation.senderToken, request.providerEvidence), provider.proveNoEffect(operation, request.providerEvidence)]);
      if (!stopped || !absent) throw new FactoryReleaseError("factory_release_absence_unproved");
    }
    const evidence = { action: request.action, reason: request.reason, providerEvidence: request.providerEvidence, ...(request.receipt ? { receipt: request.receipt } : {}) };
    const evidenceArchive = await archiveAndVerify(this.archive, this.tenantId, operation.operationId, "reconciliation", evidence);
    if (request.action === "attach_receipt") {
      const receiptArchive = await archiveAndVerify(this.archive, this.tenantId, operation.operationId, "receipt", request.receipt!);
      return this.database.transaction(async transaction => {
        await this.recordReconciliation(transaction, operator, operation, request, evidenceArchive);
        return this.settleReceiptInTransaction(transaction, operation, request.receipt!, receiptArchive, "reconciliation");
      });
    }
    return this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, operator, operation.projectId, "factory.operate");
      const locked = await this.readInTransaction(transaction, operation.projectId, operation.operationId, "update");
      if (!locked?.senderToken || locked.senderToken !== operation.senderToken || locked.state !== "uncertain" && !(locked.state === "executing" && locked.dispatchStarted)) throw new FactoryReleaseError("factory_release_reconciliation_stale");
      await this.recordReconciliation(transaction, operator, locked, request, evidenceArchive, true);
      if (request.action === "confirm_no_effect") {
        await transaction.execute(sql`UPDATE factory_release_operations SET state='pending',sender_token=NULL,dispatch_started=FALSE,outcome_code='confirmed_no_effect',updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${operation.projectId} AND operation_id=${operation.operationId}`);
        await transaction.execute(sql`UPDATE factory_release_destination_reservations SET state='released',updated_at=NOW() WHERE tenant_id=${this.tenantId} AND operation_id=${operation.operationId}`);
      } else if (locked.state === "executing") {
        await transaction.execute(sql`UPDATE factory_release_operations SET state='uncertain',outcome_code='operator_kept_uncertain',updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${operation.projectId} AND operation_id=${operation.operationId}`);
      }
      return (await this.readInTransaction(transaction, operation.projectId, operation.operationId, "share"))!;
    });
  }

  async claimNotification(projectId: string, leaseMs = 60_000): Promise<FactoryNotification | null> { text(projectId); return this.database.transaction(transaction => notificationQueue.claim(notificationStore(transaction, this.tenantId, projectId), notificationScope(this.tenantId, projectId), this.now(), leaseMs)); }
  async settleNotification(projectId: string, notification: FactoryNotification, outcome: "delivered" | "retry" | "outcome_unknown", code?: string): Promise<FactoryNotification> { text(projectId); return this.database.transaction(transaction => notificationQueue.settle(notificationStore(transaction, this.tenantId, projectId), notificationScope(this.tenantId, projectId), notification, this.now(), outcome, code)); }
  async inspectNotification(projectId: string, notificationId: string): Promise<FactoryNotification | null> { text(projectId, notificationId); return notificationQueue.inspect(notificationStore(this.database, this.tenantId, projectId), notificationScope(this.tenantId, projectId), notificationId); }
  async dispatchNotification(projectId: string, handler: (notification: FactoryNotification) => Promise<void>): Promise<FactoryNotification | null> { return dispatchDurableDelivery(() => this.claimNotification(projectId), (notification, outcome, code) => this.settleNotification(projectId, notification, outcome, code), handler, () => null); }

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

  private async enqueueNotificationInTransaction(transaction: MigrationDb, projectId: string, kind: FactoryNotification["kind"], operationId: string, payload: unknown): Promise<FactoryNotification> {
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
