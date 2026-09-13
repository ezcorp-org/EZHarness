import { expect, test } from "bun:test";
import { ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import { digestBytes } from "../extensions/v4/blobs";
import type { FactoryMaterialScope, FactoryScopedArtifactReader } from "./artifact-materials";
import {
  FACTORY_ARCHIVE_CREDENTIAL_SEPARATION,
  FACTORY_ARCHIVE_DEPLOYED_INDEPENDENCE,
  FACTORY_ARCHIVE_FAILURE_DOMAIN_SCHEMA_VERSION,
  FACTORY_ARCHIVE_MANIFEST_SCHEMA_VERSION,
  FACTORY_ARCHIVE_MEMBER_LIMITS,
  FACTORY_ARCHIVE_READINESS_SCHEMA_VERSION,
  FactoryArchiveRecovery,
  FactoryArchiveWriter,
  S3FactoryArchiveInventory,
  assertFactoryArchiveMemberBytes,
  factoryArchiveFailureDomain,
  factoryArchiveMemberPlan,
  factoryArchivePublicationSet,
  type FactoryArchiveDenialAttempt,
  type FactoryArchiveInventory,
  type FactoryArchiveMemberManifest,
  type FactoryArchiveMemberPlan,
  type FactoryArchivePublicationSet,
} from "./archive-writer";
import type { FactoryArchiveObject, FactoryProviderReceipt, FactoryReleaseArchive, FactoryReleaseMaterial, FactoryReleaseOperation, FactoryReleaseProvider } from "./releases";

const TENANT = "archive-tenant";
const OPERATION = `factory-release:${"a".repeat(64)}`;
const ROOT = "recovery";
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const segment = (value: string) => Buffer.from(value).toString("base64url");
const bytesOf = (value: string) => new TextEncoder().encode(value);

const scope: FactoryMaterialScope = { tenantId: TENANT, projectId: "project-a", runId: "run-a", attemptId: "attempt-a", operationId: "operation-a" };

function reference(id: string, bytes: number = 12): FactoryArtifactReference {
  return { artifactId: id, digest: digest("b"), encodedBytes: bytes };
}

/** Mirrors the S3 archive adapter's key layout so prefix arithmetic is real. */
class MemoryArchive implements FactoryReleaseArchive {
  readonly objects = new Map<string, Uint8Array>();
  readonly versions = new Map<string, string>();
  readonly writes: string[] = [];
  omitVersion = false;
  corruptReadsFor?: string;
  wrongDigestFor?: string;
  async writeImmutable(tenantId: string, operationId: string, name: string, bytes: Uint8Array): Promise<FactoryArchiveObject> {
    const raw = digestBytes(bytes);
    const key = `${ROOT}/${segment(tenantId)}/${segment(operationId)}/${name}/${raw}`;
    // Conditional create: identical bytes keep the first object and its version.
    if (!this.objects.has(key)) { this.objects.set(key, bytes.slice()); this.versions.set(key, `version-${this.objects.size}`); }
    this.writes.push(key);
    const decoded = new TextDecoder().decode(bytes);
    return {
      key,
      digest: this.wrongDigestFor && decoded.includes(this.wrongDigestFor) ? digest("0") : `sha256:${raw}`,
      ...(this.omitVersion ? {} : { versionId: this.versions.get(key)! }),
    };
  }
  async read(object: FactoryArchiveObject): Promise<Uint8Array> {
    const value = this.objects.get(object.key);
    if (!value) throw new Error("archive missing");
    return this.corruptReadsFor && new TextDecoder().decode(value).includes(this.corruptReadsFor) ? new Uint8Array([0]) : value.slice();
  }
}

class MemoryReader implements FactoryScopedArtifactReader {
  readonly contents = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  async read(readScope: FactoryMaterialScope, artifact: FactoryArtifactReference): Promise<Uint8Array> {
    if (readScope.tenantId !== scope.tenantId) throw new Error("factory_artifact_unavailable");
    this.reads.push(artifact.artifactId);
    const found = this.contents.get(artifact.artifactId);
    if (!found) throw new Error("factory_artifact_unavailable");
    return found.slice();
  }
  async readChunk(): Promise<Uint8Array> { return new Uint8Array(); }
}

const sameHost = factoryArchiveFailureDomain({ productEndpoint: "http://127.0.0.1:18333", archiveEndpoint: "http://127.0.0.1:18334", productCredentialSet: "ordinary.json", archiveCredentialSet: "archive.json" });

function material(overrides: Partial<FactoryReleaseMaterial> = {}): FactoryReleaseMaterial {
  return { decisionId: "decision-a", evidence: [{ artifact: reference("evidence-one"), candidateDigest: digest("c") }], packageTrustDigest: digest("d"), validatorTrustDigest: digest("e"), ...overrides };
}

function sources(candidate = true, request = true) {
  return { scope, ...(candidate ? { candidate: reference("candidate-one") } : {}), ...(request ? { request: reference("request-one") } : {}) };
}

function writer(options: { archive?: MemoryArchive; reader?: MemoryReader; publicationSet?: FactoryArchivePublicationSet; inventory?: FactoryArchiveInventory; denials?: Map<string, "denied" | "permitted"> } = {}) {
  const archive = options.archive ?? new MemoryArchive();
  const reader = options.reader ?? new MemoryReader();
  for (const id of ["candidate-one", "request-one", "evidence-one"]) reader.contents.set(id, bytesOf(`bytes of ${id}`));
  const built = new FactoryArchiveWriter({
    archive, reader, failureDomain: sameHost,
    publicationSet: options.publicationSet ?? factoryArchivePublicationSet(() => sources()),
    ...(options.inventory ? { inventory: options.inventory } : {}),
    ...(options.denials ? { denialProbe: { async attempt(attempt: FactoryArchiveDenialAttempt) { return options.denials!.get(`${attempt.credentialSet}:${attempt.operation}`) ?? "denied"; } } } : {}),
    now: () => 1_700_000_000_000,
  });
  return { archive, reader, writer: built };
}

const materialBytes = (value: FactoryReleaseMaterial = material()) => bytesOf(canonicalJson(value));

test("the failure-domain record states what a deployment proves and names every unmet criterion", () => {
  expect(sameHost).toMatchObject({
    schemaVersion: FACTORY_ARCHIVE_FAILURE_DOMAIN_SCHEMA_VERSION, failureDomain: "same-host-not-independent",
    productHost: "127.0.0.1", archiveHost: "127.0.0.1", credentialsSeparated: true, deployedIndependenceProven: false,
  });
  expect(sameHost.unmetCriteria).toEqual([FACTORY_ARCHIVE_DEPLOYED_INDEPENDENCE]);

  const separateHost = factoryArchiveFailureDomain({ productEndpoint: "https://product.example.test", archiveEndpoint: "https://archive.example.test", productCredentialSet: "ordinary.json", archiveCredentialSet: "archive.json" });
  expect(separateHost.failureDomain).toBe("separate-host-replication-unproven");
  expect(separateHost.unmetCriteria).toEqual([FACTORY_ARCHIVE_DEPLOYED_INDEPENDENCE]);

  const independent = factoryArchiveFailureDomain({ productEndpoint: "https://product.example.test", archiveEndpoint: "https://archive.example.test", productCredentialSet: "ordinary.json", archiveCredentialSet: "archive.json", independentReplicationEvidence: "operator verified replication into region b" });
  expect(independent).toMatchObject({ failureDomain: "separately-deployed-independent", deployedIndependenceProven: true });
  expect(independent.unmetCriteria).toEqual([]);

  const shared = factoryArchiveFailureDomain({ productEndpoint: "https://product.example.test", archiveEndpoint: "https://archive.example.test", productCredentialSet: "one.json", archiveCredentialSet: "one.json", independentReplicationEvidence: "replicated" });
  expect(shared.credentialsSeparated).toBe(false);
  expect(shared.unmetCriteria).toEqual([FACTORY_ARCHIVE_CREDENTIAL_SEPARATION, FACTORY_ARCHIVE_DEPLOYED_INDEPENDENCE]);

  for (const bad of [
    { productEndpoint: "not-a-url", archiveEndpoint: "https://archive.example.test", productCredentialSet: "a.json", archiveCredentialSet: "b.json" },
    { productEndpoint: "mailto:someone@example.test", archiveEndpoint: "https://archive.example.test", productCredentialSet: "a.json", archiveCredentialSet: "b.json" },
    { productEndpoint: "https://a.test", archiveEndpoint: "https://b.test", productCredentialSet: "has space", archiveCredentialSet: "b.json" },
    { productEndpoint: "https://a.test", archiveEndpoint: "https://b.test", productCredentialSet: "a.json", archiveCredentialSet: "b.json", independentReplicationEvidence: "" },
  ]) expect(() => factoryArchiveFailureDomain(bad)).toThrow("factory_archive_invalid");
});

test("the member plan is the pinned candidate, request, and evidence objects in a stable order", () => {
  const plan = factoryArchiveMemberPlan(sources(), material({ evidence: [{ nested: { deeper: [{ artifact: reference("evidence-two") }] } }, { artifact: reference("evidence-one") }, { artifact: reference("evidence-one") }] }));
  expect(plan.map(entry => [entry.role, entry.memberName])).toEqual([
    ["candidate", "candidate"], ["request", "request"],
    ["evidence", "evidence/evidence-one"], ["evidence", "evidence/evidence-two"],
  ]);
  expect(plan.every(entry => entry.scope.attemptId === scope.attemptId)).toBe(true);

  expect(factoryArchiveMemberPlan({ scope }, material({ evidence: [] }))).toEqual([]);
  expect(factoryArchiveMemberPlan({ scope }, material({ evidence: [null, 7, "text", { artifactId: "x", digest: digest("b") }] }))).toEqual([]);
  const tooDeep = { a: { b: { c: { d: { e: { f: { g: { h: { artifact: reference("too-deep") } } } } } } } } };
  expect(factoryArchiveMemberPlan({ scope }, material({ evidence: [tooDeep] }))).toEqual([]);

  expect(() => factoryArchiveMemberPlan({ scope }, { decisionId: "d", evidence: "no" } as unknown as FactoryReleaseMaterial)).toThrow("factory_archive_invalid");
  expect(() => factoryArchiveMemberPlan({ scope }, null as unknown as FactoryReleaseMaterial)).toThrow("factory_archive_invalid");
  expect(() => factoryArchiveMemberPlan({ scope, candidate: { artifactId: "c", digest: "bad", encodedBytes: 1 } }, material())).toThrow("factory_artifact_reference_invalid");
  expect(() => factoryArchiveMemberPlan({ scope }, material({ evidence: Array.from({ length: FACTORY_ARCHIVE_MEMBER_LIMITS.maxMembers + 1 }, (_, index) => ({ artifact: reference(`evidence-${index}`) })) }))).toThrow("factory_archive_member_limit");
});

test("member bytes are bounded per object and in aggregate", () => {
  expect(() => assertFactoryArchiveMemberBytes(1, 1)).not.toThrow();
  expect(() => assertFactoryArchiveMemberBytes(FACTORY_ARCHIVE_MEMBER_LIMITS.maxMemberBytes, FACTORY_ARCHIVE_MEMBER_LIMITS.maxTotalBytes)).not.toThrow();
  expect(() => assertFactoryArchiveMemberBytes(FACTORY_ARCHIVE_MEMBER_LIMITS.maxMemberBytes + 1, 1)).toThrow("factory_archive_member_limit");
  expect(() => assertFactoryArchiveMemberBytes(1, FACTORY_ARCHIVE_MEMBER_LIMITS.maxTotalBytes + 1)).toThrow("factory_archive_member_limit");
});

test("the material write archives every referenced member and the manifest that names them", async () => {
  const { archive, reader, writer: role } = writer();
  const bytes = materialBytes();
  const object = await role.writeImmutable(TENANT, OPERATION, "material", bytes);

  expect(object.digest).toBe(`sha256:${digestBytes(bytes)}`);
  expect(reader.reads).toEqual(["candidate-one", "request-one", "evidence-one"]);
  expect(await role.read(object)).toEqual(bytes);

  const manifestKey = archive.writes.at(-2)!;
  const manifest = JSON.parse(new TextDecoder().decode(archive.objects.get(manifestKey)!)) as FactoryArchiveMemberManifest;
  expect(manifest.schemaVersion).toBe(FACTORY_ARCHIVE_MANIFEST_SCHEMA_VERSION);
  expect(manifest.materialDigest).toBe(object.digest);
  expect(manifest.members.map(member => member.memberName)).toEqual(["candidate", "request", "evidence/evidence-one"]);
  for (const member of manifest.members) expect(await role.read(member.object)).toEqual(reader.contents.get(member.artifact.artifactId)!);

  // The material object is written last, so nothing observes it before its members exist.
  expect(archive.writes.at(-1)).toBe(object.key);

  // A retry rebuilds the identical manifest and lands on the identical keys.
  const beforeRetry = [...archive.writes];
  const repeat = await role.writeImmutable(TENANT, OPERATION, "material", bytes);
  expect(repeat.key).toBe(object.key);
  expect(archive.writes.slice(beforeRetry.length)).toEqual(beforeRetry);
});

test("an intent, receipt, or reconciliation write passes straight through without a member set", async () => {
  const { archive, reader, writer: role } = writer();
  for (const name of ["intent", "receipt", "reconciliation"] as const) {
    const stored = await role.writeImmutable(TENANT, OPERATION, name, bytesOf(`${name} bytes`));
    expect(stored.key).toContain(`/${name}/`);
  }
  expect(reader.reads).toEqual([]);
  expect(archive.writes).toHaveLength(3);
});

test("publication stays pending when a member is missing, unreadable, corrupt, oversized, or over count", async () => {
  const missing = writer();
  missing.reader.contents.delete("evidence-one");
  await expect(missing.writer.writeImmutable(TENANT, OPERATION, "material", materialBytes())).rejects.toThrow("factory_archive_member_unavailable");
  expect(missing.archive.writes.some(key => key.includes("/material/"))).toBe(true);
  expect(missing.archive.objects.has(`${ROOT}/${segment(TENANT)}/${segment(OPERATION)}/material/${digestBytes(materialBytes())}`)).toBe(false);

  const foreignScope = writer({ publicationSet: factoryArchivePublicationSet(() => ({ ...sources(), scope: { ...scope, tenantId: "other-tenant" } })) });
  await expect(foreignScope.writer.writeImmutable(TENANT, OPERATION, "material", materialBytes())).rejects.toThrow("factory_archive_member_unavailable");

  const corruptArchive = new MemoryArchive();
  corruptArchive.corruptReadsFor = "bytes of candidate-one";
  await expect(writer({ archive: corruptArchive }).writer.writeImmutable(TENANT, OPERATION, "material", materialBytes())).rejects.toThrow("factory_archive_member_corrupt");

  const wrongDigest = new MemoryArchive();
  wrongDigest.wrongDigestFor = "bytes of candidate-one";
  await expect(writer({ archive: wrongDigest }).writer.writeImmutable(TENANT, OPERATION, "material", materialBytes())).rejects.toThrow("factory_archive_member_corrupt");

  const oversized = writer();
  oversized.reader.contents.set("candidate-one", new Uint8Array(FACTORY_ARCHIVE_MEMBER_LIMITS.maxMemberBytes + 1));
  await expect(oversized.writer.writeImmutable(TENANT, OPERATION, "material", materialBytes())).rejects.toThrow("factory_archive_member_limit");

  const overCount: readonly FactoryArchiveMemberPlan[] = Array.from({ length: FACTORY_ARCHIVE_MEMBER_LIMITS.maxMembers + 1 }, () => ({ role: "evidence" as const, memberName: "n", scope, artifact: reference("candidate-one") }));
  const flooded = writer({ publicationSet: { async plan() { return overCount; } } });
  await expect(flooded.writer.writeImmutable(TENANT, OPERATION, "material", materialBytes())).rejects.toThrow("factory_archive_member_limit");

  for (const bad of [bytesOf("{not json"), bytesOf("[]"), bytesOf("null"), bytesOf(JSON.stringify({ decisionId: "a" }))]) {
    await expect(writer().writer.writeImmutable(TENANT, OPERATION, "material", bad)).rejects.toThrow("factory_archive_material_unreadable");
  }

  const corruptManifest = new MemoryArchive();
  corruptManifest.corruptReadsFor = FACTORY_ARCHIVE_MANIFEST_SCHEMA_VERSION;
  await expect(writer({ archive: corruptManifest }).writer.writeImmutable(TENANT, OPERATION, "material", materialBytes())).rejects.toThrow("factory_archive_manifest_corrupt");
});

test("the role refuses a failure-domain record it did not produce", () => {
  expect(() => new FactoryArchiveWriter({ archive: new MemoryArchive(), reader: new MemoryReader(), publicationSet: factoryArchivePublicationSet(() => sources()), failureDomain: { ...sameHost, schemaVersion: "factory.archive-failure-domain.v0" as never } })).toThrow("factory_archive_invalid");
});

/** Lists exactly what a memory archive holds under one prefix, as S3 would. */
function inventoryOf(archive: MemoryArchive): FactoryArchiveInventory {
  return {
    async list(prefix: string) {
      if (!prefix.startsWith(`${ROOT}/`)) throw new Error("factory_archive_foreign_prefix");
      return [...archive.objects.keys()].filter(key => key.startsWith(`${prefix}/`)).map(key => ({ key, digest: `sha256:${key.slice(prefix.length + 1)}`, versionId: "v1" }));
    },
  };
}

test("the member manifest and the confirmed receipt are found from the archive alone", async () => {
  const archive = new MemoryArchive();
  const role = writer({ archive, inventory: inventoryOf(archive) }).writer;
  const bytes = materialBytes();
  const materialArchive = await role.writeImmutable(TENANT, OPERATION, "material", bytes);
  await archive.writeImmutable(TENANT, OPERATION, "material", bytesOf("not json at all"));
  await archive.writeImmutable(TENANT, OPERATION, "material", bytesOf(JSON.stringify({ schemaVersion: "other" })));

  const manifest = await role.readManifest(materialArchive, materialArchive.digest);
  expect(manifest.members).toHaveLength(3);
  await expect(role.readManifest(materialArchive, digest("9"))).rejects.toThrow("factory_archive_manifest_missing");
  await expect(role.readManifest(materialArchive, "not-a-digest")).rejects.toThrow("factory_archive_invalid");
  await expect(role.readManifest({ ...materialArchive, key: "recovery/elsewhere/intent/x" }, materialArchive.digest)).rejects.toThrow("factory_archive_foreign_prefix");
  await expect(role.readManifest({ key: materialArchive.key, digest: "bad" }, materialArchive.digest)).rejects.toThrow("factory_archive_invalid");

  const operation = { ...pendingOperation(), materialArchive, state: "uncertain" as const, dispatchStarted: true };
  expect(await role.readArchivedReceipt(operation)).toBeNull();
  await archive.writeImmutable(TENANT, OPERATION, "receipt", bytesOf("{broken"));
  await archive.writeImmutable(TENANT, OPERATION, "receipt", bytesOf(canonicalJson({ ...receiptFor(operation), dispatchGeneration: 9 })));
  const confirmed = receiptFor(operation);
  const receiptArchive = await archive.writeImmutable(TENANT, OPERATION, "receipt", bytesOf(canonicalJson(confirmed)));
  expect(await role.readArchivedReceipt(operation)).toEqual(confirmed);
  expect(await role.readArchivedReceipt({ ...operation, receiptArchive })).toEqual(confirmed);
  await expect(role.readArchivedReceipt({ ...operation, materialArchive: undefined })).rejects.toThrow("factory_archive_reference_missing");

  const withoutInventory = writer({ archive }).writer;
  await expect(withoutInventory.readArchivedReceipt(operation)).rejects.toThrow("factory_archive_inventory_unavailable");
});

test("readiness proves conditional create, checksum, version reads, and every credential denial", async () => {
  const archive = new MemoryArchive();
  const denials = new Map<string, "denied" | "permitted">();
  const result = await writer({ archive, denials }).writer.checkReadiness(TENANT, OPERATION);
  expect(result).toMatchObject({ schemaVersion: FACTORY_ARCHIVE_READINESS_SCHEMA_VERSION, ready: true, publicationGrade: false, checkedAtMs: 1_700_000_000_000 });
  expect(result.checks.filter(check => check.passed).map(check => check.id)).toEqual([
    "conditional_create", "checksum_verified", "version_read", "immutable_rewrite",
    "product_read_denied", "product_overwrite_denied", "product_delete_denied",
    "restore_read_denied", "restore_overwrite_denied", "restore_delete_denied",
  ]);
  expect(result.unmetCriteria).toEqual([FACTORY_ARCHIVE_DEPLOYED_INDEPENDENCE]);
  expect(result.failureDomain).toBe(sameHost);

  denials.set("product:delete", "permitted");
  const permitted = await writer({ archive: new MemoryArchive(), denials }).writer.checkReadiness(TENANT, OPERATION);
  expect(permitted.ready).toBe(false);
  expect(permitted.unmetCriteria).toEqual([FACTORY_ARCHIVE_DEPLOYED_INDEPENDENCE, "product_delete_denied"]);

  const unprobed = await writer({ archive: new MemoryArchive() }).writer.checkReadiness(TENANT, OPERATION);
  expect(unprobed.ready).toBe(false);
  expect(unprobed.checks.find(check => check.id === "product_read_denied")!.detail).toContain("no denial probe");

  const versionless = new MemoryArchive();
  versionless.omitVersion = true;
  const noVersion = await writer({ archive: versionless, denials: new Map() }).writer.checkReadiness(TENANT, OPERATION);
  expect(noVersion.checks.find(check => check.id === "version_read")!.passed).toBe(false);

  const mismatched = new MemoryArchive();
  mismatched.wrongDigestFor = "archive-readiness";
  mismatched.corruptReadsFor = "archive-readiness";
  const wrong = await writer({ archive: mismatched, denials: new Map() }).writer.checkReadiness(TENANT, OPERATION);
  expect(wrong.checks.filter(check => ["conditional_create", "checksum_verified", "immutable_rewrite"].includes(check.id)).map(check => check.passed)).toEqual([false, false, true]);

  const independent = new FactoryArchiveWriter({
    archive: new MemoryArchive(), reader: new MemoryReader(), publicationSet: factoryArchivePublicationSet(() => sources()),
    failureDomain: factoryArchiveFailureDomain({ productEndpoint: "https://a.test", archiveEndpoint: "https://b.test", productCredentialSet: "a.json", archiveCredentialSet: "b.json", independentReplicationEvidence: "operator verified" }),
    denialProbe: { async attempt() { return "denied"; } },
  });
  const graded = await independent.checkReadiness(TENANT, OPERATION);
  expect(graded).toMatchObject({ ready: true, publicationGrade: true });
  expect(graded.unmetCriteria).toEqual([]);
});

test("archive independence is only claimed while the ordinary store is unreachable", async () => {
  const archive = new MemoryArchive();
  const role = writer({ archive }).writer;
  expect(await role.proveIndependentOfProductStore({ async reachable() { return true; } }, TENANT, OPERATION)).toMatchObject({ id: "archive_survives_product_loss", passed: false });
  const proven = await role.proveIndependentOfProductStore({ async reachable() { return false; } }, TENANT, OPERATION);
  expect(proven.passed).toBe(true);
  expect(proven.detail).toContain("unreachable");

  const corrupt = new MemoryArchive();
  corrupt.corruptReadsFor = "archive-survives-product-loss";
  expect(await writer({ archive: corrupt }).writer.proveIndependentOfProductStore({ async reachable() { return false; } }, TENANT, OPERATION)).toMatchObject({ passed: false, detail: "the archive returned different bytes" });
});

class FakeS3 {
  lastPrefix?: string;
  lastSignal?: AbortSignal;
  versions: Array<{ Key?: string; VersionId?: string; IsLatest?: boolean }> = [];
  undefinedVersions = false;
  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    if (!(command instanceof ListObjectVersionsCommand)) throw new Error("unexpected S3 command");
    this.lastPrefix = command.input.Prefix;
    this.lastSignal = options?.abortSignal;
    return this.undefinedVersions ? {} : { Versions: this.versions };
  }
}

