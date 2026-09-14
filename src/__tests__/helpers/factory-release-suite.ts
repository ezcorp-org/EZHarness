import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";
import { up as addFactoryReleases } from "../../db/migrations/add-factory-releases";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { FactoryAssurance, type FactoryCandidateKey, type FactoryCurrentCandidateResolver, type FactoryReleaseFenceReader, type FactoryTrustedEvidence, type FactoryTrustedValidatorGateway } from "../../factory/assurance";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryRecords } from "../../factory/records";
import { FactoryNotificationDelivery } from "../../factory/notification-delivery";
import { FactoryReleaseApplication } from "../../factory/release-application";
import { digestObject } from "../../extensions/v4/blobs";
import { FACTORY_GITHUB_BASE_FILES, FACTORY_GITHUB_CANDIDATE_FILES, FACTORY_GITHUB_IDENTITY, FactoryGitHubFake, factoryGitHubPublicationFixture } from "./factory-github-fake";
import { FactoryGitHubReleaseProvider } from "../../factory/release-github";
import { FactoryDestinationReservations, FactoryStoreSenderFence } from "../../factory/release-destinations";
import { FACTORY_RELEASE_RESOLVE_TIMEOUT_MS, sealFactoryReleaseProfileResult } from "../../factory/release-profile";
import { factoryRequestedReleaseProfile, FactoryReleases, type FactoryArchiveObject, type FactoryDestinationReservationReader, type FactoryProviderReceipt, type FactoryReleaseArchive, type FactoryReleaseAuthority, type FactoryReleaseAuthorityReader, type FactoryReleaseClaim, type FactoryReleaseMaterialReader, type FactoryReleaseOperation, type FactoryReleaseProvider, type FactoryReleaseRequest, type FactorySenderFence } from "../../factory/releases";
import { FACTORY_BRANCH_NAMESPACE, FACTORY_BRANCH_REF_PREFIX, factoryGitBranchBinding, factoryOperationIdFromRef } from "../../factory/release-git-refs";
import { unboundFactoryValidatorBinders } from "./factory-validator-binders";

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
let materials: FactoryReleaseMaterialReader;
let decisionId: string;
let fenceStatus: FactoryReleaseAuthority["status"] = "running";
const releaseEnableEpoch = 4;
let destinationVersion: string | null = null;
let trusted: FactoryTrustedEvidence;
/** The pinned material a profile resolves against. Changing it must invalidate a sealed result. */
let materialEvidence: readonly unknown[] = [];

class Gateway implements FactoryTrustedValidatorGateway, FactoryCurrentCandidateResolver {
  async assertContractInTransaction(): Promise<void> {}
  bindAttemptInTransaction = unboundFactoryValidatorBinders.bindAttemptInTransaction;
  bindTaskAttemptInTransaction = unboundFactoryValidatorBinders.bindTaskAttemptInTransaction;
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
  /** A git provider that forgets the ref it created, or names a different one. */
  gitRef: "exact" | "omitted" | "other" = "exact";
  receipts = new Map<string, FactoryProviderReceipt>();
  async publish(claim: FactoryReleaseClaim): Promise<FactoryProviderReceipt> {
    this.calls += 1;
    const git = !claim.destinationRef || this.gitRef === "omitted" ? {}
      : this.gitRef === "other" ? { ref: `${FACTORY_BRANCH_REF_PREFIX}other`, branch: `${FACTORY_BRANCH_NAMESPACE}/other` }
      : { ref: claim.destinationRef, branch: claim.destinationBranch! };
    const receipt = { provider: claim.destination.provider, account: claim.destination.account, object: claim.destination.object, requestDigest: claim.requestDigest, operationId: claim.operationId, dispatchGeneration: claim.dispatchGeneration, providerReceiptId: `receipt-${claim.operationId}`, version: `v${claim.dispatchGeneration}`, effectDigest: digest("f"), ...git };
    this.receipts.set(claim.operationId, receipt);
    if (this.loseResponse) throw new Error("response lost after write");
    return receipt;
  }
  async verifyReceipt(operation: FactoryReleaseOperation, receipt: FactoryProviderReceipt) { return canonicalJson(this.receipts.get(operation.operationId) ?? null) === canonicalJson(receipt); }
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
/**
 * Every preparation carries a sealed profile result. This suite already knows the exact request it
 * wants, so the identity profile is the honest one: the resolve still runs outside every
 * transaction and the seal still binds the acceptance decision and the pinned material.
 */
const prepareRelease = async (actor: FactoryPrincipal, input: FactoryReleaseRequest, idempotencyKey = mutationKey("prepare"), store: FactoryReleases = releases) => {
  const preparation = await store.resolvePreparation({
    projectId: input.projectId, runId: input.runId, nodeInstanceId: input.nodeInstanceId, candidateGeneration: input.candidateGeneration,
    decisionId: input.decisionId, candidateDigest: input.candidateDigest,
    acceptedManifest: { candidate: input.candidateDigest }, requestedDestination: { ...input.destination }, deadlineMs: input.deadlineMs,
  }, factoryRequestedReleaseProfile(input, () => now), new AbortController().signal);
  return store.prepare(actor, preparation, idempotencyKey);
};
const createReleasePolicy = (actor: FactoryPrincipal, policy: Parameters<FactoryReleases["createPolicy"]>[1], idempotencyKey = mutationKey("policy-create")) => releases.createPolicy(actor, policy, idempotencyKey);
const revokeReleasePolicy = (actor: FactoryPrincipal, currentProjectId: string, policyId: string, expectedRevision: number, idempotencyKey = mutationKey("policy-revoke")) => releases.revokePolicy(actor, currentProjectId, policyId, expectedRevision, idempotencyKey);
const requestReleaseApproval = async (actor: FactoryPrincipal, currentProjectId: string, operationId: string, expiresAtMs: number, idempotencyKey = mutationKey("approval-request")) => {
  const operation = await releases.inspect(currentProjectId, operationId);
  return releases.requestApproval(actor, currentProjectId, operationId, expiresAtMs, operation?.dispatchGeneration ?? 0, idempotencyKey);
};
const reconcileRelease = async (actor: FactoryPrincipal, input: Parameters<FactoryReleases["reconcile"]>[1], currentProvider: FactoryReleaseProvider, idempotencyKey = mutationKey("reconcile")) => {
  const operation = await releases.inspect(input.projectId, input.operationId);
  return releases.reconcile(actor, input, operation?.dispatchGeneration ?? 1, currentProvider, idempotencyKey);
};

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
  trusted = { ...candidate, validatorId: "validator", validatorLockDigest: digest("c"), issuerGrantRevision: 1, candidateDigest: digest("c"), artifact: { artifactId: "artifact", digest: digest("a"), encodedBytes: 10 }, environmentDigest: digest("e"), configurationDigest: digest("d"), runnerDigest: digest("e"), claims: [{ id: "passed", verdict: "PASS" as const, decisive: true }], issuedAtMs: now - 1, expiresAtMs: now + 10_000 };
  materialEvidence = [{ artifact: trusted.artifact, candidateDigest: trusted.candidateDigest }];
  const gateway = new Gateway();
  assurance = new FactoryAssurance(database, tenantId, grants, gateway, new RunFence(), gateway, () => now);
  await assurance.approveContract(admin, { projectId, contractId: "contract", revision: 1, contractDigest: digest("f"), validatorLockDigest: trusted.validatorLockDigest, mandatoryClaims: [{ id: "passed", validatorId: trusted.validatorId, freshnessMs: 100 }], claimGroups: [{ id: "all", claimIds: ["passed"], minimumPasses: 1, requireAllDecisive: true }] }, mutationKey("contract"));
  await assurance.captureEvidence({ ...candidate, validatorId: trusted.validatorId });
  decisionId = (await assurance.accept({ ...candidate, contractId: "contract", revision: 1 })).decisionId;
  materials = { async readPinnedInTransaction(_transaction, tenant, accepted) { if (tenant !== tenantId || accepted.decisionId !== decisionId) throw new Error("material scope"); return { decisionId, evidence: materialEvidence, packageTrustDigest: digest("a"), validatorTrustDigest: digest("b") }; } };
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
  // The pinned-decision read refuses a foreign node before any profile resolves, so no request
  // bytes are ever produced for it.
  await expect(prepareRelease(admin, request("foreign-node", { nodeInstanceId: "another-release-node" }))).rejects.toMatchObject({ code: "factory_assurance_stale" });
  expect(rows(await database.execute(sql`SELECT operation_id FROM factory_release_operations WHERE destination_object='releases/foreign-node'`))).toEqual([]);

