import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { up as addFactoryReleases } from "../../db/migrations/add-factory-releases";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { FactoryAssurance, type FactoryCandidateKey, type FactoryCurrentCandidateResolver, type FactoryReleaseFenceReader, type FactoryTrustedEvidence, type FactoryTrustedValidatorGateway } from "../../factory/assurance";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryRecords } from "../../factory/records";
import { FactoryReleases, type FactoryArchiveObject, type FactoryDestinationReservationReader, type FactoryProviderReceipt, type FactoryReleaseArchive, type FactoryReleaseAuthority, type FactoryReleaseAuthorityReader, type FactoryReleaseClaim, type FactoryReleaseMaterialReader, type FactoryReleaseOperation, type FactoryReleaseProvider, type FactoryReleaseRequest, type FactorySenderFence } from "../../factory/releases";

export function factoryReleaseConformance(setup: () => Promise<{ db: TransactionalDb; close: () => Promise<void> }>): void {
const now = Date.UTC(2031, 0, 1);
const tenantId = "release-tenant", projectId = "release-project";
const admin: FactoryPrincipal = { kind: "user", id: "release-admin", authentication: "session" };
const service: FactoryPrincipal = { kind: "service", id: "release-service", authentication: "service" };
const candidate: FactoryCandidateKey = { projectId, runId: "release-run", nodeInstanceId: "release-node", candidateGeneration: 1 };
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;

let database: TransactionalDb;
let close: () => Promise<void>;
let grants: FactoryGrants;
let assurance: FactoryAssurance;
let releases: FactoryReleases;
let decisionId: string;
let fenceStatus: FactoryReleaseAuthority["status"] = "running";
const releaseEnableEpoch = 4;
let destinationVersion: string | null = null;
let trusted: FactoryTrustedEvidence;

class Gateway implements FactoryTrustedValidatorGateway, FactoryCurrentCandidateResolver {
  async resolveValidatorInTransaction(_transaction: MigrationDb, tenant: string, key: FactoryCandidateKey, validatorId: string): Promise<FactoryTrustedEvidence> {
    if (tenant !== tenantId || key.projectId !== projectId || key.runId !== candidate.runId || key.nodeInstanceId !== candidate.nodeInstanceId || key.candidateGeneration !== candidate.candidateGeneration || validatorId !== trusted.validatorId) throw new Error("current candidate mismatch");
    return structuredClone(trusted);
  }
  async resolveCurrentEvidenceInTransaction(transaction: MigrationDb, tenant: string, key: FactoryCandidateKey, validatorIds: readonly string[]) { return [await this.resolveValidatorInTransaction(transaction, tenant, key, validatorIds[0]!)]; }
}

class RunFence implements FactoryReleaseFenceReader {
  async readCurrentInTransaction() { return { runId: candidate.runId, executionEpoch: 1, cancellationEpoch: fenceStatus === "running" ? 0 : 1, status: fenceStatus, deadlineMs: now + 10_000 }; }
}

class Authority implements FactoryReleaseAuthorityReader {
  calls = 0;
  async lockCurrentInTransaction(_transaction: MigrationDb, tenant: string, project: string, runId: string, nodeInstanceId: string): Promise<FactoryReleaseAuthority> {
    this.calls += 1;
    if (tenant !== tenantId || project !== projectId || runId !== candidate.runId || nodeInstanceId !== candidate.nodeInstanceId) throw new Error("canonical lifecycle lock mismatch");
    return { ...candidate, candidateDigest: trusted.candidateDigest, executionEpoch: 1, cancellationEpoch: fenceStatus === "running" ? 0 : 1, releaseEnableEpoch, deadlineMs: now + 10_000, status: fenceStatus, packageTrustDigest: digest("a"), validatorTrustDigest: digest("b") };
  }
}

class Destination implements FactoryDestinationReservationReader {
  async reserveInTransaction(_transaction: MigrationDb, tenant: string, operation: FactoryReleaseOperation) {
    if (tenant !== tenantId || operation.projectId !== projectId) throw new Error("foreign destination");
    return { currentVersion: destinationVersion };
  }
}

class MemoryArchive implements FactoryReleaseArchive {
  readonly objects = new Map<string, Uint8Array>();
  writes = 0;
  failWrite = false;
  corruptRead = false;
  async writeImmutable(tenant: string, operationId: string, name: "intent" | "material" | "receipt" | "reconciliation", bytes: Uint8Array): Promise<FactoryArchiveObject> {
    this.writes += 1;
    if (this.failWrite) throw new Error("archive unavailable");
    const raw = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const key = `${tenant}/${operationId}/${name}/${raw}`;
    const prior = this.objects.get(key);
    if (prior && !prior.every((value, index) => value === bytes[index])) throw new Error("immutable archive conflict");
    this.objects.set(key, bytes.slice());
    return { key, digest: `sha256:${raw}`, versionId: "archive-v1" };
  }
  async read(reference: FactoryArchiveObject): Promise<Uint8Array> {
    const value = this.objects.get(reference.key);
    if (!value) throw new Error("archive missing");
    return this.corruptRead ? new Uint8Array([0]) : value.slice();
  }
}

class SenderFence implements FactorySenderFence {
  stopped = false;
  proofCalls = 0;
  async proveStopped(operation: FactoryReleaseOperation, senderToken: string, evidence: unknown) { this.proofCalls += 1; return this.stopped && senderToken === operation.senderToken && (evidence as { operationId?: string })?.operationId === operation.operationId; }
}

class Provider implements FactoryReleaseProvider {
  calls = 0;
  proofCalls = 0;
  loseResponse = false;
  noEffect = false;
  receipts = new Map<string, FactoryProviderReceipt>();
  async publish(claim: FactoryReleaseClaim): Promise<FactoryProviderReceipt> {
    this.calls += 1;
    const receipt = { provider: claim.destination.provider, account: claim.destination.account, object: claim.destination.object, requestDigest: claim.requestDigest, operationId: claim.operationId, dispatchGeneration: claim.dispatchGeneration, providerReceiptId: `receipt-${claim.operationId}`, version: `v${claim.dispatchGeneration}`, effectDigest: digest("f") };
    this.receipts.set(claim.operationId, receipt);
    if (this.loseResponse) throw new Error("response lost after write");
    return receipt;
  }
  async proveNoEffect(operation: FactoryReleaseOperation, evidence: unknown) { this.proofCalls += 1; return this.noEffect && (evidence as { operationId?: string })?.operationId === operation.operationId; }
}

const archive = new MemoryArchive();
const authority = new Authority();
const sender = new SenderFence();
const provider = new Provider();

function request(suffix: string, overrides: Partial<FactoryReleaseRequest> = {}): FactoryReleaseRequest {
  return { ...candidate, decisionId, candidateDigest: trusted.candidateDigest, action: "publish", destination: { provider: "fixture", account: "account-a", object: `releases/${suffix}` }, request: { body: suffix }, estimatedSpendMicros: 5, deadlineMs: now + 5_000, ...overrides };
}

let mutationSequence = 0;
const mutationKey = (kind: string) => `${kind}-${++mutationSequence}`;
const prepareRelease = (actor: FactoryPrincipal, input: FactoryReleaseRequest, idempotencyKey = mutationKey("prepare")) => releases.prepare(actor, input, idempotencyKey);
const createReleasePolicy = (actor: FactoryPrincipal, policy: Parameters<FactoryReleases["createPolicy"]>[1], idempotencyKey = mutationKey("policy-create")) => releases.createPolicy(actor, policy, idempotencyKey);
const revokeReleasePolicy = (actor: FactoryPrincipal, currentProjectId: string, policyId: string, expectedRevision: number, idempotencyKey = mutationKey("policy-revoke")) => releases.revokePolicy(actor, currentProjectId, policyId, expectedRevision, idempotencyKey);
const requestReleaseApproval = (actor: FactoryPrincipal, currentProjectId: string, operationId: string, expiresAtMs: number, idempotencyKey = mutationKey("approval-request")) => releases.requestApproval(actor, currentProjectId, operationId, expiresAtMs, idempotencyKey);
const reconcileRelease = (actor: FactoryPrincipal, input: Parameters<FactoryReleases["reconcile"]>[1], currentProvider: FactoryReleaseProvider, idempotencyKey = mutationKey("reconcile")) => releases.reconcile(actor, input, currentProvider, idempotencyKey);

async function approved(operation: FactoryReleaseOperation, requester: FactoryPrincipal = admin) {
  const approval = await assurance.requestApproval(admin, { projectId, operationId: operation.operationId, decisionId, destinationDigest: operation.destinationDigest, expectedGeneration: operation.dispatchGeneration + 1, expiresAtMs: now + 1_000 }, mutationKey("assurance-request"));
  await assurance.decideApproval(admin, projectId, approval.approvalId, approval.contextDigest, true, mutationKey("assurance-decision"));
  if (requester.kind === "service") expect(requester.id).toBe(service.id);
  return approval.approvalId;
}

beforeAll(async () => {
  const fixture = await setup();
  database = fixture.db;
  close = fixture.close;
  const records = new FactoryRecords(database, tenantId); await records.bindInstallation();
  await database.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Release','/tmp/release')`); await records.bindProject(projectId);
  await database.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${admin.id},'release@example.test','x','release','admin')`);
  await database.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('release-member',${projectId},${admin.id},'owner')`);
  await database.execute(sql`INSERT INTO service_accounts(id,name,created_by_user_id,project_id,max_tokens_per_day,expires_at) VALUES (${service.id},'Release service',${admin.id},${projectId},100,${new Date(now + 10_000)})`);
  await records.createRun({ projectId, runId: candidate.runId, definitionDigest: digest("d"), interpreterBuild: "v1", executionEpoch: 1, input: {}, principalId: admin.id }, async () => {});
  grants = new FactoryGrants(database, tenantId, () => now);
  for (const action of ["factory.trust", "factory.approve", "factory.release", "factory.operate"] as const) await grants.set(admin, { projectId, principal: admin, action, expectedRevision: 0, expiresAtMs: null });
  await grants.set(admin, { projectId, principal: service, action: "factory.release", expectedRevision: 0, expiresAtMs: now + 5_000 });
  trusted = { ...candidate, validatorId: "validator", validatorLockDigest: digest("c"), issuerGrantRevision: 1, candidateDigest: digest("c"), artifact: { artifactId: "artifact", digest: digest("a"), encodedBytes: 10 }, environmentDigest: digest("e"), configurationDigest: digest("d"), runnerDigest: digest("e"), claims: [{ id: "passed", passed: true, decisive: true }], issuedAtMs: now - 1, expiresAtMs: now + 10_000 };
  const gateway = new Gateway();
  assurance = new FactoryAssurance(database, tenantId, grants, gateway, new RunFence(), gateway, () => now);
  await assurance.approveContract(admin, { projectId, contractId: "contract", revision: 1, contractDigest: digest("f"), validatorLockDigest: trusted.validatorLockDigest, mandatoryClaims: [{ id: "passed", validatorId: trusted.validatorId, freshnessMs: 100 }], claimGroups: [{ id: "all", claimIds: ["passed"], minimumPasses: 1, requireAllDecisive: true }] }, mutationKey("contract"));
  await assurance.captureEvidence({ ...candidate, validatorId: trusted.validatorId });
  decisionId = (await assurance.accept({ ...candidate, contractId: "contract", revision: 1 })).decisionId;
  const materials: FactoryReleaseMaterialReader = { async readPinnedInTransaction(_transaction, tenant, accepted) { if (tenant !== tenantId || accepted.decisionId !== decisionId) throw new Error("material scope"); return { decisionId, evidence: [{ artifact: trusted.artifact, candidateDigest: trusted.candidateDigest }], packageTrustDigest: digest("a"), validatorTrustDigest: digest("b") }; } };
  releases = new FactoryReleases(database, tenantId, grants, assurance, materials, authority, new Destination(), archive, sender, () => now);
});

