import { ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import { digestBytes } from "../extensions/v4/blobs";
import { assertFactoryArtifactReference, snapshotFactoryMaterialScope, type FactoryMaterialScope, type FactoryScopedArtifactReader } from "./artifact-materials";
import type { FactoryArchiveObject, FactoryProviderReceipt, FactoryReleaseArchive, FactoryReleaseMaterial, FactoryReleaseOperation, FactoryReleaseProvider } from "./releases";
import type { FactoryPrincipal } from "./grants";

/**
 * C06's independent release archive, composed as the C02 gateway's
 * archive-writer role.
 *
 * The role holds the archive credential set and nothing else: it never receives
 * the product store's credentials, and the product store never receives its.
 * On this development host both S3 services run on one machine, so that
 * separation is all the deployment proves. The failure-domain record says so in
 * its own field rather than in a comment, and `unmetCriteria` names the
 * criterion the host cannot meet.
 */

/** Archive object names. The same four `src/factory/releases.ts` writes. */
export type FactoryArchiveName = "intent" | "material" | "receipt" | "reconciliation";

export const FACTORY_ARCHIVE_MEMBER_LIMITS = Object.freeze({
  /** Candidate, request, and every evidence object one operation may archive. */
  maxMembers: 256,
  maxMemberBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  /** One S3 listing page is the whole inventory an operation may hold. */
  maxInventoryKeys: 1024,
});

export const FACTORY_ARCHIVE_MANIFEST_SCHEMA_VERSION = "factory.archive-member-manifest.v1";
export const FACTORY_ARCHIVE_READINESS_SCHEMA_VERSION = "factory.archive-readiness.v1";
export const FACTORY_ARCHIVE_FAILURE_DOMAIN_SCHEMA_VERSION = "factory.archive-failure-domain.v1";

/**
 * The criterion a same-host deployment cannot meet. It is a named constant so a
 * gate file, a readiness result, and a receipt all state the same unmet thing.
 */
export const FACTORY_ARCHIVE_DEPLOYED_INDEPENDENCE = "deployed-independent-failure-domain";
export const FACTORY_ARCHIVE_CREDENTIAL_SEPARATION = "archive-credential-separation";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CREDENTIAL_SET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const encoder = new TextEncoder();

export class FactoryArchiveWriterError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "FactoryArchiveWriterError";
  }
}

function invalid(): never { throw new FactoryArchiveWriterError("factory_archive_invalid"); }

/** Every archived member carries the role that made it part of the recovery set. */
export type FactoryArchiveMemberRole = "candidate" | "evidence" | "request";

export interface FactoryArchiveMemberPlan {
  readonly role: FactoryArchiveMemberRole;
  /** Stable within the operation. Two plans for the same bytes share one name. */
  readonly memberName: string;
  readonly scope: FactoryMaterialScope;
  readonly artifact: FactoryArtifactReference;
}

export interface FactoryArchivedMember extends FactoryArchiveMemberPlan {
  /** `sha256:` over the archived bytes, which are the assembled material bytes. */
  readonly digest: string;
  readonly encodedBytes: number;
  readonly object: FactoryArchiveObject;
}

/**
 * The only durable list of what an operation archived. It lives in the archive
 * beside its members, so a restore that has lost the product database can still
 * enumerate the recovery set.
 */
export interface FactoryArchiveMemberManifest {
  readonly schemaVersion: typeof FACTORY_ARCHIVE_MANIFEST_SCHEMA_VERSION;
  readonly tenantId: string;
  readonly operationId: string;
  /** Binds the manifest to the exact pinned material it was resolved from. */
  readonly materialDigest: string;
  readonly members: readonly FactoryArchivedMember[];
}

/** The pinned references composition resolves for one operation, never caller JSON. */
export interface FactoryArchiveMemberSources {
  readonly scope: FactoryMaterialScope;
  readonly candidate?: FactoryArtifactReference;
  readonly request?: FactoryArtifactReference;
}

/** Resolves the exact member set the archive must hold before a dispatch claim. */
export interface FactoryArchivePublicationSet {
  plan(tenantId: string, operationId: string, material: FactoryReleaseMaterial, signal?: AbortSignal): Promise<readonly FactoryArchiveMemberPlan[]>;
}

export type FactoryArchiveFailureDomain =
  | "same-host-not-independent"
  | "separate-host-replication-unproven"
  | "separately-deployed-independent";

