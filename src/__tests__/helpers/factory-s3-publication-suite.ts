import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { FactoryArtifactReference, JsonValue, RunnerReference } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { FileBlobStore, digestObject } from "../../extensions/v4/blobs";
import type { BlobStore } from "../../extensions/v4/types";
import { FactoryArchiveWriter, factoryArchiveFailureDomain } from "../../factory/archive-writer";
import { FactoryArtifacts } from "../../factory/artifacts";
import { FactoryAttemptMaterials, FactoryScopedMaterials, factoryMaterialDigest, type FactoryMaterialScope } from "../../factory/artifact-materials";
import { FactoryAssurance, type FactoryCandidateKey, type FactoryCurrentCandidateResolver, type FactoryReleaseFenceReader, type FactoryTrustedEvidence, type FactoryTrustedValidatorGateway } from "../../factory/assurance";
import { EncryptedBlobStore, InstallationDataKey, StaticMasterKeyProvider, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../../factory/encryption";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryRecords } from "../../factory/records";
import type { S3ClientLike } from "../../factory/release-adapters";
import { FACTORY_RELEASE_RESOLVE_TIMEOUT_MS } from "../../factory/release-profile";
import {
  FACTORY_S3_MANIFEST_NAME,
  FACTORY_S3_PUBLICATION_LIMITS,
  FACTORY_S3_PUBLICATION_RECEIPT_SCHEMA_VERSION,
  S3FactoryManifestReleaseProvider,
  factoryS3PublicationIdentity,
  type FactoryS3ManifestReceipt,
  type FactoryS3PublicationSetRequest,
} from "../../factory/release-s3-publication";
import {
  FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION,
  FactoryS3PublicationProvenance,
  S3FactoryManifestReleaseProfile,
  assertFactoryS3AcceptedPublication,
  assertFactoryS3RequestedDirectory,
  type FactoryS3AcceptedPublication,
} from "../../factory/release-s3-scope";
import { FactoryReleases, type FactoryDestinationReservationReader, type FactoryReleaseAuthority, type FactoryReleaseAuthorityReader, type FactoryReleaseMaterial, type FactoryReleaseMaterialReader, type FactoryReleaseOperation } from "../../factory/releases";
import { FaultInjectingArchive, MemoryFactoryReleaseArchive, type FactoryArchiveStore } from "./factory-archive-fixtures";
import { FactoryMemoryS3Store } from "./factory-s3-memory-store";
import { unboundFactoryValidatorBinders } from "./factory-validator-binders";

export interface FactoryS3PublicationFixture {
  readonly db: TransactionalDb;
  /** The real producer supplies the ordinary S3 store that holds material bytes. */
  readonly blobs?: BlobStore;
  /** The real producer supplies the separately credentialed archive service. */
  readonly archive?: FactoryArchiveStore;
  /** The real producer supplies a live S3 client and the tenant bucket it may write. */
  readonly s3?: { readonly client: S3ClientLike; readonly bucket: string; readonly prefix: string };
  /** Only the real producer runs the 256 MiB multipart export. */
  readonly large?: boolean;
  close(): Promise<void>;
}

const TENANT = "s3-publication-tenant";
const INTERPRETER = "interpreter-1";
const TASK_NODE = "produce-dataset";
const RELEASE_NODE = "publish-dataset";
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const ADAPTER: RunnerReference = { package: "@ezcorp/factory-s3-publisher", version: "1.0.0", digest: digest("a"), export: "publish" };
const bare = (letter: string) => letter.repeat(64);
const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const encoder = new TextEncoder();
const hash = (value: unknown) => `sha256:${digestObject(value)}`;

export function factoryS3PublicationConformance(create: () => Promise<FactoryS3PublicationFixture>): void {
describe("C04 S3 manifest publication and reconciliation", () => {
const fixtures: FactoryS3PublicationFixture[] = [];
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
  const projectId = `s3-project-${suffix}`;
  const runId = `s3-run-${suffix}`;
  const attemptId = `s3-attempt-${suffix}`;
  const taskCommandId = `command-${suffix}`;
  const materialOperationId = `${runId}:${TASK_NODE}:1:0`;
  const admin: FactoryPrincipal = { kind: "user", id: `s3-admin-${suffix}`, authentication: "session" };
  const now = Date.now();
  const deadlineMs = now + 900_000;
  const candidate: FactoryCandidateKey = { projectId, runId, nodeInstanceId: TASK_NODE, candidateGeneration: 1 };

  const records = new FactoryRecords(db, TENANT);
  await records.bindInstallation();
  await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'S3 publication',${`/tmp/${projectId}`})`);
  await records.bindProject(projectId);
  await db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${admin.id},${`${admin.id}@example.test`},'x','s3','admin')`);
  await db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES (${`member-${suffix}`},${projectId},${admin.id},'owner')`);
  const installationEpoch = Number(rows<{ execution_epoch: number | string }>(await db.execute(sql`SELECT execution_epoch FROM factory_installation WHERE singleton=1`))[0]!.execution_epoch);
  await records.createRun({ projectId, runId, definitionDigest: digest("d"), interpreterBuild: "v1", executionEpoch: installationEpoch, input: {}, principalId: admin.id }, async () => {});

  const attempt: FactoryAttemptAuthority = {
    attemptId, tenantId: TENANT, projectId, runId, nodeInstanceId: TASK_NODE, candidateGeneration: 1, attemptNumber: 1,
    grantRevision: 1, reservationGeneration: 1, executionEpoch: installationEpoch, cancellationEpoch: 0,
    requestDigest: bare("a"), deadlineAt: new Date(deadlineMs),
  };
  await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status)
    VALUES (${attemptId},${TENANT},${projectId},${runId},${TASK_NODE},1,1,1,1,${installationEpoch},0,${attempt.deadlineAt},${attempt.requestDigest},'{}'::jsonb,'admitted')`);

  const root = await mkdtemp(join(tmpdir(), "factory-s3-publication-"));
  directories.push(root);
  const wraps: InstallationKeyWrap[] = [];
  const wrapStore: InstallationKeyWrapStore = { async load() { return wraps; }, async save(value) { wraps.push(value); } };
  const key = await InstallationDataKey.loadOrCreate("s3-installation", wrapStore, new StaticMasterKeyProvider({ id: "operator", bytes: new Uint8Array(32).fill(9) }));
  const blobs = new EncryptedBlobStore(fixture.blobs ?? new FileBlobStore(root), key, TENANT);
  const artifacts = new FactoryArtifacts(db, blobs, TENANT);
  const journal = new FactoryExecutionJournal(db, async () => {});
  const attemptMaterials = new FactoryAttemptMaterials({ database: db, artifacts, blobs, journal, authority: attempt });
  const reader = new FactoryScopedMaterials({ database: db, artifacts, blobs });
  const scope: FactoryMaterialScope = { tenantId: TENANT, projectId, runId, attemptId, operationId: materialOperationId };

  /** Seals one material from its exact chunks, the way a guest's export would. */
  const storeMaterial = async (objectName: string, chunks: readonly Uint8Array[], mediaType: string, wholeDigest?: string): Promise<FactoryArtifactReference> => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const assembled = createHash("sha256");
    for (const chunk of chunks) assembled.update(chunk);
    const identity = { ...scope, objectName, version: 1 };
    await attemptMaterials.begin(identity, mediaType, total, chunks.length);
    for (const [index, chunk] of chunks.entries()) await attemptMaterials.writeChunk(identity, { index, digest: factoryMaterialDigest(chunk), encodedBytes: chunk.byteLength }, chunk);
    return attemptMaterials.seal(identity, wholeDigest ?? `sha256:${assembled.digest("hex")}`);
  };
  const bytesOf = (value: string) => encoder.encode(value);
  const members = {
    candidate: await storeMaterial("candidate.json", [bytesOf('{"accepted":"dataset"}')], "application/json"),
    evidence: await storeMaterial("evidence.json", [bytesOf('{"claim":"PASS"}')], "application/json"),
    partOne: await storeMaterial("part-0.csv", [bytesOf("id,value\n1,alpha\n")], "text/csv"),
    partTwo: await storeMaterial("part-1.csv", [bytesOf("id,value\n2,beta\n")], "text/csv"),
  };

  const grants = new FactoryGrants(db, TENANT, () => Date.now());
  for (const action of ["factory.trust", "factory.approve", "factory.release", "factory.operate"] as const) {
    await grants.set(admin, { projectId, principal: admin, action, expectedRevision: 0, expiresAtMs: null });
  }
  const trusted: FactoryTrustedEvidence = {
    ...candidate, validatorId: "validator", validatorLockDigest: digest("c"), issuerGrantRevision: 1, candidateDigest: digest("c"),
    artifact: members.evidence, environmentDigest: digest("e"), configurationDigest: digest("d"), runnerDigest: digest("e"),
    claims: [{ id: "passed", verdict: "PASS" as const, decisive: true }], issuedAtMs: now - 1, expiresAtMs: deadlineMs,
  };
  class Gateway implements FactoryTrustedValidatorGateway, FactoryCurrentCandidateResolver {
    async assertContractInTransaction(): Promise<void> {}
    bindAttemptInTransaction = unboundFactoryValidatorBinders.bindAttemptInTransaction;
    bindTaskAttemptInTransaction = unboundFactoryValidatorBinders.bindTaskAttemptInTransaction;
    async resolveValidatorInTransaction(): Promise<FactoryTrustedEvidence> { return structuredClone(trusted); }
    async resolveCurrentEvidenceInTransaction(): Promise<readonly FactoryTrustedEvidence[]> { return [structuredClone(trusted)]; }
  }
  class RunFence implements FactoryReleaseFenceReader {
    async readCurrentInTransaction() { return { runId, executionEpoch: installationEpoch, cancellationEpoch: 0, status: "running" as const, deadlineMs }; }
  }
  const gateway = new Gateway();
  const assurance = new FactoryAssurance(db, TENANT, grants, gateway, new RunFence(), gateway, () => Date.now());
  await assurance.approveContract(admin, { projectId, contractId: "contract", revision: 1, contractDigest: digest("f"), validatorLockDigest: trusted.validatorLockDigest, mandatoryClaims: [{ id: "passed", validatorId: trusted.validatorId, freshnessMs: 900_000 }], claimGroups: [{ id: "all", claimIds: ["passed"], minimumPasses: 1, requireAllDecisive: true }] }, `contract-${suffix}`);
  await assurance.captureEvidence({ ...candidate, validatorId: trusted.validatorId });
  const decision = await assurance.accept({ ...candidate, contractId: "contract", revision: 1 });

  /**
   * The durable protected-command trail the scope resolver reads. These are the
   * rows `protected-command-effects.ts` and `task-completions.ts` write, so the
   * resolver runs against the real shape rather than a convenient one.
   */
  const outputArtifactId = `candidate-output-${suffix}`;
  await db.execute(sql`INSERT INTO factory_artifacts(object_id,tenant_id,project_id,run_id,kind,candidate_node_instance_id,candidate_generation,digest,blob_digest,storage_version,encoded_bytes)
    VALUES (${outputArtifactId},${TENANT},${projectId},${runId},'candidate_output',${TASK_NODE},1,${digest("5")},${bare("7")},'version-1',64)`);
  await db.execute(sql`INSERT INTO factory_execution_terminals(tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_id,request_digest,result_digest,terminal_result_digest,result_json,output_artifact_id,output_digest,output_bytes,execution_epoch,cancellation_epoch,terminal_fact_digest)
    VALUES (${TENANT},${projectId},${runId},${TASK_NODE},1,${attemptId},${bare("2")},${bare("3")},${digest("4")},'{}',${outputArtifactId},${digest("5")},64,${installationEpoch},0,${digest("6")})`);
  await db.execute(sql`INSERT INTO factory_audit_batches(tenant_id,project_id,run_id,interpreter_id,source_sequence,sequence,digest,payload) VALUES (${TENANT},${projectId},${runId},${INTERPRETER},1,1,${digest("e")},'{}')`);

  const addCommand = async (commandId: string): Promise<void> => {
    await db.execute(sql`INSERT INTO factory_transition_commands(tenant_id,project_id,run_id,interpreter_id,command_id,source_sequence,command_digest) VALUES (${TENANT},${projectId},${runId},${INTERPRETER},${commandId},1,${digest("a")})`);
  };
  const acceptanceReceipt = (decisionId: string, overrides: Record<string, unknown> = {}) => ({
    schemaVersion: "factory.protected-command-receipt.v1", kind: "request-acceptance", outcome: "accepted",
    reference: { tenantId: TENANT, projectId, logicalRunId: runId, interpreterId: INTERPRETER, commandId: `acceptance-${decisionId}` },
    commandDigest: digest("a"),
    source: { nodeInstanceId: TASK_NODE, candidateGeneration: 1, attempt: { candidateGeneration: 1, attempt: 1, commandId: taskCommandId, startedAtMs: now, deadlineAtMs: deadlineMs, stopped: true, uncertain: false }, path: ["result"] },
    decision: { ...decision, decisionId },
    acceptedCandidate: { accepted: "dataset" },
    event: { kind: "node-result", id: `protected-acceptance:${decisionId}`, atMs: now, nodeId: RELEASE_NODE, commandId: `acceptance-${decisionId}`, candidateGeneration: 1, attempt: 1, output: {} },
    ...overrides,
  });
  /** Writes one stored protected receipt exactly as the effects table holds it. */
  const writeReceipt = async (commandId: string, receipt: unknown): Promise<void> => {
    await addCommand(commandId);
    await db.execute(sql`INSERT INTO factory_protected_command_effects(tenant_id,project_id,run_id,interpreter_id,command_id,kind,command_digest,receipt_json,receipt_digest,decision)
      VALUES (${TENANT},${projectId},${runId},${INTERPRETER},${commandId},'request-acceptance',${digest("a")},${canonicalJson(receipt)},${hash(receipt)},'accepted')`);
  };

  await addCommand(taskCommandId);
  await db.execute(sql`INSERT INTO factory_task_completions(tenant_id,project_id,run_id,interpreter_id,command_id,attempt_id,input_digest,authority_json,receipt_json,receipt_digest)
    VALUES (${TENANT},${projectId},${runId},${INTERPRETER},${taskCommandId},${attemptId},${digest("1")},'{}','{}',${digest("2")})`);
  await writeReceipt(`acceptance-${decision.decisionId}`, acceptanceReceipt(decision.decisionId));

  const provenance = new FactoryS3PublicationProvenance({ database: db, tenantId: TENANT });
  const store = fixture.archive ?? new MemoryFactoryReleaseArchive();
  const archive = new FaultInjectingArchive(store);
  const writer = new FactoryArchiveWriter({
    archive, reader, inventory: archive, publicationSet: provenance.publicationSet(),
    failureDomain: factoryArchiveFailureDomain({ productEndpoint: "http://127.0.0.1:18333", archiveEndpoint: "http://127.0.0.1:18334", productCredentialSet: "ordinary.json", archiveCredentialSet: "archive.json" }),
    denialProbe: { async attempt() { return "denied"; } },
  });

  const releaseMaterial: FactoryReleaseMaterial = { decisionId: decision.decisionId, evidence: [{ artifact: members.evidence, candidateDigest: trusted.candidateDigest }], packageTrustDigest: digest("a"), validatorTrustDigest: digest("b") };
  const materials: FactoryReleaseMaterialReader = { async readPinnedInTransaction() { return releaseMaterial; } };
  class Authority implements FactoryReleaseAuthorityReader {
    async lockCurrentInTransaction(): Promise<FactoryReleaseAuthority> {
      return { runId, nodeInstanceId: TASK_NODE, candidateGeneration: 1, candidateDigest: trusted.candidateDigest, executionEpoch: installationEpoch, cancellationEpoch: 0, releaseEnableEpoch: 1, deadlineMs, status: "running", packageTrustDigest: digest("a"), validatorTrustDigest: digest("b") };
    }
  }
  class Destination implements FactoryDestinationReservationReader {
    async reserveInTransaction() { return { currentVersion: null }; }
  }
  const releases = new FactoryReleases(db, TENANT, grants, assurance, materials, new Authority(), new Destination(), writer, { async proveStopped() { return true; } }, () => Date.now());

  const s3 = fixture.s3 ?? { client: new FactoryMemoryS3Store(), bucket: "tenant-01", prefix: `ordinary/publication/${suffix}` };
  const account = `account-${suffix}`;
  const provider = new S3FactoryManifestReleaseProvider({
    endpoint: "http://127.0.0.1:18333", bucket: s3.bucket, account, prefix: s3.prefix,
    credentials: { accessKeyId: "publication-id", secretAccessKey: "publication-secret" }, client: s3.client, reader, attempts: provenance,
  });
  const profile = new S3FactoryManifestReleaseProfile({ adapter: ADAPTER, account, provenance, materials: attemptMaterials, spendMicrosPerMebibyte: 3 });

  const accepted: FactoryS3AcceptedPublication = {
    schemaVersion: FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION, materialOperationId,
    candidateObjectName: "candidate.json", candidateVersion: 1,
    files: [{ name: "data/part-0.csv", objectName: "part-0.csv", version: 1 }, { name: "data/part-1.csv", objectName: "part-1.csv", version: 1 }],
  };

  let sequence = 0;
  const mutationKey = (kind: string) => `${kind}-${suffix}-${++sequence}`;
  /** Resolves one publication through the shared asynchronous profile, outside every transaction. */
  const resolve = async (object: string, overrides: Partial<FactoryS3AcceptedPublication> = {}) => profile.resolve({
    tenantId: TENANT, projectId, runId, acceptedManifest: { ...accepted, ...overrides } as unknown as JsonValue,
    requestedDestination: { provider: "s3", account, object } as unknown as JsonValue, decision, material: releaseMaterial,
  }, new AbortController().signal);
  const prepare = async (object: string, overrides: Partial<FactoryS3AcceptedPublication> = {}, idempotencyKey = mutationKey("prepare")) => {
    const resolved = await resolve(object, overrides);
    return releases.prepare(admin, {
      projectId, runId, nodeInstanceId: TASK_NODE, candidateGeneration: 1, decisionId: decision.decisionId, candidateDigest: trusted.candidateDigest,
      action: profile.action, destination: resolved.destination, request: resolved.request, estimatedSpendMicros: resolved.estimatedSpendMicros, deadlineMs: now + 600_000,
    }, idempotencyKey);
  };
  const claim = async (operation: FactoryReleaseOperation) => {
    const approval = await assurance.requestApproval(admin, { projectId, operationId: operation.operationId, decisionId: decision.decisionId, destinationDigest: operation.destinationDigest, expectedGeneration: operation.dispatchGeneration + 1, expiresAtMs: operation.deadlineMs }, mutationKey("approval"));
    await assurance.decideApproval(admin, projectId, approval.approvalId, approval.contextDigest, true, mutationKey("decision"));
    return releases.claim(admin, projectId, operation.operationId, { kind: "approval", approvalId: approval.approvalId });
  };
  const publish = async (object: string, overrides: Partial<FactoryS3AcceptedPublication> = {}) => releases.dispatch(await claim(await prepare(object, overrides)), provider);
  const keyOf = (operation: FactoryReleaseOperation, name: string) => `${s3.prefix}/${operation.destination.object}/${name}`;
  const read = async (objectKey: string): Promise<{ bytes: Uint8Array; contentType?: string } | null> => {
    try {
      const result = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: objectKey })) as { Body?: { transformToByteArray(): Promise<Uint8Array> }; ContentType?: string };
      return { bytes: await result.Body!.transformToByteArray(), contentType: result.ContentType };
    } catch { return null; }
  };
  const writeForeign = async (objectKey: string, body: string, contentType: string): Promise<void> => {
    await s3.client.send(new PutObjectCommand({ Bucket: s3.bucket, Key: objectKey, Body: Buffer.from(body), ContentType: contentType }));
  };
  const currentVersion = async (objectKey: string): Promise<string> => {
    const head = await s3.client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: objectKey })) as { VersionId?: string };
    return head.VersionId!;
  };
  /**
   * How many parts the stored object was assembled from.
   *
   * S3 reports a multipart object's ETag as `"<opaque>-<parts>"`. The count is
   * the one thing that suffix is good for; it is never a content digest, which
   * is why the receipt carries a SHA-256 this adapter recomputed instead.
   */
  const multipartParts = async (objectKey: string): Promise<number> => {
    const head = await s3.client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: objectKey })) as { ETag?: string };
    return Number((head.ETag ?? "").replace(/"/g, "").split("-")[1] ?? 0);
  };

  return {
    db, admin, projectId, runId, attemptId, taskCommandId, decision, scope, members, reader, archive, writer, releases, provider, profile,
    provenance, accepted, materialOperationId, account, resolve, prepare, claim, publish, keyOf, read, writeForeign, currentVersion,
    mutationKey, storeMaterial, writeReceipt, addCommand, acceptanceReceipt, multipartParts, large: fixture.large === true,
  };
}