test("the S3 inventory reads archive keys instead of constructing them", async () => {
  const client = new FakeS3();
  const inventory = new S3FactoryArchiveInventory({ endpoint: "http://127.0.0.1", bucket: "tenant-01", root: "/archive/recovery/", credentials: { accessKeyId: "archive-id", secretAccessKey: "archive-secret" }, client });
  const prefix = "archive/recovery/tenant/operation/receipt";
  client.versions = [
    { Key: `${prefix}/${"a".repeat(64)}`, VersionId: "v1", IsLatest: true },
    { Key: `${prefix}/${"b".repeat(64)}`, VersionId: "v2" },
    { Key: `${prefix}/${"c".repeat(64)}`, VersionId: "v0", IsLatest: false },
    { Key: `${prefix}/not-a-digest`, VersionId: "v3", IsLatest: true },
    { Key: `${prefix}/${"d".repeat(64)}`, IsLatest: true },
    { VersionId: "v4", IsLatest: true },
  ];
  const controller = new AbortController();
  expect(await inventory.list(prefix, controller.signal)).toEqual([
    { key: `${prefix}/${"a".repeat(64)}`, digest: digest("a"), versionId: "v1" },
    { key: `${prefix}/${"b".repeat(64)}`, digest: digest("b"), versionId: "v2" },
  ]);
  expect(client.lastPrefix).toBe(`${prefix}/`);
  expect(client.lastSignal).toBe(controller.signal);

  client.undefinedVersions = true;
  expect(await inventory.list(prefix)).toEqual([]);
  expect(client.lastSignal).toBeUndefined();

  await expect(inventory.list("elsewhere/receipt")).rejects.toThrow("factory_archive_foreign_prefix");
  await expect(inventory.list(7 as unknown as string)).rejects.toThrow("factory_archive_foreign_prefix");
  expect(() => new S3FactoryArchiveInventory({ endpoint: "http://127.0.0.1", bucket: "tenant-01", root: "///", credentials: { accessKeyId: "a", secretAccessKey: "b" } })).toThrow("factory_archive_invalid");
  const real = new S3FactoryArchiveInventory({ endpoint: "http://127.0.0.1", bucket: "tenant-01", root: "archive", credentials: { accessKeyId: "a", secretAccessKey: "b" } });
  expect(await (real as unknown as { client: { config: { maxAttempts(): Promise<number> } } }).client.config.maxAttempts()).toBe(1);
});