export interface FactoryArchiveFailureDomainInput {
  readonly productEndpoint: string;
  readonly archiveEndpoint: string;
  /** Credential set names, never values. */
  readonly productCredentialSet: string;
  readonly archiveCredentialSet: string;
  /** An operator's verified replication statement. Absent on a development host. */
  readonly independentReplicationEvidence?: string;
}

export interface FactoryArchiveFailureDomainRecord {
  readonly schemaVersion: typeof FACTORY_ARCHIVE_FAILURE_DOMAIN_SCHEMA_VERSION;
  readonly failureDomain: FactoryArchiveFailureDomain;
  readonly productHost: string;
  readonly archiveHost: string;
  readonly productCredentialSet: string;
  readonly archiveCredentialSet: string;
  readonly credentialsSeparated: boolean;
  readonly deployedIndependenceProven: boolean;
  readonly unmetCriteria: readonly string[];
}

export type FactoryArchiveReadinessCheckId =
  | "conditional_create"
  | "checksum_verified"
  | "version_read"
  | "immutable_rewrite"
  | "product_read_denied"
  | "product_overwrite_denied"
  | "product_delete_denied"
  | "restore_read_denied"
  | "restore_overwrite_denied"
  | "restore_delete_denied"
  | "archive_survives_product_loss"
  | "deployed_failure_domain_independent";

export interface FactoryArchiveReadinessCheck {
  readonly id: FactoryArchiveReadinessCheckId;
  readonly passed: boolean;
  readonly detail: string;
}

export interface FactoryArchiveReadinessResult {
  readonly schemaVersion: typeof FACTORY_ARCHIVE_READINESS_SCHEMA_VERSION;
  /** Every operational check passed, so the role may serve this deployment. */
  readonly ready: boolean;
  /** `ready` and a proven deployed failure domain. False on a same-host profile. */
  readonly publicationGrade: boolean;
  readonly checks: readonly FactoryArchiveReadinessCheck[];
  readonly failureDomain: FactoryArchiveFailureDomainRecord;
  readonly unmetCriteria: readonly string[];
  readonly checkedAtMs: number;
}

/** One attempt by a credential set that must never reach the archive. */
export interface FactoryArchiveDenialAttempt {
  readonly credentialSet: "product" | "restore";
  readonly operation: "read" | "overwrite" | "delete";
  readonly object: FactoryArchiveObject;
}

/** Composition owns the non-archive credentials; the writer only reads the verdict. */
export interface FactoryArchiveDenialProbe {
  attempt(attempt: FactoryArchiveDenialAttempt, signal?: AbortSignal): Promise<"denied" | "permitted">;
}

/** Reports whether the ordinary product store answers right now. */
export interface FactoryArchiveProductStoreProbe {
  reachable(signal?: AbortSignal): Promise<boolean>;
}

/** Lists the immutable objects under one archive path prefix. */
export interface FactoryArchiveInventory {
  list(prefix: string, signal?: AbortSignal): Promise<readonly FactoryArchiveObject[]>;
}

function endpointHost(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { invalid(); }
  if (!url.hostname) invalid();
  return url.hostname;
}

function credentialSetName(value: string): string {
  if (typeof value !== "string" || !CREDENTIAL_SET.test(value)) invalid();
  return value;
}

/**
 * Classifies what the deployment actually proves. Different hosts alone are not
 * independence: without an operator's replication statement the verdict stays
 * `separate-host-replication-unproven`, and the same-host case never claims more
 * than credential separation.
 */