test("the attempt behind a publication comes from the verified protected provenance", async () => {
  const world = await setup();
  const verified = await world.provenance.attemptForDecision(world.projectId, world.runId, world.decision.decisionId);
  expect(verified).toMatchObject({ attemptId: world.attemptId, nodeInstanceId: TASK_NODE, candidateGeneration: 1, decisionId: world.decision.decisionId });

  const operation = await world.prepare("releases/provenance");
  expect(await world.provenance.attemptFor(operation)).toBe(world.attemptId);
  // The archive member plan names the same verified scope and the pinned candidate.
  const sources = await world.provenance.sourcesFor(TENANT, operation.operationId, operation.material);
  expect(sources.scope).toEqual(world.scope);
  expect(sources.candidate).toEqual(world.members.candidate);

  await expect(world.provenance.sourcesFor("other-tenant", operation.operationId, operation.material)).rejects.toMatchObject({ code: "factory_s3_provenance_untrusted" });
  await expect(world.provenance.sourcesFor(TENANT, "factory-release:missing", operation.material)).rejects.toMatchObject({ code: "factory_s3_provenance_missing" });
  await expect(world.provenance.attemptFor({ ...operation, tenantId: "other-tenant" })).rejects.toMatchObject({ code: "factory_s3_provenance_untrusted" });
  for (const drift of [{ nodeInstanceId: "other-node" }, { candidateGeneration: 4 }, { candidateDigest: digest("9") }]) {
    await expect(world.provenance.attemptFor({ ...operation, ...drift })).rejects.toMatchObject({ code: "factory_s3_provenance_untrusted" });
  }
  await expect(world.provenance.attemptForDecision(world.projectId, world.runId, "no-such-decision")).rejects.toMatchObject({ code: "factory_s3_provenance_missing" });
  const aborted = new AbortController();
  aborted.abort();
  await expect(world.provenance.attemptForDecision(world.projectId, world.runId, world.decision.decisionId, aborted.signal)).rejects.toThrow();
  await expect(world.provenance.sourcesFor(TENANT, operation.operationId, operation.material, aborted.signal)).rejects.toThrow();
});