function pendingOperation(): FactoryReleaseOperation {
  return {
    tenantId: TENANT, projectId: "project-a", operationId: OPERATION, runId: "run-a", nodeInstanceId: "node-a", candidateGeneration: 1,
    candidateDigest: digest("c"), decisionId: "decision-a", contractDigest: digest("d"), executionEpoch: 1, cancellationEpoch: 0, releaseEnableEpoch: 1,
    action: "publish", destination: { provider: "fixture", account: "account-a", object: "releases/one" }, request: { body: "one" },
    destinationDigest: digest("e"), requestDigest: digest("f"), material: material(), materialDigest: digest("a"),
    estimatedSpendMicros: 1, deadlineMs: 1_700_000_100_000, state: "pending", dispatchGeneration: 2, dispatchStarted: false, archiveReady: true,
  };
}

function receiptFor(operation: FactoryReleaseOperation): FactoryProviderReceipt {
  return {
    provider: operation.destination.provider, account: operation.destination.account, object: operation.destination.object,
    requestDigest: operation.requestDigest, operationId: operation.operationId, dispatchGeneration: operation.dispatchGeneration,
    providerReceiptId: "receipt-one", version: "v2", effectDigest: digest("b"),
  };
}

const idleProvider: FactoryReleaseProvider = {
  async publish() { throw new Error("recovery must never dispatch"); },
  async verifyReceipt() { return true; },
  async proveNoEffect() { return false; },
};