export function factoryArchiveFailureDomain(input: FactoryArchiveFailureDomainInput): FactoryArchiveFailureDomainRecord {
  const productHost = endpointHost(input.productEndpoint);
  const archiveHost = endpointHost(input.archiveEndpoint);
  const productCredentialSet = credentialSetName(input.productCredentialSet);
  const archiveCredentialSet = credentialSetName(input.archiveCredentialSet);
  const credentialsSeparated = productCredentialSet !== archiveCredentialSet;
  const evidence = input.independentReplicationEvidence;
  if (evidence !== undefined && (typeof evidence !== "string" || evidence.length < 1 || evidence.length > 512)) invalid();
  const sameHost = productHost === archiveHost;
  const deployedIndependenceProven = credentialsSeparated && !sameHost && evidence !== undefined;
  const unmetCriteria = [
    ...(credentialsSeparated ? [] : [FACTORY_ARCHIVE_CREDENTIAL_SEPARATION]),
    ...(deployedIndependenceProven ? [] : [FACTORY_ARCHIVE_DEPLOYED_INDEPENDENCE]),
  ];
  return Object.freeze({
    schemaVersion: FACTORY_ARCHIVE_FAILURE_DOMAIN_SCHEMA_VERSION,
    failureDomain: deployedIndependenceProven ? "separately-deployed-independent" : sameHost ? "same-host-not-independent" : "separate-host-replication-unproven",
    productHost, archiveHost, productCredentialSet, archiveCredentialSet,
    credentialsSeparated, deployedIndependenceProven,
    unmetCriteria: Object.freeze(unmetCriteria),
  });
}

/**
 * The per-member and aggregate byte bounds for one operation's archive set. A
 * member is bounded by the shared artifact ceiling and the whole set by the
 * material ceiling, so one operation cannot turn the archive into unbounded
 * storage by naming many large objects.
 */
export function assertFactoryArchiveMemberBytes(memberBytes: number, totalBytes: number): void {
  if (memberBytes > FACTORY_ARCHIVE_MEMBER_LIMITS.maxMemberBytes || totalBytes > FACTORY_ARCHIVE_MEMBER_LIMITS.maxTotalBytes) throw new FactoryArchiveWriterError("factory_archive_member_limit");
}

function artifactKey(role: FactoryArchiveMemberRole, artifact: FactoryArtifactReference): string {
  return `${role} ${artifact.artifactId} ${artifact.digest}`;
}

/** Collects every artifact reference a pinned evidence set names, in a stable order. */
function evidenceArtifacts(evidence: readonly unknown[]): readonly FactoryArtifactReference[] {
  const found = new Map<string, FactoryArtifactReference>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const entry of value) visit(entry, depth + 1); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.artifactId === "string" && typeof record.digest === "string" && typeof record.encodedBytes === "number") {
      const reference = assertFactoryArtifactReference(record as unknown as FactoryArtifactReference, FACTORY_ARCHIVE_MEMBER_LIMITS.maxMemberBytes);
      found.set(artifactKey("evidence", reference), reference);
      return;
    }
    for (const entry of Object.values(record)) visit(entry, depth + 1);
  };
  visit(evidence, 0);
  return [...found.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, reference]) => reference);
}

/**
 * The default member plan. The candidate and request references come from
 * pinned product facts; the evidence references come from the material the
 * acceptance decision froze. Ordering is deterministic so a retried archive
 * write rebuilds the identical manifest and lands on the identical key.
 */
export function factoryArchiveMemberPlan(sources: FactoryArchiveMemberSources, material: FactoryReleaseMaterial): readonly FactoryArchiveMemberPlan[] {
  const scope = snapshotFactoryMaterialScope(sources.scope);
  if (!material || typeof material !== "object" || !Array.isArray(material.evidence)) invalid();
  const plans: FactoryArchiveMemberPlan[] = [];
  const seen = new Set<string>();
  const add = (role: FactoryArchiveMemberRole, memberName: string, value: FactoryArtifactReference): void => {
    const artifact = assertFactoryArtifactReference(value, FACTORY_ARCHIVE_MEMBER_LIMITS.maxMemberBytes);
    const key = artifactKey(role, artifact);
    if (seen.has(key)) return;
    seen.add(key);
    plans.push(Object.freeze({ role, memberName, scope, artifact }));
  };
  if (sources.candidate) add("candidate", "candidate", sources.candidate);
  if (sources.request) add("request", "request", sources.request);
  for (const artifact of evidenceArtifacts(material.evidence)) add("evidence", `evidence/${artifact.artifactId}`, artifact);
  if (plans.length > FACTORY_ARCHIVE_MEMBER_LIMITS.maxMembers) throw new FactoryArchiveWriterError("factory_archive_member_limit");
  return Object.freeze(plans);
}

/** Wraps a per-operation source resolver as the publication-set seam. */
export function factoryArchivePublicationSet(resolve: (tenantId: string, operationId: string, material: FactoryReleaseMaterial, signal?: AbortSignal) => FactoryArchiveMemberSources | Promise<FactoryArchiveMemberSources>): FactoryArchivePublicationSet {
  return {
    async plan(tenantId, operationId, material, signal) {
      return factoryArchiveMemberPlan(await resolve(tenantId, operationId, material, signal), material);
    },
  };
}