test("a protected receipt that does not agree with itself or its completion supplies no attempt", async () => {
  const world = await setup();
  const check = async (decisionId: string, code: string, overrides: Record<string, unknown>) => {
    await world.writeReceipt(`acceptance-${decisionId}`, world.acceptanceReceipt(decisionId, overrides));
    await expect(world.provenance.attemptForDecision(world.projectId, world.runId, decisionId)).rejects.toMatchObject({ code });
  };
  const base = world.acceptanceReceipt("template");

  // A decision and its verified source must name the same node and generation.
  await check("drifted-node", "factory_s3_provenance_untrusted", { decision: { ...world.decision, decisionId: "drifted-node", nodeInstanceId: "elsewhere" } });
  await check("drifted-generation", "factory_s3_provenance_untrusted", { decision: { ...world.decision, decisionId: "drifted-generation", candidateGeneration: 3 } });
  // A receipt that claims another run or another tenant is refused.
  await check("foreign-run", "factory_s3_provenance_untrusted", { decision: { ...world.decision, decisionId: "foreign-run" }, reference: { ...base.reference, logicalRunId: "another-run" } });
  await check("foreign-tenant", "factory_s3_provenance_untrusted", { decision: { ...world.decision, decisionId: "foreign-tenant" }, reference: { ...base.reference, tenantId: "another-tenant" } });
  await check("foreign-project", "factory_s3_provenance_untrusted", { decision: { ...world.decision, decisionId: "foreign-project" }, reference: { ...base.reference, projectId: "another-project" } });
  // A task command with no verified completion, and a completion for another node.
  await check("orphan", "factory_s3_provenance_missing", { decision: { ...world.decision, decisionId: "orphan" }, source: { ...base.source, attempt: { ...base.source.attempt, commandId: "never-completed" } } });
  await check("mismatched", "factory_s3_provenance_untrusted", {
    decision: { ...world.decision, decisionId: "mismatched", candidateGeneration: 9 },
    source: { ...base.source, candidateGeneration: 9 },
  });

  // Rows that are not a readable accepted receipt are ignored rather than trusted.
  for (const [commandId, receiptJson] of [["unreadable", "not json"], ["shapeless", '{"kind":"request-acceptance","outcome":"accepted"}'], ["rejected", '{"kind":"request-acceptance","outcome":"rejected"}']] as const) {
    await world.addCommand(commandId);
    await world.db.execute(sql`INSERT INTO factory_protected_command_effects(tenant_id,project_id,run_id,interpreter_id,command_id,kind,command_digest,receipt_json,receipt_digest,decision)
      VALUES (${TENANT},${world.projectId},${world.runId},${INTERPRETER},${commandId},'request-acceptance',${digest("a")},${receiptJson},${digest("b")},'accepted')`);
  }
  expect(await world.provenance.attemptForDecision(world.projectId, world.runId, world.decision.decisionId)).toMatchObject({ attemptId: world.attemptId });
});