test("recovery settles the same operation from its archived receipt and never dispatches again", async () => {
  const archive = new MemoryArchive();
  const role = writer({ archive, inventory: inventoryOf(archive) }).writer;
  const started = { ...pendingOperation(), state: "executing" as const, dispatchStarted: true, senderToken: "sender-a", materialArchive: await role.writeImmutable(TENANT, OPERATION, "material", materialBytes()) };
  const receipt = receiptFor(started);

  const calls: Array<{ generation: number; key: string }> = [];
  let stored = started;
  const releases = {
    async inspect() { return stored; },
    async reconcile(_operator: never, request: { receipt: FactoryProviderReceipt }, expectedGeneration: number, provider: FactoryReleaseProvider, idempotencyKey: string) {
      expect(await provider.verifyReceipt(stored, request.receipt, {})).toBe(true);
      calls.push({ generation: expectedGeneration, key: idempotencyKey });
      stored = { ...stored, state: "succeeded" as never, receipt: request.receipt };
      return stored;
    },
  };
  const recovery = new FactoryArchiveRecovery({ releases, writer: role, operator: { kind: "user", id: "operator-a", authentication: "session" } });

  expect(await recovery.recover("project-a", OPERATION, idleProvider, "key-1")).toMatchObject({ kind: "no_archived_receipt" });
  await archive.writeImmutable(TENANT, OPERATION, "receipt", bytesOf(canonicalJson(receipt)));
  expect(await recovery.recover("project-a", OPERATION, idleProvider, "key-2")).toMatchObject({ kind: "settled_from_archive", receipt });
  expect(calls).toEqual([{ generation: 2, key: "key-2" }]);

  // A second recovery of the settled operation is a no-op, not a second effect.
  expect(await recovery.recover("project-a", OPERATION, idleProvider, "key-3")).toMatchObject({ kind: "already_settled", receipt });
  expect(calls).toHaveLength(1);

  stored = { ...started, state: "pending" as const, dispatchStarted: false };
  expect(await recovery.recover("project-a", OPERATION, idleProvider, "key-4")).toMatchObject({ kind: "not_recoverable" });
  stored = { ...started, state: "succeeded" as const, receipt: undefined as never };
  expect(await recovery.recover("project-a", OPERATION, idleProvider, "key-5")).toMatchObject({ kind: "already_settled" });

  const absent = new FactoryArchiveRecovery({ releases: { async inspect() { return null; }, async reconcile() { throw new Error("unreachable"); } }, writer: role, operator: { kind: "user", id: "operator-a", authentication: "session" } });
  expect(await absent.recover("project-a", OPERATION, idleProvider, "key-6")).toEqual({ kind: "not_recoverable", operation: null });
});