export interface FactoryArchiveWriterOptions {
  /** The credential-separated archive adapter. It holds archive credentials only. */
  readonly archive: FactoryReleaseArchive;
  /** W04's one scoped reader. Every member is read through it and nothing else. */
  readonly reader: FactoryScopedArtifactReader;
  readonly publicationSet: FactoryArchivePublicationSet;
  readonly failureDomain: FactoryArchiveFailureDomainRecord;
  readonly inventory?: FactoryArchiveInventory;
  readonly denialProbe?: FactoryArchiveDenialProbe;
  readonly now?: () => number;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function parseMaterial(bytes: Uint8Array): FactoryReleaseMaterial {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new FactoryArchiveWriterError("factory_archive_material_unreadable"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray((parsed as FactoryReleaseMaterial).evidence)) throw new FactoryArchiveWriterError("factory_archive_material_unreadable");
  return parsed as FactoryReleaseMaterial;
}

/** Strips `<name>/<digest>` from a known reference to reach the operation prefix. */
function operationPrefix(reference: FactoryArchiveObject, name: FactoryArchiveName): string {
  if (!reference || typeof reference.key !== "string" || typeof reference.digest !== "string" || !DIGEST.test(reference.digest)) invalid();
  const suffix = `/${name}/${reference.digest.slice(7)}`;
  if (!reference.key.endsWith(suffix)) throw new FactoryArchiveWriterError("factory_archive_foreign_prefix");
  return reference.key.slice(0, -suffix.length);
}

/**
 * The gateway's archive-writer role.
 *
 * It is a `FactoryReleaseArchive`, so the shared release store composes it
 * without any change: `prepare` still writes the intent and then the material
 * before it sets `archive_ready`, and `dispatch` still archives the receipt
 * before it settles the product row. What this role adds is the rest of C04
 * step 1 — every candidate, evidence, and request object the material names is
 * archived and verified during the material write, so a missing or corrupt
 * member leaves `archive_ready` false and publication stays pending.
 */
export class FactoryArchiveWriter implements FactoryReleaseArchive {
  readonly failureDomain: FactoryArchiveFailureDomainRecord;
  private readonly archive: FactoryReleaseArchive;
  private readonly reader: FactoryScopedArtifactReader;
  private readonly publicationSet: FactoryArchivePublicationSet;
  private readonly inventory?: FactoryArchiveInventory;
  private readonly denialProbe?: FactoryArchiveDenialProbe;
  private readonly now: () => number;

  constructor(options: FactoryArchiveWriterOptions) {
    this.archive = options.archive;
    this.reader = options.reader;
    this.publicationSet = options.publicationSet;
    this.failureDomain = options.failureDomain;
    this.inventory = options.inventory;
    this.denialProbe = options.denialProbe;
    this.now = options.now ?? Date.now;
    if (this.failureDomain.schemaVersion !== FACTORY_ARCHIVE_FAILURE_DOMAIN_SCHEMA_VERSION) invalid();
  }

  async writeImmutable(tenantId: string, operationId: string, name: FactoryArchiveName, bytes: Uint8Array): Promise<FactoryArchiveObject> {
    if (name === "material") await this.archiveMembers(tenantId, operationId, parseMaterial(bytes), bytes);
    return this.archive.writeImmutable(tenantId, operationId, name, bytes);
  }

  async read(reference: FactoryArchiveObject): Promise<Uint8Array> {
    return this.archive.read(reference);
  }