test("the release profile pins every published file from its sealed material record", async () => {
  const world = await setup();
  const resolved = await world.resolve("releases/profile");

  expect(resolved.schemaVersion).toBe("factory.release-profile-result.v1");
  expect(resolved.destination).toEqual({ provider: "s3", account: world.account, object: "releases/profile" });
  const request = resolved.request as unknown as FactoryS3PublicationSetRequest;
  expect(request.materialOperationId).toBe(world.materialOperationId);
  expect(request.candidate).toEqual(world.members.candidate);
  expect(request.members.map(member => [member.name, member.mediaType, member.digest, member.totalBytes, member.chunkCount])).toEqual([
    ["data/part-0.csv", "text/csv", sha256(encoder.encode("id,value\n1,alpha\n")), 17, 1],
    ["data/part-1.csv", "text/csv", sha256(encoder.encode("id,value\n2,beta\n")), 16, 1],
  ]);
  expect(request.members[0]!.artifact).toEqual(world.members.partOne);
  expect(request.members[1]!.artifact).toEqual(world.members.partTwo);
  expect(resolved.estimatedSpendMicros).toBe(3);
  expect(resolved.inputDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(FACTORY_RELEASE_RESOLVE_TIMEOUT_MS).toBe(120_000);
  expect(world.profile.action).toBe("publish-manifest");

  // A candidate naming a material that is not sealed at that exact version resolves nothing.
  await expect(world.resolve("releases/profile", { candidateVersion: 7 })).rejects.toMatchObject({ code: "factory_s3_profile_invalid" });
  await expect(world.resolve("releases/profile", { files: [{ name: "a.csv", objectName: "missing.csv", version: 1 }] })).rejects.toMatchObject({ code: "factory_s3_profile_invalid" });
  await expect(world.resolve("releases/profile", { materialOperationId: "other-operation" })).rejects.toMatchObject({ code: "factory_s3_profile_invalid" });

  // An aborted resolve produces nothing at all.
  const aborted = new AbortController();
  aborted.abort();
  await expect(world.profile.resolve({ tenantId: TENANT, projectId: world.projectId, runId: world.runId, acceptedManifest: world.accepted as unknown as JsonValue, requestedDestination: { provider: "s3", account: world.account, object: "releases/x" } as unknown as JsonValue, decision: world.decision, material: { decisionId: world.decision.decisionId, evidence: [], packageTrustDigest: digest("a"), validatorTrustDigest: digest("b") } }, aborted.signal)).rejects.toThrow();
});

test("the archive holds the publication set's members before any dispatch claim is possible", async () => {
  const world = await setup();
  const operation = await world.prepare("releases/archived");
  expect(operation).toMatchObject({ state: "pending", archiveReady: true });

  const manifest = await world.writer.readManifest(operation.materialArchive!, operation.materialDigest);
  expect(manifest.members.map(member => [member.role, member.memberName])).toEqual([
    ["candidate", "candidate"], ["evidence", `evidence/${world.members.evidence.artifactId}`],
  ]);
  for (const member of manifest.members) {
    expect(await world.writer.read(member.object)).toEqual(await world.reader.read(world.scope, member.artifact));
  }
  // The archived recovery intent carries the whole frozen publication set, so every
  // member's key, media type, and digest survives in the archive without its bytes.
  const intent = JSON.parse(new TextDecoder().decode(await world.writer.read(operation.intentArchive!))) as { request: FactoryS3PublicationSetRequest; requestDigest: string };
  expect(intent.request.members.map(member => [member.name, member.digest, member.mediaType])).toEqual([
    ["data/part-0.csv", sha256(encoder.encode("id,value\n1,alpha\n")), "text/csv"],
    ["data/part-1.csv", sha256(encoder.encode("id,value\n2,beta\n")), "text/csv"],
  ]);
  expect(intent.requestDigest).toBe(operation.requestDigest);
  expect(await world.claim(operation)).toMatchObject({ state: "executing", dispatchStarted: false });
});

test("a publication settles only after its verified receipt reaches the archive", async () => {
  const world = await setup();
  const settled = await world.publish("releases/settled");

  expect(settled).toMatchObject({ state: "succeeded", outcomeCode: "confirmed" });
  const receipt = settled.receipt as FactoryS3ManifestReceipt;
  expect(receipt.schemaVersion).toBe(FACTORY_S3_PUBLICATION_RECEIPT_SCHEMA_VERSION);
  expect(receipt.files).toHaveLength(2);
  expect(receipt.manifestKey).toBe(world.keyOf(settled, FACTORY_S3_MANIFEST_NAME));
  // The archived receipt is byte-identical to the settled one and precedes it.
  expect(canonicalJson(await world.writer.readArchivedReceipt(settled))).toBe(canonicalJson(receipt));
  expect(settled.receiptArchive).toBeDefined();
  // Every published object holds the exact accepted bytes under its own media type.
  for (const file of receipt.files) {
    const published = await world.read(file.key);
    expect(sha256(published!.bytes)).toBe(file.digest);
    expect(published!.contentType).toBe(file.mediaType);
  }
  const manifest = JSON.parse(new TextDecoder().decode((await world.read(receipt.manifestKey))!.bytes)) as { files: Array<{ key: string; versionId: string }>; requestDigest: string };
  expect(manifest.requestDigest).toBe(settled.requestDigest);
  expect(manifest.files.map(file => file.versionId)).toEqual(receipt.files.map(file => file.versionId));
  expect(await world.provider.verifyReceipt(settled, receipt, { operationId: settled.operationId, reason: "settled lookup" })).toBe(true);
  expect(await world.provider.proveNoEffect(settled, { operationId: settled.operationId, reason: "settled lookup" })).toBe(false);
});

test("a written manifest whose receipt never reached the archive stays recoverable uncertainty", async () => {
  const world = await setup();
  const operation = await world.prepare("releases/recovered");
  const claimed = await world.claim(operation);
  world.archive.failWriteFor = FACTORY_S3_PUBLICATION_RECEIPT_SCHEMA_VERSION;

  const uncertain = await world.releases.dispatch(claimed, world.provider);
  expect(uncertain).toMatchObject({ state: "uncertain", outcomeCode: "receipt_archive_unknown" });
  expect(uncertain.receipt).toBeUndefined();
  expect(await world.writer.readArchivedReceipt(uncertain)).toBeNull();

  // The manifest is published, so a second dispatch is refused rather than repeated.
  expect(await world.read(world.keyOf(operation, FACTORY_S3_MANIFEST_NAME))).not.toBeNull();
  await expect(world.provider.publish(claimed)).rejects.toMatchObject({ code: "factory_s3_manifest_published" });
  expect(await world.provider.proveNoEffect(uncertain, { operationId: operation.operationId, reason: "operator lookup" })).toBe(false);

  // An operator rebuilds the confirmed effect from the live store, with no new write.
  world.archive.failWriteFor = undefined;
  const rebuilt = (await world.provider.describePublication(uncertain))!;
  expect(rebuilt.files.map(file => file.name)).toEqual(["data/part-0.csv", "data/part-1.csv"]);
  const attached = await world.releases.reconcile(world.admin, { projectId: world.projectId, operationId: operation.operationId, action: "attach_receipt", reason: "the manifest is present at its exact version", providerEvidence: { operationId: operation.operationId, reason: "operator lookup" }, receipt: rebuilt }, claimed.dispatchGeneration, world.provider, world.mutationKey("reconcile"));
  expect(attached).toMatchObject({ state: "succeeded", outcomeCode: "confirmed" });
  expect(canonicalJson(attached.receipt)).toBe(canonicalJson(rebuilt));
  expect(canonicalJson(await world.writer.readArchivedReceipt(attached))).toBe(canonicalJson(rebuilt));
  // A receipt naming another generation cannot settle this one.
  await expect(world.releases.reconcile(world.admin, { projectId: world.projectId, operationId: operation.operationId, action: "attach_receipt", reason: "wrong generation", providerEvidence: { operationId: operation.operationId, reason: "x" }, receipt: { ...rebuilt, dispatchGeneration: 9 } }, claimed.dispatchGeneration, world.provider, world.mutationKey("reconcile"))).rejects.toThrow();
});

test("an interrupted staging resumes under the same identity and never appears published", async () => {
  const world = await setup();
  const operation = await world.prepare("releases/interrupted");
  const claimed = await world.claim(operation);
  const request = operation.request as unknown as FactoryS3PublicationSetRequest;

  const original = world.reader.readChunk.bind(world.reader);
  let failing = true;
  world.reader.readChunk = async (scope, reference, index, signal) => {
    if (failing && reference.artifactId === request.members[1]!.artifact.artifactId) throw new Error("material read interrupted");
    return original(scope, reference, index, signal);
  };
  const uncertain = await world.releases.dispatch(claimed, world.provider);
  expect(uncertain).toMatchObject({ state: "uncertain", outcomeCode: "provider_response_unknown" });
  expect(await world.read(world.keyOf(operation, FACTORY_S3_MANIFEST_NAME))).toBeNull();
  const staged = await world.read(world.keyOf(operation, "data/part-0.csv"));
  expect(sha256(staged!.bytes)).toBe(request.members[0]!.digest);

  // Nothing is published, so absence is provable and the operation returns to pending.
  expect(await world.provider.describePublication(uncertain)).toBeNull();
  expect(await world.provider.proveNoEffect(uncertain, { operationId: operation.operationId, reason: "operator lookup" })).toBe(true);
  const cleared = await world.releases.reconcile(world.admin, { projectId: world.projectId, operationId: operation.operationId, action: "confirm_no_effect", reason: "the manifest was never written", providerEvidence: { operationId: operation.operationId, reason: "operator lookup" } }, claimed.dispatchGeneration, world.provider, world.mutationKey("reconcile"));
  expect(cleared).toMatchObject({ state: "pending", outcomeCode: "confirmed_no_effect" });

  // The retry reuses the staged object rather than writing its bytes twice.
  failing = false;
  const settled = await world.releases.dispatch(await world.claim(cleared), world.provider);
  expect(settled).toMatchObject({ state: "succeeded" });
  const receipt = settled.receipt as FactoryS3ManifestReceipt;
  expect(receipt.files[0]!.versionId).toBe(await world.currentVersion(receipt.files[0]!.key));
  expect(await world.provider.verifyReceipt(settled, receipt, { operationId: settled.operationId, reason: "verify" })).toBe(true);
});

test("a foreign object under the operation directory is a conflict, not a resume", async () => {
  const world = await setup();
  const operation = await world.prepare("releases/conflicted");
  const claimed = await world.claim(operation);
  await world.writeForeign(world.keyOf(operation, "data/part-0.csv"), "someone else wrote this", "text/csv");

  const uncertain = await world.releases.dispatch(claimed, world.provider);
  expect(uncertain).toMatchObject({ state: "uncertain", outcomeCode: "provider_response_unknown" });
  expect(await world.read(world.keyOf(operation, FACTORY_S3_MANIFEST_NAME))).toBeNull();
  // The directory is not this operation's to prove empty, so it stays uncertain.
  expect(await world.provider.proveNoEffect(uncertain, { operationId: operation.operationId, reason: "operator lookup" })).toBe(false);
  await expect(world.releases.reconcile(world.admin, { projectId: world.projectId, operationId: operation.operationId, action: "confirm_no_effect", reason: "no manifest", providerEvidence: { operationId: operation.operationId, reason: "operator lookup" } }, claimed.dispatchGeneration, world.provider, world.mutationKey("reconcile"))).rejects.toThrow("factory_release_absence_unproved");
  expect(factoryS3PublicationIdentity(operation)).toMatch(/^sha256:[a-f0-9]{64}$/);
});

test("a confirmed publication is never repeated and a manifest race is never a second effect", async () => {
  const world = await setup();
  const settled = await world.publish("releases/exclusive");
  expect(settled.state).toBe("succeeded");
  // The same operation cannot be claimed again once it has succeeded.
  await expect(world.claim(settled)).rejects.toThrow();

  const other = await world.prepare("releases/raced");
  const claimed = await world.claim(other);
  await world.writeForeign(world.keyOf(other, FACTORY_S3_MANIFEST_NAME), "{}", "application/json");
  const uncertain = await world.releases.dispatch(claimed, world.provider);
  expect(uncertain).toMatchObject({ state: "uncertain", outcomeCode: "provider_response_unknown" });
  // The foreign manifest is not this operation's effect, so no receipt can be rebuilt.
  await expect(world.provider.describePublication(uncertain)).rejects.toMatchObject({ code: "factory_s3_receipt_corrupt" });
});

test("a 256 MiB material exports through W04 chunks as a real multipart upload", async () => {
  const world = await setup();
  if (!world.large) {
    // The real producer runs the byte volume. This leg states the bound it uses
    // rather than claiming a proof it did not make.
    expect(FACTORY_S3_PUBLICATION_LIMITS.maxMemberBytes).toBe(256 * 1024 * 1024);
    expect(FACTORY_S3_PUBLICATION_LIMITS.partBytes).toBe(8 * 1024 * 1024);
    return;
  }
  // The bytes are streamed into the material and never assembled a second time,
  // so the proof measures the export path rather than the test's memory.
  const assembled = createHash("sha256");
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < FACTORY_S3_PUBLICATION_LIMITS.maxChunks / 2; index += 1) {
    const part = new Uint8Array(FACTORY_S3_PUBLICATION_LIMITS.partBytes).fill(index % 251);
    part[0] = index;
    part[part.length - 1] = 255 - index;
    assembled.update(part);
    chunks.push(part);
  }
  const totalBytes = chunks.length * FACTORY_S3_PUBLICATION_LIMITS.partBytes;
  const wholeDigest = `sha256:${assembled.digest("hex")}`;
  expect(totalBytes).toBe(256 * 1024 * 1024);
  await world.storeMaterial("export.bin", chunks, "application/octet-stream", wholeDigest);
  chunks.length = 0;

  const settled = await world.publish("releases/large", { files: [{ name: "export.bin", objectName: "export.bin", version: 1 }] });
  expect(settled.state).toBe("succeeded");
  const receipt = settled.receipt as FactoryS3ManifestReceipt;
  expect(receipt.files).toHaveLength(1);
  expect(receipt.files[0]!.encodedBytes).toBe(totalBytes);
  expect(receipt.files[0]!.digest).toBe(wholeDigest);
  // The multipart object the store now holds re-reads to the same SHA-256, streamed.
  expect(await world.provider.verifyReceipt(settled, receipt, { operationId: settled.operationId, reason: "large lookup" })).toBe(true);
  expect(await world.multipartParts(receipt.files[0]!.key)).toBe(totalBytes / FACTORY_S3_PUBLICATION_LIMITS.partBytes);
}, 900_000);