afterAll(async () => { await close?.(); });

test("migration creates scoped release, archive, reconciliation, reservation, policy, and notification records", async () => {
  await addFactoryReleases(database);
  await addFactoryReleases(database);
  const names = rows<{ table_name: string }>(await database.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'factory_release_%' OR table_name='factory_notifications' ORDER BY table_name`)).map(row => row.table_name);
  expect(names).toEqual(expect.arrayContaining(["factory_release_operations", "factory_release_policies", "factory_release_destination_reservations", "factory_release_reconciliations", "factory_notifications"]));
});

test("archive is immutable and read-verified before claim", async () => {
  const archiveKey = "prepare-archive-retry";
  archive.failWrite = true;
  await expect(prepareRelease(admin, request("archive-fault"), archiveKey)).rejects.toThrow("archive unavailable");
  const pending = rows<{ state: string; archive_ready: boolean }>(await database.execute(sql`SELECT state,archive_ready FROM factory_release_operations WHERE destination_object='releases/archive-fault'`))[0];
  expect(pending).toEqual({ state: "pending", archive_ready: false });
  archive.failWrite = false; archive.corruptRead = true;
  await expect(prepareRelease(admin, request("archive-fault"), archiveKey)).rejects.toMatchObject({ code: "factory_release_archive_unreadable" });
  archive.corruptRead = false;
  const prepared = await prepareRelease(admin, request("archive-fault"), archiveKey);
  expect(prepared).toMatchObject({ archiveReady: true, state: "pending", material: { decisionId } });
  const writesAfterReady = archive.writes;
  expect(await prepareRelease(admin, request("archive-fault"), archiveKey)).toEqual(prepared);
  expect(archive.writes).toBe(writesAfterReady);
  await expect(prepareRelease(admin, request("archive-fault", { request: { body: "changed" } }), archiveKey)).rejects.toMatchObject({ code: "idempotency_conflict" });

  await database.execute(sql`CREATE FUNCTION reject_release_archive_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='factory.release.archived' THEN RAISE EXCEPTION 'archive audit unavailable'; END IF; RETURN NEW; END $$`);
  await database.execute(sql`CREATE TRIGGER reject_release_archive_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_release_archive_audit()`);
  await expect(prepareRelease(admin, request("archive-audit-fault"))).rejects.toThrow();
  expect(rows<{ state: string; archive_ready: boolean }>(await database.execute(sql`SELECT state,archive_ready FROM factory_release_operations WHERE destination_object='releases/archive-audit-fault'`))).toEqual([{ state: "pending", archive_ready: false }]);
  await database.execute(sql`DROP TRIGGER reject_release_archive_audit ON audit_log`); await database.execute(sql`DROP FUNCTION reject_release_archive_audit()`);
  const auditRetry = await prepareRelease(admin, request("archive-audit-fault"));
  expect(auditRetry).toMatchObject({ state: "pending", archiveReady: true });
});

test("authority selection rejects another candidate-producing node in the same run", async () => {
  await expect(prepareRelease(admin, request("foreign-node", { nodeInstanceId: "another-release-node" }))).rejects.toThrow("canonical lifecycle lock mismatch");
  expect(rows(await database.execute(sql`SELECT operation_id FROM factory_release_operations WHERE destination_object='releases/foreign-node'`))).toEqual([]);
});

test("approval request and its human notification commit together once", async () => {
  const operation = await prepareRelease(admin, request("approval-notification"));
  const approvalKey = "release-approval-stable";
  const approval = await requestReleaseApproval(admin, projectId, operation.operationId, now + 1_000, approvalKey);
  expect(await requestReleaseApproval(admin, projectId, operation.operationId, now + 1_000, approvalKey)).toEqual(approval);
  await expect(requestReleaseApproval(admin, projectId, operation.operationId, now + 999, approvalKey)).rejects.toMatchObject({ code: "idempotency_conflict" });
  const notification = await releases.claimNotification(projectId);
  expect(notification).toMatchObject({ kind: "approval_requested", operationId: operation.operationId, payload: { approvalId: approval.approvalId } });
  await releases.settleNotification(projectId, notification!, "delivered");
  expect(await releases.inspectNotification(projectId, notification!.id)).toMatchObject({ state: "delivered" });
  expect(rows<{ state: string }>(await database.execute(sql`SELECT state FROM factory_notifications WHERE notification_id=${notification!.id}`))).toEqual([{ state: "delivered" }]);
  expect(rows(await database.execute(sql`SELECT notification_id FROM factory_notifications WHERE payload::jsonb->>'operationId'=${operation.operationId}`))).toHaveLength(1);

  const failedNotificationOperation = await prepareRelease(admin, request("approval-notification-failed"));
  await requestReleaseApproval(admin, projectId, failedNotificationOperation.operationId, now + 1_000);
  const unknown = await releases.dispatchNotification(projectId, async () => { throw new Error("notification response lost"); });
  expect(unknown).toMatchObject({ kind: "approval_requested", operationId: failedNotificationOperation.operationId, state: "outcome_unknown" });
});

test("claim atomically consumes one exact approval and rejects cancellation, revocation, races, and destination changes", async () => {
  const cancelled = await prepareRelease(admin, request("cancel-before")); const cancelApproval = await approved(cancelled);
  fenceStatus = "cancelling";
  await expect(releases.claim(admin, projectId, cancelled.operationId, { kind: "approval", approvalId: cancelApproval })).rejects.toThrow();
  fenceStatus = "running";

  const changed = await prepareRelease(admin, request("destination-change")); const changedApproval = await approved(changed); destinationVersion = "foreign";
  await expect(releases.claim(admin, projectId, changed.operationId, { kind: "approval", approvalId: changedApproval })).rejects.toMatchObject({ code: "factory_release_destination_changed" });
  destinationVersion = null;

  const raced = await prepareRelease(admin, request("claim-race")); const approval = await approved(raced);
  const results = await Promise.allSettled([releases.claim(admin, projectId, raced.operationId, { kind: "approval", approvalId: approval }), releases.claim(admin, projectId, raced.operationId, { kind: "approval", approvalId: approval })]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(rows<{ status: string }>(await database.execute(sql`SELECT status FROM factory_release_approvals WHERE approval_id=${approval}`))).toEqual([{ status: "consumed" }]);

  const revokedRequest = request("grant-revoked");
  const revoked = await prepareRelease(admin, revokedRequest, "prepare-before-revoke"); const revokedApproval = await approved(revoked);
  await grants.revoke(admin, { projectId, principal: admin, action: "factory.release", expectedRevision: 1 });
  await expect(prepareRelease(admin, revokedRequest, "prepare-before-revoke")).rejects.toThrow("factory_forbidden");
  await expect(releases.claim(admin, projectId, revoked.operationId, { kind: "approval", approvalId: revokedApproval })).rejects.toThrow("factory_forbidden");
  await grants.set(admin, { projectId, principal: admin, action: "factory.release", expectedRevision: 2, expiresAtMs: null });
});

test("bounded automatic policy is consumed at claim and revocation wins before claim", async () => {
  const approvedService = await prepareRelease(service, request("service-approved"));
  const serviceApproval = await approved(approvedService, service);
  await expect(releases.claim(service, projectId, approvedService.operationId, { kind: "approval", approvalId: serviceApproval })).resolves.toMatchObject({ authority: { kind: "approval", id: serviceApproval } });

  const policy = { projectId, policyId: "policy-a", principal: service, action: "publish", destinationProvider: "fixture", destinationAccount: "account-a", destinationPrefix: "releases/policy", contractDigest: digest("f"), revision: 1, maxOperations: 1, maxSpendMicros: 5, expiresAtMs: now + 5_000 } as const;
  await createReleasePolicy(admin, policy, "policy-a-create");
  await createReleasePolicy(admin, policy, "policy-a-create");
  await expect(createReleasePolicy(admin, { ...policy, maxOperations: 2 }, "policy-a-create")).rejects.toMatchObject({ code: "idempotency_conflict" });
  const foreignAccount = await prepareRelease(service, request("policy-foreign-account", { destination: { provider: "fixture", account: "account-b", object: "releases/policy/foreign" } }));
  await expect(releases.claim(service, projectId, foreignAccount.operationId, { kind: "policy", policyId: "policy-a", expectedRevision: 1 })).rejects.toMatchObject({ code: "factory_release_policy_denied" });
  const foreignProvider = await prepareRelease(service, request("policy-foreign-provider", { destination: { provider: "other", account: "account-a", object: "releases/policy/foreign" } }));
  await expect(releases.claim(service, projectId, foreignProvider.operationId, { kind: "policy", policyId: "policy-a", expectedRevision: 1 })).rejects.toMatchObject({ code: "factory_release_policy_denied" });
  const first = await prepareRelease(service, request("policy-one"));
  await expect(releases.claim(service, projectId, first.operationId, { kind: "policy", policyId: "policy-a", expectedRevision: 1 })).resolves.toMatchObject({ authority: { kind: "policy", id: "policy-a", policyRevision: 1 } });
  const second = await prepareRelease(service, request("policy-two"));
  await expect(releases.claim(service, projectId, second.operationId, { kind: "policy", policyId: "policy-a", expectedRevision: 1 })).rejects.toMatchObject({ code: "factory_release_policy_denied" });
  await createReleasePolicy(admin, { projectId, policyId: "policy-revoked", principal: service, action: "publish", destinationProvider: "fixture", destinationAccount: "account-a", destinationPrefix: "releases/policy", contractDigest: digest("f"), revision: 1, maxOperations: 2, maxSpendMicros: 10, expiresAtMs: now + 5_000 });
  await revokeReleasePolicy(admin, projectId, "policy-revoked", 1, "policy-revoke-stable");
  await revokeReleasePolicy(admin, projectId, "policy-revoked", 1, "policy-revoke-stable");
  await expect(releases.claim(service, projectId, second.operationId, { kind: "policy", policyId: "policy-revoked", expectedRevision: 2 })).rejects.toMatchObject({ code: "factory_release_policy_denied" });
});

test("dispatch archives a readable receipt before database success and post-claim cancellation does not forge rollback", async () => {
  const startFault = await prepareRelease(admin, request("dispatch-start-audit-fault")); const startFaultApproval = await approved(startFault); const startFaultClaim = await releases.claim(admin, projectId, startFault.operationId, { kind: "approval", approvalId: startFaultApproval });
  await database.execute(sql`CREATE FUNCTION reject_release_dispatch_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='factory.release.dispatch.started' THEN RAISE EXCEPTION 'dispatch audit unavailable'; END IF; RETURN NEW; END $$`);
  await database.execute(sql`CREATE TRIGGER reject_release_dispatch_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_release_dispatch_audit()`);
  const callsBeforeStart = provider.calls; const startFailed = await releases.dispatch(startFaultClaim, provider).then(() => false, () => true);
  await database.execute(sql`DROP TRIGGER reject_release_dispatch_audit ON audit_log`); await database.execute(sql`DROP FUNCTION reject_release_dispatch_audit()`);
  expect(startFailed).toBe(true); expect(provider.calls).toBe(callsBeforeStart); expect(await releases.inspect(projectId, startFault.operationId)).toMatchObject({ state: "executing", dispatchStarted: false });

  const operation = await prepareRelease(admin, request("dispatch-success")); const approval = await approved(operation); const claim = await releases.claim(admin, projectId, operation.operationId, { kind: "approval", approvalId: approval });
  const providerCalls = provider.calls;
  await expect(releases.dispatch({ ...claim, estimatedSpendMicros: claim.estimatedSpendMicros + 1 }, provider)).rejects.toMatchObject({ code: "factory_release_sender_fenced" });
  expect(provider.calls).toBe(providerCalls);
  const releaseGrant = rows<{ revision: number | string }>(await database.execute(sql`SELECT revision FROM factory_grants WHERE principal_id=${admin.id} AND action='factory.release'`))[0]!;
  const revoked = await grants.revoke(admin, { projectId, principal: admin, action: "factory.release", expectedRevision: Number(releaseGrant.revision) });
  fenceStatus = "cancelling";
  const settled = await releases.dispatch(claim, provider);
  fenceStatus = "running";
  await grants.set(admin, { projectId, principal: admin, action: "factory.release", expectedRevision: revoked.revision, expiresAtMs: null });
  expect(settled).toMatchObject({ state: "succeeded", receipt: { operationId: operation.operationId }, receiptArchive: { versionId: "archive-v1" } });
  expect(rows<{ state: string }>(await database.execute(sql`SELECT state FROM factory_release_destination_reservations WHERE operation_id=${operation.operationId}`))).toEqual([{ state: "confirmed" }]);
  const notification = await releases.claimNotification(projectId);
  expect(notification).toMatchObject({ kind: "release_settled", operationId: operation.operationId });
  await releases.settleNotification(projectId, notification!, "delivered");
});

test("the durable dispatch-start fence permits only one provider call", async () => {
  const operation = await prepareRelease(admin, request("dispatch-race")); const approval = await approved(operation); const claim = await releases.claim(admin, projectId, operation.operationId, { kind: "approval", approvalId: approval });
  const calls = provider.calls;
  const results = await Promise.allSettled([releases.dispatch(claim, provider), releases.dispatch(claim, provider)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(provider.calls).toBe(calls + 1);
});

test("lost response remains uncertain and never causes an implicit resend", async () => {
  const operation = await prepareRelease(admin, request("response-loss")); const approval = await approved(operation); const claim = await releases.claim(admin, projectId, operation.operationId, { kind: "approval", approvalId: approval });
  provider.loseResponse = true;
  expect(await releases.dispatch(claim, provider)).toMatchObject({ state: "uncertain", outcomeCode: "provider_response_unknown" });
  const calls = provider.calls;
  await expect(releases.dispatch(claim, provider)).rejects.toMatchObject({ code: "factory_release_sender_fenced" });
  expect(provider.calls).toBe(calls);
  provider.loseResponse = false;

  const archiveFault = await prepareRelease(admin, request("receipt-archive-fault")); const archiveFaultApproval = await approved(archiveFault); const archiveFaultClaim = await releases.claim(admin, projectId, archiveFault.operationId, { kind: "approval", approvalId: archiveFaultApproval });
  archive.failWrite = true;
  const archiveUnknown = await releases.dispatch(archiveFaultClaim, provider);
  archive.failWrite = false;
  expect(archiveUnknown).toMatchObject({ state: "uncertain", outcomeCode: "receipt_archive_unknown" });
  expect(archiveUnknown.receipt).toBeUndefined();

  const auditFault = await prepareRelease(admin, request("receipt-audit-fault")); const auditFaultApproval = await approved(auditFault); const auditFaultClaim = await releases.claim(admin, projectId, auditFault.operationId, { kind: "approval", approvalId: auditFaultApproval });
  await database.execute(sql`CREATE FUNCTION reject_release_receipt_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('factory.release.receipt.confirmed','factory.release.uncertain') THEN RAISE EXCEPTION 'receipt audit unavailable'; END IF; RETURN NEW; END $$`);
  await database.execute(sql`CREATE TRIGGER reject_release_receipt_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_release_receipt_audit()`);
  const auditSettlementFailed = await releases.dispatch(auditFaultClaim, provider).then(() => false, () => true);
  await database.execute(sql`DROP TRIGGER reject_release_receipt_audit ON audit_log`); await database.execute(sql`DROP FUNCTION reject_release_receipt_audit()`);
  expect(auditSettlementFailed).toBe(true);
  expect(await releases.inspect(projectId, auditFault.operationId)).toMatchObject({ state: "executing", dispatchStarted: true });
  await expect(releases.dispatch(auditFaultClaim, provider)).rejects.toMatchObject({ code: "factory_release_sender_fenced" });
  expect(await reconcileRelease(admin, { projectId, operationId: auditFault.operationId, action: "attach_receipt", reason: "archived receipt survived the audit outage", providerEvidence: { lookup: true }, receipt: provider.receipts.get(auditFault.operationId)! }, provider)).toMatchObject({ state: "succeeded" });
});

test("reconcile attaches a verified receipt, preserves uncertainty, or proves no effect before new consent", async () => {
  const attach = await prepareRelease(admin, request("attach-receipt")); const attachApproval = await approved(attach); const attachClaim = await releases.claim(admin, projectId, attach.operationId, { kind: "approval", approvalId: attachApproval });
  provider.loseResponse = true; await releases.dispatch(attachClaim, provider); provider.loseResponse = false;
  const receipt = provider.receipts.get(attach.operationId)!;
  await expect(reconcileRelease(admin, { projectId, operationId: attach.operationId, action: "attach_receipt", reason: "provider lookup verified the exact version", providerEvidence: { lookup: true }, receipt: { ...receipt, object: "foreign" } }, provider)).rejects.toMatchObject({ code: "factory_release_foreign_receipt" });
  expect(await reconcileRelease(admin, { projectId, operationId: attach.operationId, action: "attach_receipt", reason: "provider lookup verified the exact version", providerEvidence: { lookup: true }, receipt }, provider)).toMatchObject({ state: "succeeded" });

  const held = await prepareRelease(admin, request("keep-uncertain")); const heldApproval = await approved(held); const heldClaim = await releases.claim(admin, projectId, held.operationId, { kind: "approval", approvalId: heldApproval });
  provider.loseResponse = true; await releases.dispatch(heldClaim, provider); provider.loseResponse = false;
  const keepRequest = { projectId, operationId: held.operationId, action: "keep_uncertain" as const, reason: "provider cannot establish the outcome", providerEvidence: { lookup: "inconclusive" } };
  expect(await reconcileRelease(admin, keepRequest, provider, "keep-uncertain-stable")).toMatchObject({ state: "uncertain" });
  expect(await reconcileRelease(admin, keepRequest, provider, "keep-uncertain-stable")).toMatchObject({ state: "uncertain" });
  await expect(reconcileRelease(admin, { ...keepRequest, reason: "changed reason" }, provider, "keep-uncertain-stable")).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(rows(await database.execute(sql`SELECT reconciliation_id FROM factory_release_reconciliations WHERE operation_id=${held.operationId}`))).toHaveLength(1);

  const absent = await prepareRelease(admin, request("no-effect")); const absentApproval = await approved(absent); const absentClaim = await releases.claim(admin, projectId, absent.operationId, { kind: "approval", approvalId: absentApproval });
  provider.loseResponse = true; await releases.dispatch(absentClaim, provider); provider.loseResponse = false;
  const evidence = { operationId: absent.operationId };
  await expect(reconcileRelease(admin, { projectId, operationId: absent.operationId, action: "confirm_no_effect", reason: "lookup found no object", providerEvidence: evidence }, provider)).rejects.toMatchObject({ code: "factory_release_absence_unproved" });
  sender.stopped = true; provider.noEffect = true;
  const absenceRequest = { projectId, operationId: absent.operationId, action: "confirm_no_effect" as const, reason: "sender stopped and lookup found no object", providerEvidence: evidence };
  const proofsBefore = [sender.proofCalls, provider.proofCalls, archive.writes];
  const reopened = await reconcileRelease(admin, absenceRequest, provider, "absence-proof-stable");
  expect(reopened).toMatchObject({ state: "pending", dispatchGeneration: 1, outcomeCode: "confirmed_no_effect" });
  expect(await reconcileRelease(admin, absenceRequest, provider, "absence-proof-stable")).toEqual(reopened);
  expect([sender.proofCalls, provider.proofCalls, archive.writes]).toEqual([proofsBefore[0]! + 1, proofsBefore[1]! + 1, proofsBefore[2]! + 1]);
  await expect(releases.claim(admin, projectId, absent.operationId, { kind: "approval", approvalId: absentApproval })).rejects.toThrow();
  const freshApproval = await approved(reopened); await expect(releases.claim(admin, projectId, reopened.operationId, { kind: "approval", approvalId: freshApproval })).resolves.toMatchObject({ dispatchGeneration: 2 });
  sender.stopped = false; provider.noEffect = false;
});

test("transactional audit failure rolls claim and policy counters back", async () => {
  const operation = await prepareRelease(service, request("audit-policy"));
  await createReleasePolicy(admin, { projectId, policyId: "policy-audit", principal: service, action: "publish", destinationProvider: "fixture", destinationAccount: "account-a", destinationPrefix: "releases/audit", contractDigest: digest("f"), revision: 1, maxOperations: 1, maxSpendMicros: 5, expiresAtMs: now + 5_000 });
  await database.execute(sql`CREATE FUNCTION reject_release_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='factory.release.claimed' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
  await database.execute(sql`CREATE TRIGGER reject_release_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_release_audit()`);
  await expect(releases.claim(service, projectId, operation.operationId, { kind: "policy", policyId: "policy-audit", expectedRevision: 1 })).rejects.toThrow();
  await database.execute(sql`DROP TRIGGER reject_release_audit ON audit_log`); await database.execute(sql`DROP FUNCTION reject_release_audit()`);
  expect(await releases.inspect(projectId, operation.operationId)).toMatchObject({ state: "pending", dispatchGeneration: 0 });
  expect(rows<{ used_operations: number | string }>(await database.execute(sql`SELECT used_operations FROM factory_release_policies WHERE policy_id='policy-audit'`)).map(row => Number(row.used_operations))).toEqual([0]);
});

test("tampered pinned operation facts fail closed before provider dispatch", async () => {
  const operation = await prepareRelease(admin, request("tamper")); const approval = await approved(operation);
  await database.execute(sql`UPDATE factory_release_operations SET canonical_request=${JSON.stringify({ provider: "fixture", request: { body: "forged" } })} WHERE operation_id=${operation.operationId}`);
  await expect(releases.claim(admin, projectId, operation.operationId, { kind: "approval", approvalId: approval })).rejects.toMatchObject({ code: "factory_release_corrupt" });
});
}