  /**
   * Archives every member and then the manifest that names them. Each member is
   * read through the scoped reader, written immutably, and read back byte for
   * byte; the first failure aborts before the material object exists.
   */
  private async archiveMembers(tenantId: string, operationId: string, material: FactoryReleaseMaterial, materialBytes: Uint8Array, signal?: AbortSignal): Promise<FactoryArchiveMemberManifest> {
    const plans = await this.publicationSet.plan(tenantId, operationId, material, signal);
    if (plans.length > FACTORY_ARCHIVE_MEMBER_LIMITS.maxMembers) throw new FactoryArchiveWriterError("factory_archive_member_limit");
    const members: FactoryArchivedMember[] = [];
    let total = 0;
    for (const plan of plans) {
      let content: Uint8Array;
      try { content = await this.reader.read(plan.scope, plan.artifact, signal); }
      catch { throw new FactoryArchiveWriterError("factory_archive_member_unavailable"); }
      total += content.byteLength;
      assertFactoryArchiveMemberBytes(content.byteLength, total);
      const object = await this.archive.writeImmutable(tenantId, operationId, "material", content);
      const digest = `sha256:${digestBytes(content)}`;
      if (object.digest !== digest || !sameBytes(content, await this.archive.read(object))) throw new FactoryArchiveWriterError("factory_archive_member_corrupt");
      members.push({ ...plan, digest, encodedBytes: content.byteLength, object });
    }
    const manifest: FactoryArchiveMemberManifest = {
      schemaVersion: FACTORY_ARCHIVE_MANIFEST_SCHEMA_VERSION, tenantId, operationId,
      materialDigest: `sha256:${digestBytes(materialBytes)}`, members,
    };
    const manifestBytes = encoder.encode(canonicalJson(manifest));
    const stored = await this.archive.writeImmutable(tenantId, operationId, "material", manifestBytes);
    if (!sameBytes(manifestBytes, await this.archive.read(stored))) throw new FactoryArchiveWriterError("factory_archive_manifest_corrupt");
    return manifest;
  }

  private requireInventory(): FactoryArchiveInventory {
    if (!this.inventory) throw new FactoryArchiveWriterError("factory_archive_inventory_unavailable");
    return this.inventory;
  }

