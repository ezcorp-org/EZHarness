import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { FileBlobStore } from "../../extensions/v4/blobs";
import type { BlobStore } from "../../extensions/v4/types";
import {
  FACTORY_ARCHIVE_MANIFEST_SCHEMA_VERSION,
  FactoryArchiveRecovery,
  FactoryArchiveWriter,
  factoryArchiveFailureDomain,
  factoryArchivePublicationSet,
} from "../../factory/archive-writer";
import { FactoryArtifacts } from "../../factory/artifacts";
import { FactoryAttemptMaterials, FactoryScopedMaterials, factoryMaterialDigest, type FactoryMaterialScope } from "../../factory/artifact-materials";
import { FactoryAssurance, type FactoryCandidateKey, type FactoryCurrentCandidateResolver, type FactoryReleaseFenceReader, type FactoryTrustedEvidence, type FactoryTrustedValidatorGateway } from "../../factory/assurance";
import { EncryptedBlobStore, InstallationDataKey, StaticMasterKeyProvider, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../../factory/encryption";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryRecords } from "../../factory/records";
import { FactoryReleases, type FactoryDestinationReservationReader, type FactoryProviderReceipt, type FactoryReleaseAuthority, type FactoryReleaseAuthorityReader, type FactoryReleaseClaim, type FactoryReleaseMaterial, type FactoryReleaseMaterialReader, type FactoryReleaseOperation, type FactoryReleaseProvider } from "../../factory/releases";
import { FaultInjectingArchive, MemoryFactoryReleaseArchive, type FactoryArchiveStore } from "./factory-archive-fixtures";

export interface FactoryArchiveWriterFixture {
  readonly db: TransactionalDb;
  /** The real producer supplies the ordinary S3 store that holds material bytes. */
  readonly blobs?: BlobStore;
  /** The real producer supplies the separately credentialed archive service. */
  readonly archive?: FactoryArchiveStore;
  close(): Promise<void>;
}

const TENANT = "archive-tenant";
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;

/** Records what the broker sent so a recovery can be proved to send nothing. */
class RecordingProvider implements FactoryReleaseProvider {
  publishes = 0;
  verifications = 0;
  productStoreDown = false;
  loseResponse = false;
  readonly receipts = new Map<string, FactoryProviderReceipt>();
  async publish(claim: FactoryReleaseClaim): Promise<FactoryProviderReceipt> {
    this.publishes += 1;
    const receipt: FactoryProviderReceipt = {
      provider: claim.destination.provider, account: claim.destination.account, object: claim.destination.object,
      requestDigest: claim.requestDigest, operationId: claim.operationId, dispatchGeneration: claim.dispatchGeneration,
      providerReceiptId: `receipt-${claim.operationId}-${claim.dispatchGeneration}`, version: `v${claim.dispatchGeneration}`, effectDigest: digest("f"),
    };
    this.receipts.set(`${claim.operationId}:${claim.dispatchGeneration}`, receipt);
    if (this.loseResponse) throw new Error("provider response lost after the write");
    return receipt;
  }
  async verifyReceipt(operation: FactoryReleaseOperation, receipt: FactoryProviderReceipt): Promise<boolean> {
    this.verifications += 1;
    if (this.productStoreDown) throw new Error("the ordinary object store is unreachable");
    return canonicalJson(this.receipts.get(`${operation.operationId}:${operation.dispatchGeneration}`) ?? null) === canonicalJson(receipt);
  }
  async proveNoEffect(): Promise<boolean> { return false; }
}

export function factoryArchiveWriterConformance(create: () => Promise<FactoryArchiveWriterFixture>): void {
describe("C04 archive before claim and receipt before settlement", () => {
const fixtures: FactoryArchiveWriterFixture[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const fixture = await create();
  fixtures.push(fixture);
  const db = fixture.db;
  const suffix = randomUUID();
  const projectId = `archive-project-${suffix}`;
  const runId = `archive-run-${suffix}`;
  const attemptId = `archive-attempt-${suffix}`;
  const nodeInstanceId = "release-node";
  const admin: FactoryPrincipal = { kind: "user", id: `archive-admin-${suffix}`, authentication: "session" };
  const now = Date.now();
  const deadlineMs = now + 600_000;
  const candidate: FactoryCandidateKey = { projectId, runId, nodeInstanceId, candidateGeneration: 1 };

  const records = new FactoryRecords(db, TENANT);
  await records.bindInstallation();
  await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Archive',${`/tmp/${projectId}`})`);
  await records.bindProject(projectId);
  await db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${admin.id},${`${admin.id}@example.test`},'x','archive','admin')`);
  await db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES (${`member-${suffix}`},${projectId},${admin.id},'owner')`);
  const installationEpoch = Number(rows<{ execution_epoch: number | string }>(await db.execute(sql`SELECT execution_epoch FROM factory_installation WHERE singleton=1`))[0]!.execution_epoch);
  await records.createRun({ projectId, runId, definitionDigest: digest("d"), interpreterBuild: "v1", executionEpoch: installationEpoch, input: {}, principalId: admin.id }, async () => {});

  const attempt: FactoryAttemptAuthority = {
    attemptId, tenantId: TENANT, projectId, runId, nodeInstanceId, candidateGeneration: 0, attemptNumber: 1,
    grantRevision: 1, reservationGeneration: 1, executionEpoch: installationEpoch, cancellationEpoch: 0,
    requestDigest: "a".repeat(64), deadlineAt: new Date(deadlineMs),
  };
  await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status)
    VALUES (${attempt.attemptId},${TENANT},${projectId},${runId},${nodeInstanceId},0,1,1,1,${installationEpoch},0,${attempt.deadlineAt},${attempt.requestDigest},'{}'::jsonb,'admitted')`);

  const root = await mkdtemp(join(tmpdir(), "factory-archive-"));
  directories.push(root);
  const wraps: InstallationKeyWrap[] = [];
  const wrapStore: InstallationKeyWrapStore = { async load() { return wraps; }, async save(value) { wraps.push(value); } };
  const key = await InstallationDataKey.loadOrCreate("archive-installation", wrapStore, new StaticMasterKeyProvider({ id: "operator", bytes: new Uint8Array(32).fill(5) }));
  const inner = fixture.blobs ?? new FileBlobStore(root);
  const blobs = new EncryptedBlobStore(inner, key, TENANT);
  const artifacts = new FactoryArtifacts(db, blobs, TENANT);
  const journal = new FactoryExecutionJournal(db, async () => {});
  const attemptMaterials = new FactoryAttemptMaterials({ database: db, artifacts, blobs, journal, authority: attempt });
  const reader = new FactoryScopedMaterials({ database: db, artifacts, blobs });
  const scope: FactoryMaterialScope = { tenantId: TENANT, projectId, runId, attemptId, operationId: `${runId}:${nodeInstanceId}:0:0` };

  /** Seals one material and returns the reference a release member plan names. */
  const storeMaterial = async (objectName: string, text: string): Promise<FactoryArtifactReference> => {
    const content = new TextEncoder().encode(text);
    const identity = { ...scope, objectName, version: 1 };
    await attemptMaterials.begin(identity, "application/json", content.byteLength, 1);
    await attemptMaterials.writeChunk(identity, { index: 0, digest: factoryMaterialDigest(content), encodedBytes: content.byteLength }, content);
    return attemptMaterials.seal(identity, factoryMaterialDigest(content));
  };
  const members = {
    candidate: { reference: await storeMaterial("candidate.json", '{"member":"candidate"}'), bytes: '{"member":"candidate"}' },
    request: { reference: await storeMaterial("request.json", '{"member":"request"}'), bytes: '{"member":"request"}' },
    evidence: { reference: await storeMaterial("evidence.json", '{"member":"evidence"}'), bytes: '{"member":"evidence"}' },
  };

  const grants = new FactoryGrants(db, TENANT, () => Date.now());
  for (const action of ["factory.trust", "factory.approve", "factory.release", "factory.operate"] as const) {
    await grants.set(admin, { projectId, principal: admin, action, expectedRevision: 0, expiresAtMs: null });
  }

  const trusted: FactoryTrustedEvidence = {
    ...candidate, validatorId: "validator", validatorLockDigest: digest("c"), issuerGrantRevision: 1, candidateDigest: digest("c"),
    artifact: members.evidence.reference, environmentDigest: digest("e"), configurationDigest: digest("d"), runnerDigest: digest("e"),
    claims: [{ id: "passed", verdict: "PASS" as const, decisive: true }], issuedAtMs: Date.now() - 1, expiresAtMs: deadlineMs,
  };
  class Gateway implements FactoryTrustedValidatorGateway, FactoryCurrentCandidateResolver {
    async assertContractInTransaction(): Promise<void> {}
    async resolveValidatorInTransaction(): Promise<FactoryTrustedEvidence> { return structuredClone(trusted); }
    async resolveCurrentEvidenceInTransaction(): Promise<readonly FactoryTrustedEvidence[]> { return [structuredClone(trusted)]; }
  }
  class RunFence implements FactoryReleaseFenceReader {
    async readCurrentInTransaction() { return { runId, executionEpoch: installationEpoch, cancellationEpoch: 0, status: "running" as const, deadlineMs }; }
  }
  const gateway = new Gateway();
  const assurance = new FactoryAssurance(db, TENANT, grants, gateway, new RunFence(), gateway, () => Date.now());
  await assurance.approveContract(admin, { projectId, contractId: "contract", revision: 1, contractDigest: digest("f"), validatorLockDigest: trusted.validatorLockDigest, mandatoryClaims: [{ id: "passed", validatorId: trusted.validatorId, freshnessMs: 600_000 }], claimGroups: [{ id: "all", claimIds: ["passed"], minimumPasses: 1, requireAllDecisive: true }] }, `contract-${suffix}`);
  await assurance.captureEvidence({ ...candidate, validatorId: trusted.validatorId });
  const decisionId = (await assurance.accept({ ...candidate, contractId: "contract", revision: 1 })).decisionId;

  const releaseMaterial: FactoryReleaseMaterial = { decisionId, evidence: [{ artifact: members.evidence.reference, candidateDigest: trusted.candidateDigest }], packageTrustDigest: digest("a"), validatorTrustDigest: digest("b") };
  const materials: FactoryReleaseMaterialReader = { async readPinnedInTransaction() { return releaseMaterial; } };
  class Authority implements FactoryReleaseAuthorityReader {
    async lockCurrentInTransaction(): Promise<FactoryReleaseAuthority> {
      return { ...candidate, candidateDigest: trusted.candidateDigest, executionEpoch: installationEpoch, cancellationEpoch: 0, releaseEnableEpoch: 1, deadlineMs, status: "running", packageTrustDigest: digest("a"), validatorTrustDigest: digest("b") };
    }
  }
  class Destination implements FactoryDestinationReservationReader {
    async reserveInTransaction() { return { currentVersion: null }; }
  }

  const store = fixture.archive ?? new MemoryFactoryReleaseArchive();
  const archive = new FaultInjectingArchive(store);
  const writer = new FactoryArchiveWriter({
    archive, reader, inventory: archive,
    publicationSet: factoryArchivePublicationSet(() => ({ scope, candidate: members.candidate.reference, request: members.request.reference })),
    failureDomain: factoryArchiveFailureDomain({ productEndpoint: "http://127.0.0.1:18333", archiveEndpoint: "http://127.0.0.1:18334", productCredentialSet: "ordinary.json", archiveCredentialSet: "archive.json" }),
    denialProbe: { async attempt() { return "denied"; } },
  });
  const releases = new FactoryReleases(db, TENANT, grants, assurance, materials, new Authority(), new Destination(), writer, { async proveStopped() { return false; } }, () => Date.now());
  const provider = new RecordingProvider();
  const recovery = new FactoryArchiveRecovery({ releases, writer, operator: admin });

  let sequence = 0;
  const mutationKey = (kind: string) => `${kind}-${suffix}-${++sequence}`;
  const request = (label: string) => ({ ...candidate, decisionId, candidateDigest: trusted.candidateDigest, action: "publish", destination: { provider: "fixture", account: "account-a", object: `releases/${label}` }, request: { body: label }, estimatedSpendMicros: 5, deadlineMs: now + 300_000 });
  const prepare = (label: string, idempotencyKey = mutationKey("prepare")) => releases.prepare(admin, request(label), idempotencyKey);
  const claim = async (operation: FactoryReleaseOperation) => {
    const approval = await assurance.requestApproval(admin, { projectId, operationId: operation.operationId, decisionId, destinationDigest: operation.destinationDigest, expectedGeneration: operation.dispatchGeneration + 1, expiresAtMs: operation.deadlineMs }, mutationKey("approval"));
    await assurance.decideApproval(admin, projectId, approval.approvalId, approval.contextDigest, true, mutationKey("decision"));
    return releases.claim(admin, projectId, operation.operationId, { kind: "approval", approvalId: approval.approvalId });
  };
  const stateOf = async (label: string) => rows<{ state: string; archive_ready: boolean }>(await db.execute(sql`SELECT state,archive_ready FROM factory_release_operations WHERE tenant_id=${TENANT} AND destination_object=${`releases/${label}`}`))[0];
  /** The outbox kinds this operation has enqueued, in order. */
  const notificationKinds = async (operationId: string) => rows<{ deduplication_id: string; created_at: Date }>(
    await db.execute(sql`SELECT deduplication_id,created_at FROM factory_notifications WHERE tenant_id=${TENANT} AND deduplication_id LIKE ${`%:${operationId}:%`} ORDER BY created_at,deduplication_id`),
  ).map(row => row.deduplication_id.split(":")[0]!);
  const rejectAudit = async (action: string) => {
    await db.execute(sql.raw(`CREATE FUNCTION reject_${action.replaceAll(".", "_")}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER reject_${action.replaceAll(".", "_")} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_${action.replaceAll(".", "_")}()`));
    return async () => {
      await db.execute(sql.raw(`DROP TRIGGER reject_${action.replaceAll(".", "_")} ON audit_log`));
      await db.execute(sql.raw(`DROP FUNCTION reject_${action.replaceAll(".", "_")}()`));
    };
  };

  return { db, admin, projectId, scope, members, reader, archive, store, writer, releases, provider, recovery, prepare, claim, stateOf, notificationKinds, rejectAudit, mutationKey, attemptMaterials, blobs };
}

async function manifestFor(world: Awaited<ReturnType<typeof setup>>, operation: FactoryReleaseOperation) {
  const manifest = await world.writer.readManifest(operation.materialArchive!, operation.materialDigest);
  expect(manifest.schemaVersion).toBe(FACTORY_ARCHIVE_MANIFEST_SCHEMA_VERSION);
  return manifest;
}

test("the archive holds every referenced member before a dispatch claim is possible", async () => {
  const world = await setup();
  const operation = await world.prepare("complete");
  expect(operation).toMatchObject({ state: "pending", archiveReady: true });

  const manifest = await manifestFor(world, operation);
  expect(manifest.members.map(member => [member.role, member.memberName])).toEqual([
    ["candidate", "candidate"], ["request", "request"], ["evidence", `evidence/${world.members.evidence.reference.artifactId}`],
  ]);
  for (const member of manifest.members) {
    const archived = await world.writer.read(member.object);
    expect(new TextDecoder().decode(archived)).toBe(new TextDecoder().decode(await world.reader.read(world.scope, member.artifact)));
  }
  // The intent is archived and readable too, and it pins the exact material.
  expect(JSON.parse(new TextDecoder().decode(await world.writer.read(operation.intentArchive!))).materialDigest).toBe(operation.materialDigest);

  const claimed = await world.claim(operation);
  expect(claimed).toMatchObject({ state: "executing", dispatchStarted: false });
});

test("publication stays pending while a member is unavailable, and resumes when it returns", async () => {
  const world = await setup();
  const evidenceId = world.members.evidence.reference.artifactId;
  const removed = rows<{ chunk_digest: string; blob_digest: string; storage_version: string; encoded_bytes: number | string }>(
    await world.db.execute(sql`DELETE FROM factory_artifact_material_chunks WHERE tenant_id=${TENANT} AND object_name='evidence.json' RETURNING chunk_digest,blob_digest,storage_version,encoded_bytes`));
  expect(removed).toHaveLength(1);

  await expect(world.prepare("member-gone", "member-gone-key")).rejects.toThrow("factory_archive_member_unavailable");
  expect(await world.stateOf("member-gone")).toEqual({ state: "pending", archive_ready: false });
  const operationId = rows<{ operation_id: string }>(await world.db.execute(sql`SELECT operation_id FROM factory_release_operations WHERE tenant_id=${TENANT} AND destination_object='releases/member-gone'`))[0]!.operation_id;
  // The archive prerequisite is checked before any consent is consumed, so the
  // claim is refused whatever authority the caller presents.
  await expect(world.releases.claim(world.admin, world.projectId, operationId, { kind: "approval", approvalId: "never-issued" })).rejects.toThrow("factory_release_not_claimable");
  await expect(world.reader.read(world.scope, world.members.evidence.reference)).rejects.toThrow("factory_artifact_unavailable");

  const chunk = removed[0]!;
  await world.db.execute(sql`INSERT INTO factory_artifact_material_chunks(tenant_id,project_id,run_id,attempt_id,operation_id,object_name,version,chunk_index,chunk_digest,encoded_bytes,blob_digest,storage_version)
    VALUES (${TENANT},${world.scope.projectId},${world.scope.runId},${world.scope.attemptId},${world.scope.operationId},'evidence.json',1,0,${chunk.chunk_digest},${Number(chunk.encoded_bytes)},${chunk.blob_digest},${chunk.storage_version})`);
  const recovered = await world.prepare("member-gone", "member-gone-key");
  expect(recovered).toMatchObject({ archiveReady: true });
  expect((await manifestFor(world, recovered)).members.some(member => member.artifact.artifactId === evidenceId)).toBe(true);
  expect(await world.claim(recovered)).toMatchObject({ state: "executing" });
});

test("publication stays pending while an archived member reads back different bytes", async () => {
  const world = await setup();
  world.archive.corruptReadFor = '{"member":"candidate"}';
  await expect(world.prepare("member-corrupt", "member-corrupt-key")).rejects.toThrow("factory_archive_member_corrupt");
  expect(await world.stateOf("member-corrupt")).toEqual({ state: "pending", archive_ready: false });

  world.archive.corruptReadFor = undefined;
  const repaired = await world.prepare("member-corrupt", "member-corrupt-key");
  expect(repaired.archiveReady).toBe(true);
});

test("a crash at each archive boundary before the claim recovers by identity", async () => {
  const world = await setup();
  /** Runs one attempt and reports exactly how many objects reached the archive. */
  const attempt = async (fault: string | undefined) => {
    const before = world.archive.writes.length;
    world.archive.failWriteFor = fault;
    const outcome = await world.prepare("boundaries", "boundaries-key").then(() => "prepared" as const, (error: Error) => error.message);
    expect(await world.stateOf("boundaries")).toEqual(fault === undefined && outcome === "prepared" ? { state: "pending", archive_ready: true } : { state: "pending", archive_ready: false });
    return { outcome, archived: world.archive.writes.length - before };
  };

  // The candidate member fails, so only the recovery intent reached the archive.
  expect(await attempt('{"member":"candidate"}')).toEqual({ outcome: "archive unavailable", archived: 1 });
  // The manifest fails after all three members landed.
  expect(await attempt(FACTORY_ARCHIVE_MANIFEST_SCHEMA_VERSION)).toEqual({ outcome: "archive unavailable", archived: 4 });
  // The material object fails after the manifest landed.
  expect(await attempt('"packageTrustDigest"')).toEqual({ outcome: "archive unavailable", archived: 5 });

  // The process dies after every archive write but before the product row commits.
  const restore = await world.rejectAudit("factory.release.archived");
  const crashed = await attempt(undefined);
  expect(crashed.archived).toBe(6);
  expect(crashed.outcome).not.toBe("prepared");
  const archivedBefore = new Set(world.archive.writes);
  await restore();

  expect(await attempt(undefined)).toEqual({ outcome: "prepared", archived: 6 });
  const operation = (await world.releases.inspect(world.projectId, rows<{ operation_id: string }>(await world.db.execute(sql`SELECT operation_id FROM factory_release_operations WHERE tenant_id=${TENANT} AND destination_object='releases/boundaries'`))[0]!.operation_id))!;
  expect(operation.archiveReady).toBe(true);
  // The retry reuses every immutable object it already wrote; nothing new appears.
  expect([...new Set(world.archive.writes)]).toEqual([...archivedBefore]);
  expect((await manifestFor(world, operation)).members).toHaveLength(3);
  expect(await world.claim(operation)).toMatchObject({ state: "executing" });
});

test("the confirmed receipt reaches the archive before the product row, and recovery settles it by identity", async () => {
  const world = await setup();
  const operation = await world.prepare("receipt-first");
  const claimed = await world.claim(operation);

  // The provider write is confirmed and archived, then the settlement crashes.
  const restore = await world.rejectAudit("factory.release.receipt.confirmed");
  const uncertain = await world.releases.dispatch(claimed, world.provider);
  expect(uncertain).toMatchObject({ state: "uncertain", outcomeCode: "receipt_archive_unknown" });
  expect(uncertain.receipt).toBeUndefined();
  expect(world.provider.publishes).toBe(1);
  await restore();

  // The receipt survives in the archive even though no product row records it.
  const archived = await world.writer.readArchivedReceipt(uncertain);
  expect(archived).toEqual(world.provider.receipts.get(`${operation.operationId}:${uncertain.dispatchGeneration}`)!);

  // Orchestration was not told either: the archive precedes the outbox, not only the row.
  expect(await world.notificationKinds(operation.operationId)).toEqual(["release_uncertain"]);

  // The ordinary store is unreachable, so settlement waits rather than guessing.
  world.provider.productStoreDown = true;
  await expect(world.recovery.recover(world.projectId, operation.operationId, world.provider, world.mutationKey("recover"))).rejects.toThrow("unreachable");
  expect(await world.writer.readArchivedReceipt(uncertain)).toEqual(archived!);
  expect((await world.releases.inspect(world.projectId, operation.operationId))!.state).toBe("uncertain");

  world.provider.productStoreDown = false;
  const outcome = await world.recovery.recover(world.projectId, operation.operationId, world.provider, world.mutationKey("recover"));
  expect(outcome.kind).toBe("settled_from_archive");
  expect(outcome.operation).toMatchObject({ state: "succeeded", receipt: archived! });
  expect(world.provider.publishes).toBe(1);
  expect(await world.notificationKinds(operation.operationId)).toEqual(["release_uncertain", "release_settled"]);

  // Recovering the settled operation again is a no-op, not a second effect.
  expect(await world.recovery.recover(world.projectId, operation.operationId, world.provider, world.mutationKey("recover"))).toMatchObject({ kind: "already_settled" });
  expect(world.provider.publishes).toBe(1);
});

test("a crash between the provider effect and the receipt archive keeps the operation uncertain", async () => {
  const world = await setup();
  const operation = await world.prepare("receipt-archive-lost");
  const claimed = await world.claim(operation);

  world.archive.failWriteFor = "providerReceiptId";
  const uncertain = await world.releases.dispatch(claimed, world.provider);
  expect(uncertain).toMatchObject({ state: "uncertain", outcomeCode: "receipt_archive_unknown" });
  expect(world.provider.publishes).toBe(1);
  world.archive.failWriteFor = undefined;

  // Nothing is in the archive to settle from, so recovery refuses rather than inventing one.
  expect(await world.recovery.recover(world.projectId, operation.operationId, world.provider, world.mutationKey("recover"))).toMatchObject({ kind: "no_archived_receipt" });
  expect(world.provider.publishes).toBe(1);

  // A second dispatch under the fenced claim is refused; the operator reconciles instead.
  await expect(world.releases.dispatch(claimed, world.provider)).rejects.toThrow("factory_release_sender_fenced");
  expect(world.provider.publishes).toBe(1);
  const settled = await world.releases.reconcile(world.admin, {
    projectId: world.projectId, operationId: operation.operationId, action: "attach_receipt",
    reason: "the provider object was verified by hand", providerEvidence: { lookup: true },
    receipt: world.provider.receipts.get(`${operation.operationId}:${uncertain.dispatchGeneration}`)!,
  }, uncertain.dispatchGeneration, world.provider, world.mutationKey("reconcile"));
  expect(settled.state).toBe("succeeded");
  expect(await world.writer.readArchivedReceipt(settled)).toEqual(settled.receipt!);
});

test("a lost provider response leaves one effect and no archived receipt to settle", async () => {
  const world = await setup();
  const operation = await world.prepare("lost-response");
  const claimed = await world.claim(operation);
  world.provider.loseResponse = true;
  const uncertain = await world.releases.dispatch(claimed, world.provider);
  expect(uncertain).toMatchObject({ state: "uncertain", outcomeCode: "provider_response_unknown" });
  expect(world.provider.publishes).toBe(1);
  expect(await world.writer.readArchivedReceipt(uncertain)).toBeNull();
  expect(await world.recovery.recover(world.projectId, operation.operationId, world.provider, world.mutationKey("recover"))).toMatchObject({ kind: "no_archived_receipt" });
  expect(world.provider.publishes).toBe(1);
});

test("an archived receipt from another generation cannot settle this one", async () => {
  const world = await setup();
  const operation = await world.prepare("foreign-receipt");
  const claimed = await world.claim(operation);
  const restore = await world.rejectAudit("factory.release.receipt.confirmed");
  const uncertain = await world.releases.dispatch(claimed, world.provider);
  await restore();
  const confirmed = world.provider.receipts.get(`${operation.operationId}:${uncertain.dispatchGeneration}`)!;

  for (const foreign of [
    { ...confirmed, dispatchGeneration: confirmed.dispatchGeneration + 1 },
    { ...confirmed, operationId: `factory-release:${"9".repeat(64)}` },
    { ...confirmed, requestDigest: digest("9") },
    { ...confirmed, object: "releases/elsewhere" },
    { ...confirmed, account: "account-b" },
    { ...confirmed, provider: "other" },
  ]) {
    await world.archive.writeImmutable(TENANT, operation.operationId, "receipt", new TextEncoder().encode(canonicalJson(foreign)));
  }
  // The one matching receipt is still the only one recovery will use.
  expect(await world.writer.readArchivedReceipt(uncertain)).toEqual(confirmed);
  const outcome = await world.recovery.recover(world.projectId, operation.operationId, world.provider, world.mutationKey("recover"));
  expect(outcome).toMatchObject({ kind: "settled_from_archive", receipt: confirmed });
});

test("two concurrent preparations archive one member set and leave one claimable operation", async () => {
  const world = await setup();
  const [left, right] = await Promise.all([world.prepare("concurrent", "concurrent-left"), world.prepare("concurrent", "concurrent-right")]);
  expect(left.operationId).toBe(right.operationId);
  expect([left.archiveReady, right.archiveReady]).toEqual([true, true]);
  expect(left.intentArchive).toEqual(right.intentArchive!);
  expect(left.materialArchive).toEqual(right.materialArchive!);

  // Both attempts wrote, and every write landed on the same six immutable objects.
  const keys = world.archive.writes.filter(key => key.includes(`/${Buffer.from(left.operationId).toString("base64url")}/`));
  expect(keys.length).toBeGreaterThan(6);
  expect(new Set(keys).size).toBe(6);
  expect((await manifestFor(world, left)).members).toHaveLength(3);
  expect(await world.claim(left)).toMatchObject({ state: "executing" });
});

test("the archive-writer role reports readiness and never claims an independent failure domain here", async () => {
  const world = await setup();
  const readiness = await world.writer.checkReadiness(TENANT, `factory-release:${"b".repeat(64)}`);
  expect(readiness).toMatchObject({ ready: true, publicationGrade: false });
  expect(readiness.failureDomain.failureDomain).toBe("same-host-not-independent");
  expect(readiness.unmetCriteria).toEqual(["deployed-independent-failure-domain"]);
  expect(await world.writer.proveIndependentOfProductStore({ async reachable() { return true; } }, TENANT, "factory-release:probe")).toMatchObject({ passed: false });
});
});
}