  // And a preparation resolved for the real node cannot be re-aimed: the canonical lifecycle lock
  // is taken for the node the request names, inside the product transaction.
  const genuine = request("foreign-node-reaimed");
  const preparation = await releases.resolvePreparation({
    projectId: genuine.projectId, runId: genuine.runId, nodeInstanceId: genuine.nodeInstanceId, candidateGeneration: genuine.candidateGeneration,
    decisionId: genuine.decisionId, candidateDigest: genuine.candidateDigest,
    acceptedManifest: { candidate: genuine.candidateDigest }, requestedDestination: { ...genuine.destination }, deadlineMs: genuine.deadlineMs,
  }, factoryRequestedReleaseProfile(genuine, () => now), new AbortController().signal);
  await expect(releases.prepare(admin, { ...preparation, request: { ...preparation.request, nodeInstanceId: "another-release-node" } }, mutationKey("prepare-reaimed"))).rejects.toThrow("canonical lifecycle lock mismatch");
  expect(rows(await database.execute(sql`SELECT operation_id FROM factory_release_operations WHERE destination_object='releases/foreign-node-reaimed'`))).toEqual([]);
});

test("approval request and its human notification commit together once", async () => {
  const operation = await prepareRelease(admin, request("approval-notification"));
  const approvalKey = "release-approval-stable";
  const approval = await requestReleaseApproval(admin, projectId, operation.operationId, now + 1_000, approvalKey);
  expect(await requestReleaseApproval(admin, projectId, operation.operationId, now + 1_000, approvalKey)).toEqual(approval);
  await expect(requestReleaseApproval(admin, projectId, operation.operationId, now + 999, approvalKey)).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(releases.requestApproval(admin, projectId, operation.operationId, now + 1_000, 1, mutationKey("approval-stale-generation"))).rejects.toMatchObject({ code: "factory_release_not_claimable" });
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

test("durable release notifications form one current-authorized human inbox", async () => {
  const reviewer: FactoryPrincipal = { kind: "user", id: "release-reviewer", authentication: "session" };
  await database.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${reviewer.id},'release-reviewer@example.test','x','reviewer','member')`);
  await database.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('release-reviewer-member',${projectId},${reviewer.id},'member')`);
  for (const action of ["factory.approve", "factory.operate", "factory.release"] as const) await grants.set(admin, { projectId, principal: reviewer, action, expectedRevision: 0, expiresAtMs: null });
  const approvalOperation = await prepareRelease(admin, request("human-inbox-approval"));
  const approval = await requestReleaseApproval(admin, projectId, approvalOperation.operationId, now + 1_000);

  const uncertainOperation = await prepareRelease(admin, request("human-inbox-uncertain"));
  const uncertainApproval = await approved(uncertainOperation);
  const uncertainClaim = await releases.claim(admin, projectId, uncertainOperation.operationId, { kind: "approval", approvalId: uncertainApproval });
  provider.loseResponse = true;
  await releases.dispatch(uncertainClaim, provider);
  provider.loseResponse = false;

  const settledOperation = await prepareRelease(admin, request("human-inbox-settled"));
  const settledApproval = await approved(settledOperation);
  const settledClaim = await releases.claim(admin, projectId, settledOperation.operationId, { kind: "approval", approvalId: settledApproval });
  await releases.dispatch(settledClaim, provider);

  const delivery = new FactoryNotificationDelivery(releases);
  while (await delivery.deliverNext(projectId)) {}
  const firstPage = await delivery.listForHuman(reviewer, projectId, { limit: 2 });
  expect(firstPage.items).toHaveLength(2);
  expect(firstPage.nextCursor).not.toBeNull();
  const secondPage = await delivery.listForHuman(reviewer, projectId, { limit: 200, cursor: firstPage.nextCursor! });
  const visible = [...firstPage.items, ...secondPage.items];
  expect(visible).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "approval_requested", operationId: approvalOperation.operationId, approvalId: approval.approvalId, contextDigest: approval.contextDigest }),
    expect.objectContaining({ kind: "release_uncertain", operationId: uncertainOperation.operationId, dispatchGeneration: 1, outcomeCode: "provider_response_unknown" }),
    expect.objectContaining({ kind: "release_settled", operationId: settledOperation.operationId, dispatchGeneration: 1 }),
  ]));

  const restarted = new FactoryNotificationDelivery(releases);
  expect(await restarted.deliverNext(projectId)).toBeNull();
  const replay = await restarted.listForHuman(reviewer, projectId, { limit: 200 });
  expect(new Set(replay.items.map(item => item.notificationId)).size).toBe(replay.items.length);
  for (const target of [approvalOperation, uncertainOperation, settledOperation]) {
    expect(replay.items.filter(item => item.kind !== "command_approval_requested" && item.operationId === target.operationId)).toHaveLength(1);
  }

  await database.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES ('release-foreign','foreign-release@example.test','x','foreign','user')`);
  const foreign = { kind: "user", id: "release-foreign", authentication: "session" } as const;
  expect(await restarted.listForHuman(foreign, projectId, { limit: 200 })).toEqual({ items: [], nextCursor: null });
  expect(await restarted.listForHuman({ ...admin, authentication: "api-key" }, projectId, { limit: 200 })).toEqual({ items: [], nextCursor: null });
  const application = new FactoryReleaseApplication(tenantId, grants, assurance, releases, { resolve: () => provider });
  await expect(application.decideApproval(foreign, projectId, approval.approvalId, { contextDigest: approval.contextDigest, decision: "approved" }, 0, mutationKey("foreign-inbox-decision"))).rejects.toThrow("factory_forbidden");

  await grants.revoke(admin, { projectId, principal: reviewer, action: "factory.release", expectedRevision: 1 });
  let scoped = await restarted.listForHuman(reviewer, projectId, { limit: 200 });
  expect(scoped.items.some(item => item.kind !== "command_approval_requested" && item.operationId === settledOperation.operationId)).toBe(false);
  expect(scoped.items.some(item => item.kind !== "command_approval_requested" && item.operationId === approvalOperation.operationId)).toBe(true);
  await grants.set(admin, { projectId, principal: reviewer, action: "factory.release", expectedRevision: 2, expiresAtMs: null });

  await grants.revoke(admin, { projectId, principal: reviewer, action: "factory.operate", expectedRevision: 1 });
  scoped = await restarted.listForHuman(reviewer, projectId, { limit: 200 });
  expect(scoped.items.some(item => item.kind !== "command_approval_requested" && item.operationId === uncertainOperation.operationId)).toBe(false);
  expect(scoped.items.some(item => item.kind !== "command_approval_requested" && item.operationId === settledOperation.operationId)).toBe(true);
  await grants.set(admin, { projectId, principal: reviewer, action: "factory.operate", expectedRevision: 2, expiresAtMs: null });

  await grants.revoke(admin, { projectId, principal: reviewer, action: "factory.approve", expectedRevision: 1 });
  scoped = await restarted.listForHuman(reviewer, projectId, { limit: 200 });
  expect(scoped.items.some(item => item.kind !== "command_approval_requested" && item.operationId === approvalOperation.operationId)).toBe(false);
  await expect(application.decideApproval(reviewer, projectId, approval.approvalId, { contextDigest: approval.contextDigest, decision: "approved" }, 0, mutationKey("revoked-inbox-decision"))).rejects.toThrow("factory_forbidden");
  await grants.set(admin, { projectId, principal: reviewer, action: "factory.approve", expectedRevision: 2, expiresAtMs: null });

  await application.decideApproval(reviewer, projectId, approval.approvalId, { contextDigest: approval.contextDigest, decision: "approved" }, 0, mutationKey("inbox-decision"));
  expect((await restarted.listForHuman(reviewer, projectId, { limit: 200 })).items.some(item => item.kind !== "command_approval_requested" && item.operationId === approvalOperation.operationId)).toBe(false);

  const sealed = rows<{ notification_id: string; input_hash: string }>(await database.execute(sql`SELECT notification_id,input_hash FROM factory_notifications WHERE payload::jsonb->>'operationId'=${settledOperation.operationId}`))[0]!;
  await database.execute(sql`UPDATE factory_notifications SET input_hash=${digest("0")} WHERE notification_id=${sealed.notification_id}`);
  await expect(restarted.listForHuman(reviewer, projectId, { limit: 200 })).rejects.toMatchObject({ code: "factory_notification_corrupt" });
  await database.execute(sql`UPDATE factory_notifications SET input_hash=${sealed.input_hash} WHERE notification_id=${sealed.notification_id}`);
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
  await expect(releases.reconcile(admin, { projectId, operationId: attach.operationId, action: "attach_receipt", reason: "stale generation", providerEvidence: { lookup: true }, receipt }, attachClaim.dispatchGeneration + 1, provider, mutationKey("reconcile-stale-generation"))).rejects.toMatchObject({ code: "factory_release_reconciliation_stale" });
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

test("an operator cannot attach a fabricated matching receipt without a provider-verified effect", async () => {
  const operation = await prepareRelease(admin, request("forged-provider-receipt"));
  const approvalId = await approved(operation);
  const claim = await releases.claim(admin, projectId, operation.operationId, { kind: "approval", approvalId });
  provider.loseResponse = true; await releases.dispatch(claim, provider); provider.loseResponse = false;
  const receipt = provider.receipts.get(operation.operationId)!;
  const writes = archive.writes;
  await expect(reconcileRelease(admin, {
    projectId, operationId: operation.operationId, action: "attach_receipt", reason: "operator supplied a receipt that the provider did not issue",
    providerEvidence: { lookup: true }, receipt: { ...receipt, version: "fabricated-version", providerReceiptId: "fabricated-provider-receipt" },
  }, provider)).rejects.toMatchObject({ code: "factory_release_receipt_unverified" });
  expect(await releases.inspect(projectId, operation.operationId)).toMatchObject({ state: "uncertain" });
  expect(archive.writes).toBe(writes);
});

test("reconciliation proof calls are transaction-bounded and abortable", async () => {
  const uncertain = await prepareRelease(admin, request("proof-timeout")); const approvalId = await approved(uncertain); const claim = await releases.claim(admin, projectId, uncertain.operationId, { kind: "approval", approvalId });
  provider.loseResponse = true; await releases.dispatch(claim, provider); provider.loseResponse = false;
  const never = () => new Promise<boolean>(() => {});
  const bounded = new FactoryReleases(database, tenantId, grants, assurance, materials, authority, new Destination(), archive, { proveStopped: never }, () => now, 1);
  await expect(bounded.reconcile(admin, { projectId, operationId: uncertain.operationId, action: "confirm_no_effect", reason: "proof service did not answer", providerEvidence: { operationId: uncertain.operationId } }, claim.dispatchGeneration, { publish: provider.publish.bind(provider), verifyReceipt: provider.verifyReceipt.bind(provider), proveNoEffect: never }, mutationKey("proof-timeout"))).rejects.toMatchObject({ code: "factory_release_reconciliation_timeout" });
  expect(await releases.inspect(projectId, uncertain.operationId)).toMatchObject({ state: "uncertain" });
  let receiptSignal: AbortSignal | undefined;
  const writes = archive.writes;
  await expect(bounded.reconcile(admin, { projectId, operationId: uncertain.operationId, action: "attach_receipt", reason: "receipt lookup did not answer", providerEvidence: { operationId: uncertain.operationId }, receipt: provider.receipts.get(uncertain.operationId)! }, claim.dispatchGeneration, {
    publish: provider.publish.bind(provider), proveNoEffect: provider.proveNoEffect.bind(provider),
    verifyReceipt: async (_operation, _receipt, _evidence, signal) => { receiptSignal = signal; return never(); },
  }, mutationKey("receipt-proof-timeout"))).rejects.toMatchObject({ code: "factory_release_reconciliation_timeout" });
  expect(receiptSignal?.aborted).toBe(true);
  expect(archive.writes).toBe(writes);
  expect(await releases.inspect(projectId, uncertain.operationId)).toMatchObject({ state: "uncertain" });
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

test("a sealed profile is resolved outside every transaction and revalidated against the pinned input", async () => {
  const resolution = (input: FactoryReleaseRequest) => ({
    projectId: input.projectId, runId: input.runId, nodeInstanceId: input.nodeInstanceId, candidateGeneration: input.candidateGeneration,
    decisionId: input.decisionId, candidateDigest: input.candidateDigest,
    acceptedManifest: { candidate: input.candidateDigest }, requestedDestination: { ...input.destination }, deadlineMs: input.deadlineMs,
  });

  const accepted = request("profile-seal");
  const sealed = await releases.resolvePreparation(resolution(accepted), factoryRequestedReleaseProfile(accepted, () => now), new AbortController().signal);
  expect(sealed.profile).toMatchObject({ schemaVersion: "factory.release-profile-result.v1", resolvedAtMs: now, destination: accepted.destination, estimatedSpendMicros: accepted.estimatedSpendMicros });
  expect(sealed.profileInput).toMatchObject({ tenantId, projectId, runId: candidate.runId, acceptedManifest: { candidate: accepted.candidateDigest } });
  const operation = await releases.prepare(admin, sealed, mutationKey("profile-seal"));
  expect(operation).toMatchObject({ profileInputDigest: sealed.profile.inputDigest, profileResultDigest: sealed.profile.resultDigest, profileResolvedAtMs: now });
  // PGlite decodes a bigint as a number and the real driver as a string, so normalize.
  expect(rows<{ profile_input_digest: string; profile_result_digest: string; profile_resolved_at_ms: number | string }>(await database.execute(sql`SELECT profile_input_digest,profile_result_digest,profile_resolved_at_ms FROM factory_release_operations WHERE operation_id=${operation.operationId}`))
    .map(row => ({ ...row, profile_resolved_at_ms: Number(row.profile_resolved_at_ms) }))).toEqual([
    { profile_input_digest: sealed.profile.inputDigest, profile_result_digest: sealed.profile.resultDigest, profile_resolved_at_ms: now },
  ]);

  // The pinned material moved after the resolve, so the sealed result no longer describes it.
  const drifting = request("profile-drift");
  const stale = await releases.resolvePreparation(resolution(drifting), factoryRequestedReleaseProfile(drifting, () => now), new AbortController().signal);
  const original = materialEvidence;
  materialEvidence = [{ artifact: trusted.artifact, candidateDigest: trusted.candidateDigest }, { note: "a second evidence reference the resolve never saw" }];
  const writes = archive.writes;
  await expect(releases.prepare(admin, stale, mutationKey("profile-drift"))).rejects.toMatchObject({ code: "factory_release_profile_stale" });
  materialEvidence = original;
  expect(rows(await database.execute(sql`SELECT operation_id FROM factory_release_operations WHERE destination_object='releases/profile-drift'`))).toEqual([]);
  expect(archive.writes).toBe(writes);

  // A result older than the resolve timeout is unusable; re-resolve rather than reuse. The resolve
  // refuses it as it returns, and `prepare` refuses it again if one reaches the transaction.
  const aged = request("profile-aged");
  await expect(releases.resolvePreparation(resolution(aged), factoryRequestedReleaseProfile(aged, () => now - FACTORY_RELEASE_RESOLVE_TIMEOUT_MS - 1), new AbortController().signal)).rejects.toMatchObject({ code: "factory_release_profile_stale" });
  const fresh = await releases.resolvePreparation(resolution(aged), factoryRequestedReleaseProfile(aged, () => now), new AbortController().signal);
  const agedPreparation = { ...fresh, profile: sealFactoryReleaseProfileResult(fresh.profileInput, fresh.profile, now - FACTORY_RELEASE_RESOLVE_TIMEOUT_MS - 1) };
  await expect(releases.prepare(admin, agedPreparation, mutationKey("profile-aged"))).rejects.toMatchObject({ code: "factory_release_profile_stale" });
  expect(rows(await database.execute(sql`SELECT operation_id FROM factory_release_operations WHERE destination_object='releases/profile-aged'`))).toEqual([]);

  // A forged seal is invalid, not merely stale.
  const forged = request("profile-forged");
  const forgedPreparation = await releases.resolvePreparation(resolution(forged), factoryRequestedReleaseProfile(forged, () => now), new AbortController().signal);
  await expect(releases.prepare(admin, { ...forgedPreparation, profile: { ...forgedPreparation.profile, estimatedSpendMicros: forged.estimatedSpendMicros + 1 } }, mutationKey("profile-forged"))).rejects.toMatchObject({ code: "factory_release_profile_invalid" });

  // An aborted resolve produces no operation row and no archive object.
  const abandoned = request("profile-aborted");
  const controller = new AbortController(); controller.abort();
  const before = archive.writes;
  await expect(releases.resolvePreparation(resolution(abandoned), factoryRequestedReleaseProfile(abandoned, () => now), controller.signal)).rejects.toMatchObject({ code: "factory_release_profile_aborted" });
  expect(rows(await database.execute(sql`SELECT operation_id FROM factory_release_operations WHERE destination_object='releases/profile-aborted'`))).toEqual([]);
  expect(archive.writes).toBe(before);

  // An operation that lost its seal cannot be claimed, and the database refuses the same row.
  const unsealed = await prepareRelease(admin, request("profile-unsealed"));
  const approval = await approved(unsealed);
  await database.execute(sql`UPDATE factory_release_operations SET profile_input_digest=NULL,profile_result_digest=NULL,profile_resolved_at_ms=NULL WHERE operation_id=${unsealed.operationId}`);
  await expect(releases.claim(admin, projectId, unsealed.operationId, { kind: "approval", approvalId: approval })).rejects.toMatchObject({ code: "factory_release_profile_stale" });
  const forcedClaim = await database.execute(sql`UPDATE factory_release_operations SET state='executing' WHERE operation_id=${unsealed.operationId}`).then(() => null, (error: unknown) => error);
  expect(forcedClaim).toBeInstanceOf(Error);
  expect(rows<{ state: string }>(await database.execute(sql`SELECT state FROM factory_release_operations WHERE operation_id=${unsealed.operationId}`))).toEqual([{ state: "pending" }]);
});

test("the claimable scan lists only operations a claim could take, oldest deadline first", async () => {
  const claimable = async () => (await database.transaction(transaction => releases.listClaimableInTransaction(transaction, projectId, 1000))).map(item => item.operationId);
  const first = await prepareRelease(admin, request("scan-first", { deadlineMs: now + 1_000 }));
  const second = await prepareRelease(admin, request("scan-second", { deadlineMs: now + 2_000 }));
  const listed = await claimable();
  expect(listed.indexOf(first.operationId)).toBeLessThan(listed.indexOf(second.operationId));
  expect(listed).toContain(second.operationId);

  // Claiming removes it; an expired deadline and a missing archive never appear.
  await releases.claim(admin, projectId, first.operationId, { kind: "approval", approvalId: await approved(first) });
  expect(await claimable()).not.toContain(first.operationId);
  await database.execute(sql`UPDATE factory_release_operations SET deadline_ms=${now} WHERE operation_id=${second.operationId}`);
  expect(await claimable()).not.toContain(second.operationId);
  await database.execute(sql`UPDATE factory_release_operations SET deadline_ms=${now + 2_000},archive_ready=FALSE WHERE operation_id=${second.operationId}`);
  expect(await claimable()).not.toContain(second.operationId);
  await database.execute(sql`UPDATE factory_release_operations SET archive_ready=TRUE WHERE operation_id=${second.operationId}`);
  expect(await claimable()).toContain(second.operationId);

  // The scan is bounded and its bound is checked.
  expect(await database.transaction(transaction => releases.listClaimableInTransaction(transaction, projectId, 1))).toHaveLength(1);
  await expect(database.transaction(transaction => releases.listClaimableInTransaction(transaction, projectId, 1001))).rejects.toMatchObject({ code: "factory_release_invalid" });
  await expect(database.transaction(transaction => releases.listClaimableInTransaction(transaction, projectId, 0))).rejects.toMatchObject({ code: "factory_release_invalid" });
  expect(await database.transaction(transaction => releases.listClaimableInTransaction(transaction, "another-project"))).toEqual([]);
});

test("no provider proof and no archive write happens inside an open transaction", async () => {
  // Freeze correction 1. The counter wraps the release store's own database handle, so "inside a
  // transaction" is a fact this test observes rather than a claim about the code.
  const depth = { current: 0, max: 0 };
  const tracked: TransactionalDb = {
    execute: query => database.execute(query),
    transaction: async work => {
      depth.current += 1; depth.max = Math.max(depth.max, depth.current);
      try { return await database.transaction(work); } finally { depth.current -= 1; }
    },
  };
  const seen: { at: string; depth: number }[] = [];
  const note = <Result>(at: string, call: () => Promise<Result>): Promise<Result> => { seen.push({ at, depth: depth.current }); return call(); };
  const watchedArchive: FactoryReleaseArchive = {
    writeImmutable: (tenant, operationId, name, bytes) => note(`archive.write:${name}`, () => archive.writeImmutable(tenant, operationId, name, bytes)),
    read: reference => note("archive.read", () => archive.read(reference)),
  };
  const watchedProvider: FactoryReleaseProvider = {
    publish: claim => note("provider.publish", () => provider.publish(claim)),
    verifyReceipt: (operation, receipt) => note("provider.verifyReceipt", () => provider.verifyReceipt(operation, receipt)),
    proveNoEffect: (operation, evidence) => note("provider.proveNoEffect", () => provider.proveNoEffect(operation, evidence)),
  };
  const watchedFence: FactorySenderFence = { proveStopped: (operation, token, evidence) => note("fence.proveStopped", () => sender.proveStopped(operation, token, evidence)) };
  const split = new FactoryReleases(tracked, tenantId, grants, assurance, materials, authority, new Destination(), watchedArchive, watchedFence, () => now);

  const attach = await prepareRelease(admin, request("split-attach"), mutationKey("split-prepare"), split);
  const attachClaim = await split.claim(admin, projectId, attach.operationId, { kind: "approval", approvalId: await approved(attach) });
  provider.loseResponse = true;
  expect(await split.dispatch(attachClaim, watchedProvider)).toMatchObject({ state: "uncertain" });
  provider.loseResponse = false;
  expect(await split.reconcile(admin, { projectId, operationId: attach.operationId, action: "attach_receipt", reason: "provider lookup verified the exact version", providerEvidence: { lookup: true }, receipt: provider.receipts.get(attach.operationId)! }, attachClaim.dispatchGeneration, watchedProvider, mutationKey("split-attach-reconcile"))).toMatchObject({ state: "succeeded" });

  const absent = await prepareRelease(admin, request("split-absent"), mutationKey("split-prepare-absent"), split);
  const absentClaim = await split.claim(admin, projectId, absent.operationId, { kind: "approval", approvalId: await approved(absent) });
  provider.loseResponse = true;
  await split.dispatch(absentClaim, watchedProvider);
  provider.loseResponse = false;
  sender.stopped = true; provider.noEffect = true;
  expect(await split.reconcile(admin, { projectId, operationId: absent.operationId, action: "confirm_no_effect", reason: "sender stopped and lookup found no object", providerEvidence: { operationId: absent.operationId } }, absentClaim.dispatchGeneration, watchedProvider, mutationKey("split-absence"))).toMatchObject({ state: "pending", outcomeCode: "confirmed_no_effect" });
  sender.stopped = false; provider.noEffect = false;

  // Every external and archive call ran at depth zero, and the store really did open transactions.
  expect(seen.filter(entry => entry.depth !== 0)).toEqual([]);
  expect(depth.max).toBeGreaterThanOrEqual(1);
  expect(new Set(seen.map(entry => entry.at))).toEqual(new Set([
    "archive.write:intent", "archive.write:material", "archive.write:receipt", "archive.write:reconciliation", "archive.read",
    "provider.publish", "provider.verifyReceipt", "provider.proveNoEffect", "fence.proveStopped",
  ]));
});

test("the production destination reservation and sender fence answer from durable facts only", async () => {
  const reservations = new FactoryDestinationReservations({ database, tenantId });
  const fence = new FactoryStoreSenderFence({ database, tenantId, quietPeriodMs: 60_000 });
  const store = new FactoryReleases(database, tenantId, grants, assurance, materials, authority, reservations, archive, fence, () => now);
  const destination = { provider: "fixture", account: "account-a", object: "releases/durable-destination" };

  // Nothing has published here, so the destination reports no version and a first claim may take it.
  const first = await prepareRelease(admin, request("durable-first", { destination }), mutationKey("durable-first"), store);
  expect(await database.transaction(transaction => reservations.reserveInTransaction(transaction, tenantId, first))).toEqual({ currentVersion: null });
  const claim = await store.claim(admin, projectId, first.operationId, { kind: "approval", approvalId: await approved(first) });
  const settled = await store.dispatch(claim, provider);
  expect(settled).toMatchObject({ state: "succeeded" });

  // After the confirmed receipt the version is the provider's own, read from the receipt the
  // platform stored rather than from the remote system.
  expect(await database.transaction(transaction => reservations.reserveInTransaction(transaction, tenantId, first))).toEqual({ currentVersion: settled.receipt!.version });
  await expect(database.transaction(transaction => reservations.reserveInTransaction(transaction, "foreign-tenant", first))).rejects.toMatchObject({ code: "factory_release_scope" });
  await expect(database.transaction(transaction => reservations.reserveInTransaction(transaction, tenantId, { ...first, tenantId: "foreign-tenant" }))).rejects.toMatchObject({ code: "factory_release_scope" });

  // A second operation aimed at the same object sees that version, so a claim declaring none fails.
  const second = await prepareRelease(admin, request("durable-second", { destination, nodeInstanceId: candidate.nodeInstanceId, action: "publish-again" }), mutationKey("durable-second"), store);
  await expect(store.claim(admin, projectId, second.operationId, { kind: "approval", approvalId: await approved(second) })).rejects.toMatchObject({ code: "factory_release_destination_changed" });

  // A corrupt stored receipt is corruption, not a version.
  await database.execute(sql`UPDATE factory_release_operations SET receipt_json='not json' WHERE operation_id=${first.operationId}`);
  await expect(database.transaction(transaction => reservations.reserveInTransaction(transaction, tenantId, first))).rejects.toMatchObject({ code: "factory_release_corrupt" });
  await database.execute(sql`UPDATE factory_release_operations SET receipt_json=${canonicalJson({ ...settled.receipt!, object: "another-object" })} WHERE operation_id=${first.operationId}`);
  await expect(database.transaction(transaction => reservations.reserveInTransaction(transaction, tenantId, first))).rejects.toMatchObject({ code: "factory_release_corrupt" });
  await database.execute(sql`UPDATE factory_release_operations SET receipt_json=${canonicalJson({ ...settled.receipt!, version: "" })} WHERE operation_id=${first.operationId}`);
  await expect(database.transaction(transaction => reservations.reserveInTransaction(transaction, tenantId, first))).rejects.toMatchObject({ code: "factory_release_corrupt" });
  await database.execute(sql`UPDATE factory_release_operations SET receipt_json=${canonicalJson(settled.receipt!)} WHERE operation_id=${first.operationId}`);
  await database.execute(sql`UPDATE factory_release_destination_reservations SET state='released' WHERE operation_id=${first.operationId}`);
  expect(await database.transaction(transaction => reservations.reserveInTransaction(transaction, tenantId, first))).toEqual({ currentVersion: null });
  await database.execute(sql`UPDATE factory_release_destination_reservations SET state='confirmed' WHERE operation_id=${first.operationId}`);

  // The sender fence: an uncertain operation whose row was just written is not yet quiet.
  const lost = await prepareRelease(admin, request("durable-fence", { destination: { ...destination, object: "releases/durable-fence" } }), mutationKey("durable-fence"), store);
  const lostClaim = await store.claim(admin, projectId, lost.operationId, { kind: "approval", approvalId: await approved(lost) });
  provider.loseResponse = true;
  const uncertain = await store.dispatch(lostClaim, provider);
  provider.loseResponse = false;
  expect(uncertain).toMatchObject({ state: "uncertain" });
  const evidence = { operationId: lost.operationId };
  expect(await fence.proveStopped(uncertain, lostClaim.senderToken, evidence)).toBe(false);

  // Age the row past the quiet period and the same facts now prove the sender cannot send again.
  await database.execute(sql`UPDATE factory_release_operations SET updated_at=NOW() - INTERVAL '1 hour' WHERE operation_id=${lost.operationId}`);
  expect(await fence.proveStopped(uncertain, lostClaim.senderToken, evidence)).toBe(true);

  // Nothing an operator supplies can substitute for those facts.
  expect(await fence.proveStopped(uncertain, "another-token", evidence)).toBe(false);
  expect(await fence.proveStopped(uncertain, "", evidence)).toBe(false);
  expect(await fence.proveStopped(uncertain, lostClaim.senderToken, { operationId: "another-operation" })).toBe(false);
  expect(await fence.proveStopped(uncertain, lostClaim.senderToken, null)).toBe(false);
  expect(await fence.proveStopped(uncertain, lostClaim.senderToken, [evidence])).toBe(false);
  expect(await fence.proveStopped({ ...uncertain, dispatchGeneration: uncertain.dispatchGeneration + 1 }, lostClaim.senderToken, evidence)).toBe(false);
  expect(await fence.proveStopped({ ...uncertain, operationId: `factory-release:${"0".repeat(64)}` }, lostClaim.senderToken, evidence)).toBe(false);
  expect(await fence.proveStopped({ ...uncertain, senderToken: "another-token" }, "another-token", evidence)).toBe(false);
  await expect(fence.proveStopped({ ...uncertain, tenantId: "foreign-tenant" }, lostClaim.senderToken, evidence)).rejects.toMatchObject({ code: "factory_release_scope" });
  const aborted = new AbortController(); aborted.abort();
  await expect(fence.proveStopped(uncertain, lostClaim.senderToken, evidence, aborted.signal)).rejects.toBeInstanceOf(DOMException);

  // A settled operation has no sender to fence.
  await database.execute(sql`UPDATE factory_release_operations SET state='succeeded' WHERE operation_id=${lost.operationId}`);
  expect(await fence.proveStopped(uncertain, lostClaim.senderToken, evidence)).toBe(false);
  await database.execute(sql`UPDATE factory_release_operations SET state='uncertain',dispatch_started=FALSE WHERE operation_id=${lost.operationId}`);
  expect(await fence.proveStopped(uncertain, lostClaim.senderToken, evidence)).toBe(false);
  await database.execute(sql`UPDATE factory_release_operations SET dispatch_started=TRUE WHERE operation_id=${lost.operationId}`);

  expect(() => new FactoryStoreSenderFence({ database, tenantId, quietPeriodMs: 0 })).toThrow("factory_release_invalid");
  expect(new FactoryStoreSenderFence({ database, tenantId }).tenantId).toBe(tenantId);
  expect(new FactoryDestinationReservations({ database, tenantId }).tenantId).toBe(tenantId);
});

test("a git destination binds one broker-namespace ref and refuses a receipt naming another", async () => {
  const gitDestination = (object: string) => ({ provider: "github", account: "ezcorp-org/factory-platform-publication-tests", object });
  const operation = await prepareRelease(admin, request("git-branch", { destination: gitDestination("pull-request/git-branch") }));
  const binding = factoryGitBranchBinding(operation.operationId);
  expect(operation).toMatchObject({ destinationRef: binding.ref, destinationBranch: binding.branch });
  expect(binding.ref.startsWith(FACTORY_BRANCH_REF_PREFIX)).toBe(true);
  // The ref reverses to the operation with no lookup table, which is what reconciliation needs.
  expect(factoryOperationIdFromRef(binding.ref)).toBe(operation.operationId);
  expect(rows(await database.execute(sql`SELECT destination_ref,destination_branch FROM factory_release_operations WHERE operation_id=${operation.operationId}`))).toEqual([{ destination_ref: binding.ref, destination_branch: binding.branch }]);

  // A receipt that forgets the ref, or names another branch, never settles a git operation.
  for (const mode of ["omitted", "other"] as const) {
    const target = await prepareRelease(admin, request(`git-${mode}`, { destination: gitDestination(`pull-request/git-${mode}`) }));
    const approval = await approved(target);
    const claim = await releases.claim(admin, projectId, target.operationId, { kind: "approval", approvalId: approval });
    provider.gitRef = mode;
    expect([mode, await releases.dispatch(claim, provider)]).toMatchObject([mode, { state: "uncertain", outcomeCode: "receipt_archive_unknown" }]);
  }
  provider.gitRef = "exact";

  const approval = await approved(operation);
  const claim = await releases.claim(admin, projectId, operation.operationId, { kind: "approval", approvalId: approval });
  expect(claim).toMatchObject({ destinationRef: binding.ref, destinationBranch: binding.branch });
  const settled = await releases.dispatch(claim, provider);
  expect(settled).toMatchObject({ state: "succeeded", receipt: { ref: binding.ref, branch: binding.branch } });

  // A destination that is not a git destination carries no ref at all.
  const objectStore = await prepareRelease(admin, request("no-branch"));
  expect(objectStore.destinationRef).toBeUndefined();
  expect(objectStore.destinationBranch).toBeUndefined();

  // A redirected or invented ref is corruption, not a different branch.
  const foreign = await prepareRelease(admin, request("git-tamper", { destination: gitDestination("pull-request/git-tamper") }));
  await database.execute(sql`UPDATE factory_release_operations SET destination_ref=${`${FACTORY_BRANCH_REF_PREFIX}other`},destination_branch=${`${FACTORY_BRANCH_NAMESPACE}/other`} WHERE operation_id=${foreign.operationId}`);
  await expect(releases.inspect(projectId, foreign.operationId)).rejects.toMatchObject({ code: "factory_release_corrupt" });
  await database.execute(sql`UPDATE factory_release_operations SET destination_ref=${`${FACTORY_BRANCH_REF_PREFIX}x`},destination_branch=NULL WHERE operation_id=${foreign.operationId}`).then(() => null, (error: unknown) => error);
  await database.execute(sql`UPDATE factory_release_operations SET destination_ref=${binding.ref},destination_branch=${binding.branch} WHERE operation_id=${objectStore.operationId}`);
  await expect(releases.inspect(projectId, objectStore.operationId)).rejects.toMatchObject({ code: "factory_release_corrupt" });
  await database.execute(sql`UPDATE factory_release_operations SET destination_ref=NULL,destination_branch=NULL WHERE operation_id=${objectStore.operationId}`);
  const restored = await releases.inspect(projectId, objectStore.operationId);
  expect([restored?.state, restored?.destinationRef, restored?.destinationBranch]).toEqual(["pending", undefined, undefined]);
});

test("the F04 reconciliation matrix runs against the real GitHub adapter", async () => {
  const repositoryId = 1_368_432_892;
  const repository = "ezcorp-org/factory-platform-publication-tests";
  const server = new FactoryGitHubFake({ repository, repositoryId, baseBranch: "main", baseFiles: FACTORY_GITHUB_BASE_FILES, identity: FACTORY_GITHUB_IDENTITY });
  const github = new FactoryGitHubReleaseProvider({ repository, projectId, authorize: async () => {}, readToken: async () => "fixture-token", request: server.request });

  // The operation id is derived, so the publication request is built once the identity is known.
  const identityFor = (destinationObject: string) => ({ ...candidate, decisionId, candidateDigest: trusted.candidateDigest, action: "publish", destination: { provider: "github", account: repository, object: destinationObject } });
  const preparedFor = async (label: string) => {
    // Each label publishes its own candidate tree, so each has its own accepted commit and its own
    // destination object. Two operations aimed at one destination is a reservation conflict, which
    // the neighbouring durable-destination case already proves.
    const files = [...FACTORY_GITHUB_CANDIDATE_FILES, { path: `src/${label}.ts`, mode: "100644" as const, content: new TextEncoder().encode(`export const label = "${label}";\n`) }];
    const provisional = factoryGitHubPublicationFixture(server, `factory-release:${"0".repeat(64)}`, { repositoryId, baseBranch: "main", files });
    const destinationObject = `pull-request/main/${provisional.commitSha}`;
    const seed = { ...identityFor(destinationObject), request: {}, estimatedSpendMicros: 0, deadlineMs: now + 5_000, nodeInstanceId: candidate.nodeInstanceId, action: `publish:${label}` };
    const operationId = `factory-release:${digestObject({ projectId, runId: seed.runId, nodeInstanceId: seed.nodeInstanceId, candidateGeneration: seed.candidateGeneration, candidateDigest: seed.candidateDigest, action: seed.action, destination: seed.destination })}`;
    const request = factoryGitHubPublicationFixture(server, operationId, { repositoryId, baseBranch: "main", files });
    return { input: { ...seed, request } as FactoryReleaseRequest, operationId };
  };

  // A confirmed publication: one branch, one draft pull request, and a receipt naming both.
  const attach = await preparedFor("attach");
  const attachOperation = await prepareRelease(admin, attach.input, mutationKey("github-attach"));
  expect(attachOperation.operationId).toBe(attach.operationId);
  const attachClaim = await releases.claim(admin, projectId, attachOperation.operationId, { kind: "approval", approvalId: await approved(attachOperation) });
  archive.failWrite = true;
  const uncertain = await releases.dispatch(attachClaim, github);
  archive.failWrite = false;
  expect(uncertain).toMatchObject({ state: "uncertain", outcomeCode: "receipt_archive_unknown" });
  expect(server.pulls).toHaveLength(1);

  // The operator reads the provider for the receipt. The lookup sends no create of any kind, so
  // it can never produce a second effect.
  const writesBefore = server.calls.filter(call => call.method !== "GET").length;
  // The lookup is made against the operation as it stands now, so the receipt names its generation.
  const receipt = (await github.lookupReceipt(uncertain))!;
  expect(server.calls.filter(call => call.method !== "GET").length).toBe(writesBefore);
  expect(server.pulls).toHaveLength(1);
  expect(receipt).toMatchObject({ ref: attachOperation.destinationRef, branch: attachOperation.destinationBranch, version: attach.input.request && (attach.input.request as { commitSha: string }).commitSha });
  const settled = await reconcileRelease(admin, { projectId, operationId: attachOperation.operationId, action: "attach_receipt", reason: "the provider lookup found the exact draft pull request", providerEvidence: { lookup: true }, receipt }, github);
  expect(settled).toMatchObject({ state: "succeeded", receipt: { ref: attachOperation.destinationRef } });

  // Absence cannot be confirmed while the branch exists, however the operator words it.
  const absent = await preparedFor("absent");
  const absentOperation = await prepareRelease(admin, absent.input, mutationKey("github-absent"));
  const absentClaim = await releases.claim(admin, projectId, absentOperation.operationId, { kind: "approval", approvalId: await approved(absentOperation) });
  server.failNext = { method: "POST", pathIncludes: "/pulls", status: 500 };
  expect(await releases.dispatch(absentClaim, github)).toMatchObject({ state: "uncertain", outcomeCode: "provider_response_unknown" });
  sender.stopped = true;
  const absenceRequest = { projectId, operationId: absentOperation.operationId, action: "confirm_no_effect" as const, reason: "the operator believes nothing was created", providerEvidence: { operationId: absentOperation.operationId } };
  await expect(reconcileRelease(admin, absenceRequest, github)).rejects.toMatchObject({ code: "factory_release_absence_unproved" });

  // Keeping it uncertain is the honest outcome, and it consumes no new consent. The operation was
  // already uncertain, so it keeps the code its lost dispatch recorded rather than gaining one.
  const kept = await reconcileRelease(admin, { ...absenceRequest, action: "keep_uncertain", reason: "the branch exists and the pull request state is unknown" }, github);
  expect([kept.state, kept.outcomeCode]).toEqual(["uncertain", "provider_response_unknown"]);
  expect(rows(await database.execute(sql`SELECT reconciliation_id FROM factory_release_reconciliations WHERE operation_id=${absentOperation.operationId}`))).toHaveLength(1);
  sender.stopped = false;

  // An operation that never reached the provider proves absence and returns to pending, and the
  // approval its failed dispatch consumed cannot be reused for the next send.
  const unsent = await preparedFor("unsent");
  const unsentOperation = await prepareRelease(admin, unsent.input, mutationKey("github-unsent"));
  const unsentApproval = await approved(unsentOperation);
  const unsentClaim = await releases.claim(admin, projectId, unsentOperation.operationId, { kind: "approval", approvalId: unsentApproval });
  server.failNext = { method: "POST", pathIncludes: "/git/refs", status: 500 };
  expect(await releases.dispatch(unsentClaim, github)).toMatchObject({ state: "uncertain" });
  sender.stopped = true;
  const reopened = await reconcileRelease(admin, { projectId, operationId: unsentOperation.operationId, action: "confirm_no_effect", reason: "the ref was never created and no pull request names it", providerEvidence: { operationId: unsentOperation.operationId } }, github);
  expect(reopened).toMatchObject({ state: "pending", outcomeCode: "confirmed_no_effect" });
  sender.stopped = false;
  await expect(releases.claim(admin, projectId, unsentOperation.operationId, { kind: "approval", approvalId: unsentApproval })).rejects.toThrow();
  const freshApproval = await approved(reopened);
  await expect(releases.claim(admin, projectId, reopened.operationId, { kind: "approval", approvalId: freshApproval })).resolves.toMatchObject({ dispatchGeneration: 2 });
});

test("a principal without the release grant cannot claim, and no other path reaches the provider", async () => {
  // C04's broker-only rule at the product boundary: publication is a claim, and a claim needs the
  // `factory.release` grant. An ordinary runner principal and a wrapped legacy tool run under a
  // service identity that has task grants and no release grant.
  const runner: FactoryPrincipal = { kind: "service", id: "ordinary-runner", authentication: "service" };
  await database.execute(sql`INSERT INTO service_accounts(id,name,created_by_user_id,project_id,max_tokens_per_day,expires_at) VALUES (${runner.id},'Ordinary runner',${admin.id},${projectId},100,${new Date(now + 10_000)})`);
  await grants.set(admin, { projectId, principal: runner, action: "factory.operate", expectedRevision: 0, expiresAtMs: now + 5_000 });

  const operation = await prepareRelease(admin, request("runner-denied"));
  const approval = await approved(operation);
  const calls = provider.calls;
  await expect(releases.claim(runner, projectId, operation.operationId, { kind: "approval", approvalId: approval })).rejects.toThrow("factory_forbidden");
  // The approval survives a denied claim, and nothing reached the provider.
  expect(rows<{ status: string }>(await database.execute(sql`SELECT status FROM factory_release_approvals WHERE approval_id=${approval}`))).toEqual([{ status: "approved" }]);
  expect(provider.calls).toBe(calls);
  expect(await releases.inspect(projectId, operation.operationId)).toMatchObject({ state: "pending", dispatchGeneration: 0 });

  // A dispatch needs a claim, and a claim is the only thing that mints a sender token. A forged
  // one, at the right generation or the wrong one, is fenced before the provider is called.
  const forged = { ...operation, state: "executing" as const, senderToken: "forged", dispatchGeneration: 1, authority: { kind: "approval" as const, id: approval } };
  await expect(releases.dispatch(forged, provider)).rejects.toMatchObject({ code: "factory_release_sender_fenced" });
  await expect(releases.dispatch({ ...forged, dispatchGeneration: 0 }, provider)).rejects.toMatchObject({ code: "factory_release_sender_fenced" });
  expect(provider.calls).toBe(calls);
});

test("tampered pinned operation facts fail closed before provider dispatch", async () => {
  const operation = await prepareRelease(admin, request("tamper")); const approval = await approved(operation);
  await database.execute(sql`UPDATE factory_release_operations SET canonical_request=${JSON.stringify({ provider: "fixture", request: { body: "forged" } })} WHERE operation_id=${operation.operationId}`);
  await expect(releases.claim(admin, projectId, operation.operationId, { kind: "approval", approvalId: approval })).rejects.toMatchObject({ code: "factory_release_corrupt" });
});
}