  /**
   * Re-reads the member manifest from the archive alone, given only a reference
   * the operation already holds. A restore uses this when the product row is
   * gone and only the archive survives.
   */
  async readManifest(materialArchive: FactoryArchiveObject, materialDigest: string, signal?: AbortSignal): Promise<FactoryArchiveMemberManifest> {
    if (!DIGEST.test(materialDigest)) invalid();
    const prefix = `${operationPrefix(materialArchive, "material")}/material`;
    for (const object of await this.requireInventory().list(prefix, signal)) {
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder().decode(await this.archive.read(object))); }
      catch { continue; }
      const candidate = parsed as FactoryArchiveMemberManifest;
      if (candidate?.schemaVersion === FACTORY_ARCHIVE_MANIFEST_SCHEMA_VERSION && candidate.materialDigest === materialDigest) return candidate;
    }
    throw new FactoryArchiveWriterError("factory_archive_manifest_missing");
  }

  /**
   * The confirmed receipt this operation archived, found from the archive alone.
   * A receipt that names another operation, another generation, or another
   * request never matches, so a foreign object cannot settle this row.
   */
  async readArchivedReceipt(operation: FactoryReleaseOperation, signal?: AbortSignal): Promise<FactoryProviderReceipt | null> {
    const reference = operation.receiptArchive ?? operation.materialArchive;
    if (!reference) throw new FactoryArchiveWriterError("factory_archive_reference_missing");
    const prefix = `${operationPrefix(reference, operation.receiptArchive ? "receipt" : "material")}/receipt`;
    for (const object of await this.requireInventory().list(prefix, signal)) {
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder().decode(await this.archive.read(object))); }
      catch { continue; }
      const receipt = parsed as FactoryProviderReceipt;
      if (receipt?.operationId === operation.operationId && receipt.dispatchGeneration === operation.dispatchGeneration
        && receipt.requestDigest === operation.requestDigest && receipt.provider === operation.destination.provider
        && receipt.account === operation.destination.account && receipt.object === operation.destination.object) return receipt;
    }
    return null;
  }

  /**
   * Proves the archive answers while the ordinary product store does not. It
   * fails closed when the product store is still reachable, because a round
   * trip taken while both stores are up proves nothing about either.
   */
  async proveIndependentOfProductStore(productStore: FactoryArchiveProductStoreProbe, tenantId: string, operationId: string, signal?: AbortSignal): Promise<FactoryArchiveReadinessCheck> {
    if (await productStore.reachable(signal)) return { id: "archive_survives_product_loss", passed: false, detail: "the ordinary product store was still reachable, so this run proves nothing about losing it" };
    const bytes = encoder.encode(canonicalJson({ probe: "archive-survives-product-loss", tenantId, operationId }));
    const object = await this.archive.writeImmutable(tenantId, operationId, "reconciliation", bytes);
    const restored = await this.archive.read(object);
    return sameBytes(bytes, restored)
      ? { id: "archive_survives_product_loss", passed: true, detail: `the archive wrote and returned ${bytes.byteLength} exact bytes while the ordinary store was unreachable` }
      : { id: "archive_survives_product_loss", passed: false, detail: "the archive returned different bytes" };
  }

  /**
   * The role's publication readiness. Operational checks prove conditional
   * create, checksum, version reads, and that no product or restore credential
   * reaches the archive. The deployed-independence check reports the deployment
   * as it is, so a same-host profile can be ready without ever being called
   * publication grade.
   */
  async checkReadiness(tenantId: string, operationId: string, signal?: AbortSignal): Promise<FactoryArchiveReadinessResult> {
    const checks: FactoryArchiveReadinessCheck[] = [];
    const bytes = encoder.encode(canonicalJson({ probe: "archive-readiness", tenantId, operationId, at: this.now() }));
    const digest = `sha256:${digestBytes(bytes)}`;
    const object = await this.archive.writeImmutable(tenantId, operationId, "reconciliation", bytes);
    checks.push({ id: "conditional_create", passed: object.digest === digest, detail: `conditional create returned ${object.digest}` });
    checks.push({ id: "checksum_verified", passed: sameBytes(bytes, await this.archive.read(object)), detail: "the archive returned the exact written bytes" });
    checks.push({ id: "version_read", passed: typeof object.versionId === "string" && object.versionId.length > 0, detail: "the archive returned an immutable object version" });
    const repeat = await this.archive.writeImmutable(tenantId, operationId, "reconciliation", bytes);
    checks.push({ id: "immutable_rewrite", passed: repeat.key === object.key && repeat.digest === object.digest, detail: "rewriting the same bytes reuses the same immutable object" });
    for (const credentialSet of ["product", "restore"] as const) {
      for (const operation of ["read", "overwrite", "delete"] as const) {
        checks.push(await this.probeDenied({ credentialSet, operation, object }, signal));
      }
    }
    checks.push({
      id: "deployed_failure_domain_independent",
      passed: this.failureDomain.deployedIndependenceProven,
      detail: `failure domain is ${this.failureDomain.failureDomain}; credential separation is ${this.failureDomain.credentialsSeparated ? "proven" : "absent"}`,
    });
    const ready = checks.every(check => check.passed || check.id === "deployed_failure_domain_independent");
    return {
      schemaVersion: FACTORY_ARCHIVE_READINESS_SCHEMA_VERSION,
      ready, publicationGrade: ready && this.failureDomain.deployedIndependenceProven,
      checks, failureDomain: this.failureDomain,
      unmetCriteria: [...this.failureDomain.unmetCriteria, ...checks.filter(check => !check.passed && check.id !== "deployed_failure_domain_independent").map(check => check.id)],
      checkedAtMs: this.now(),
    };
  }

  private async probeDenied(attempt: FactoryArchiveDenialAttempt, signal?: AbortSignal): Promise<FactoryArchiveReadinessCheck> {
    const id = `${attempt.credentialSet}_${attempt.operation}_denied` as FactoryArchiveReadinessCheckId;
    if (!this.denialProbe) return { id, passed: false, detail: "no denial probe is configured, so this deployment has not proven the restriction" };
    const verdict = await this.denialProbe.attempt(attempt, signal);
    return { id, passed: verdict === "denied", detail: `${attempt.credentialSet} credentials were ${verdict} a ${attempt.operation} of an archive object` };
  }
}

export interface FactoryS3ArchiveInventoryOptions {
  readonly endpoint: string;
  readonly bucket: string;
  /** The archive adapter's root prefix. A listing outside it is refused. */
  readonly root: string;
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string };
  readonly region?: string;
  readonly client?: Pick<S3Client, "send">;
}

/**
 * Lists one operation's immutable archive objects. It exists so a restore can
 * find the member manifest and the confirmed receipt with the archive alone,
 * and it reads keys rather than constructing them, so it shares the archive
 * adapter's layout without copying it.
 */