test("a publication set is refused before it starts when its accepted candidate is malformed", () => {
  const valid: FactoryS3AcceptedPublication = {
    schemaVersion: FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION, materialOperationId: "operation-1",
    candidateObjectName: "candidate.json", candidateVersion: 1, files: [{ name: "a.csv", objectName: "part-0.csv", version: 1 }],
  };
  expect(assertFactoryS3AcceptedPublication(valid).files).toHaveLength(1);
  const bad = (value: unknown) => expect(() => assertFactoryS3AcceptedPublication(value)).toThrow("factory_s3_profile_invalid");
  for (const value of [null, "text", [], { ...valid, schemaVersion: "other" }, { ...valid, extra: 1 }]) bad(value);
  for (const materialOperationId of [1, "", "x".repeat(513), "with\0nul"]) bad({ ...valid, materialOperationId });
  for (const candidateObjectName of [1, ""]) bad({ ...valid, candidateObjectName });
  for (const candidateVersion of [0, 1.5, "1"]) bad({ ...valid, candidateVersion });
  for (const files of [null, [], "list"]) bad({ ...valid, files });
  for (const file of [null, "entry", {}, { name: "a", objectName: "b", version: 1, extra: 2 }]) bad({ ...valid, files: [file] });
  bad({ ...valid, files: [valid.files[0]!, valid.files[0]!] });
  bad({ ...valid, files: [{ name: "b.csv", objectName: "b", version: 1 }, { name: "a.csv", objectName: "a", version: 1 }] });
  bad({ ...valid, files: [{ name: 1, objectName: "b", version: 1 }] });

  expect(assertFactoryS3RequestedDirectory({ provider: "s3", account: "acct", object: "releases/a" }, "acct")).toBe("releases/a");
  const badDirectory = (value: unknown) => expect(() => assertFactoryS3RequestedDirectory(value, "acct")).toThrow("factory_s3_profile_invalid");
  for (const value of [null, "text", [], { provider: "github", account: "acct", object: "a" }, { provider: "s3", account: "other", object: "a" }, { provider: "s3", account: "acct", extra: 1 }, { provider: "s3", account: "acct", object: 1 }, { provider: "s3", account: "acct", object: "../escape" }]) badDirectory(value);
});