export class S3FactoryArchiveInventory implements FactoryArchiveInventory {
  private readonly client: Pick<S3Client, "send">;
  private readonly root: string;
  constructor(private readonly options: FactoryS3ArchiveInventoryOptions) {
    this.root = options.root.replace(/^\/+|\/+$/g, "");
    if (!this.root) invalid();
    this.client = options.client ?? new S3Client({ endpoint: options.endpoint, region: options.region ?? "us-east-1", forcePathStyle: true, credentials: options.credentials, maxAttempts: 1 });
  }

  async list(prefix: string, signal?: AbortSignal): Promise<readonly FactoryArchiveObject[]> {
    if (typeof prefix !== "string" || !prefix.startsWith(`${this.root}/`)) throw new FactoryArchiveWriterError("factory_archive_foreign_prefix");
    const listed = await this.client.send(
      new ListObjectVersionsCommand({ Bucket: this.options.bucket, Prefix: `${prefix}/`, MaxKeys: FACTORY_ARCHIVE_MEMBER_LIMITS.maxInventoryKeys }),
      signal ? { abortSignal: signal } : undefined,
    ) as { Versions?: ReadonlyArray<{ Key?: string; VersionId?: string; IsLatest?: boolean }> };
    const objects: FactoryArchiveObject[] = [];
    for (const version of listed.Versions ?? []) {
      const key = version.Key;
      if (!key || !version.VersionId || version.IsLatest === false) continue;
      const raw = key.slice(prefix.length + 1);
      if (!/^[a-f0-9]{64}$/.test(raw)) continue;
      objects.push({ key, digest: `sha256:${raw}`, versionId: version.VersionId });
    }
    return objects;
  }
}

/** The subset of the shared release store this recovery drives. Nothing dispatches. */
export interface FactoryArchiveRecoveryTarget {
  inspect(projectId: string, operationId: string): Promise<FactoryReleaseOperation | null>;
  reconcile(operator: FactoryPrincipal, request: { readonly projectId: string; readonly operationId: string; readonly action: "attach_receipt"; readonly reason: string; readonly providerEvidence: unknown; readonly receipt: FactoryProviderReceipt }, expectedGeneration: number, provider: FactoryReleaseProvider, idempotencyKey: string): Promise<FactoryReleaseOperation>;
}

export type FactoryArchiveRecoveryKind = "already_settled" | "settled_from_archive" | "no_archived_receipt" | "not_recoverable";

export interface FactoryArchiveRecoveryOutcome {
  readonly kind: FactoryArchiveRecoveryKind;
  readonly operation: FactoryReleaseOperation | null;
  readonly receipt?: FactoryProviderReceipt;
}

export interface FactoryArchiveRecoveryOptions {
  readonly releases: FactoryArchiveRecoveryTarget;
  readonly writer: FactoryArchiveWriter;
  readonly operator: FactoryPrincipal;
}

/**
 * Recovers an operation whose confirmed receipt reached the archive but not the
 * product database. It settles the same operation by identity and never sends a
 * second request: the provider is used only to verify that the archived receipt
 * still describes the live object, which is what keeps a forged or stale
 * archive object from settling anything.
 */
export class FactoryArchiveRecovery {
  constructor(private readonly options: FactoryArchiveRecoveryOptions) {}

  async recover(projectId: string, operationId: string, provider: FactoryReleaseProvider, idempotencyKey: string): Promise<FactoryArchiveRecoveryOutcome> {
    const operation = await this.options.releases.inspect(projectId, operationId);
    if (!operation) return { kind: "not_recoverable", operation: null };
    if (operation.state === "succeeded") return { kind: "already_settled", operation, ...(operation.receipt ? { receipt: operation.receipt } : {}) };
    if (operation.state !== "uncertain" && !(operation.state === "executing" && operation.dispatchStarted)) return { kind: "not_recoverable", operation };
    const receipt = await this.options.writer.readArchivedReceipt(operation);
    if (!receipt) return { kind: "no_archived_receipt", operation };
    const settled = await this.options.releases.reconcile(this.options.operator, {
      projectId, operationId, action: "attach_receipt",
      reason: "the confirmed receipt was archived before the product store recorded it",
      providerEvidence: { source: "release-archive", operationId, dispatchGeneration: operation.dispatchGeneration, providerReceiptId: receipt.providerReceiptId },
      receipt,
    }, operation.dispatchGeneration, provider, idempotencyKey);
    return { kind: "settled_from_archive", operation: settled, receipt };
  }
}