test("the provenance reader and the profile refuse an impossible configuration", async () => {
  const world = await setup();
  for (const scanLimit of [0, -1, 1.5, 513]) {
    expect(() => new FactoryS3PublicationProvenance({ database: world.db, tenantId: TENANT, scanLimit })).toThrow("factory_s3_provenance_invalid");
  }
  expect(new FactoryS3PublicationProvenance({ database: world.db, tenantId: TENANT, scanLimit: 1 }).tenantId).toBe(TENANT);
  for (const broken of [{ account: "" }, { spendMicrosPerMebibyte: -1 }, { spendMicrosPerMebibyte: 1.5 }]) {
    expect(() => new S3FactoryManifestReleaseProfile({ adapter: ADAPTER, account: world.account, provenance: world.provenance, materials: { async list() { return []; } }, ...broken })).toThrow("factory_s3_profile_invalid");
  }
  expect(new S3FactoryManifestReleaseProfile({ adapter: ADAPTER, action: "publish-set", account: world.account, provenance: world.provenance, materials: { async list() { return []; } }, now: () => 1 }).action).toBe("publish-set");

  // A stored request that is not an S3 publication set is never planned from.
  const operation = await world.prepare("releases/foreign-request");
  for (const canonicalRequest of [canonicalJson({ provider: "github", request: {} }), "not json", canonicalJson({ provider: "s3", request: { schemaVersion: "other" } })]) {
    await world.db.execute(sql`UPDATE factory_release_operations SET canonical_request=${canonicalRequest} WHERE tenant_id=${TENANT} AND operation_id=${operation.operationId}`);
    await expect(world.provenance.sourcesFor(TENANT, operation.operationId, operation.material)).rejects.toThrow();
  }
});
});
}
