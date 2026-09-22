import { canonicalJson } from "@ezcorp/extension-contract";
import type { FactoryArtifactReference, JsonValue, RunnerReference } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../db/migrations/types";
import type { FactoryArchiveMemberSources, FactoryArchivePublicationSet } from "./archive-writer";
import { FACTORY_MATERIAL_LIMITS, FactoryAttemptMaterials, FactoryMaterialError, snapshotFactoryMaterialScope, type FactoryArtifactBlobStore, type FactoryMaterialRecord, type FactoryMaterialScope, type FactoryMaterialService } from "./artifact-materials";
import { FactoryArtifacts } from "./artifacts";
import type { FactoryExecutionJournal } from "./executions";
import { assertFactoryIdentity } from "./records";
import { FACTORY_PUBLICATION_PROVENANCE_SCAN_LIMIT, FactoryPublicationProvenance, factoryPublicationProvenanceUntrusted, type FactoryPublicationMembers, type FactoryPublicationOperationFacts, type FactoryVerifiedPublicationAttempt } from "./release-publication-set";
import { sealFactoryReleaseProfileResult, type FactoryAsyncReleaseProfile, type FactoryReleaseProfileInput, type FactoryReleaseProfileResult } from "./release-profile";
import { FACTORY_S3_PUBLICATION_LIMITS, FACTORY_S3_PUBLICATION_REQUEST_SCHEMA_VERSION, assertFactoryS3PublicationRequest, factoryS3PublicationDirectory, type FactoryS3PublicationAttempts, type FactoryS3PublicationMember, type FactoryS3PublicationSetRequest } from "./release-s3-publication";
import { FactoryReleaseError, type FactoryReleaseDestination, type FactoryReleaseMaterial, type FactoryReleaseOperation } from "./releases";

/**
 * What binds one S3 release operation to the attempt that produced its bytes.
 *
 * The derivation itself is NOT here. `release-publication-set.ts` owns it, because W07 and W08
 * independently built the same mapping and one concept may have one implementation. What this file
 * keeps is the part that is genuinely S3's: the material operation and the candidate reference come
 * from the frozen publication request, which pins both.
 *
 * `FactoryS3PublicationProvenance` keeps its name and its whole surface — `attemptForDecision`,
 * `attemptFor`, `sourcesFor`, `publicationSet` — so every W08 caller is unchanged. It is now a thin
 * composition over the shared provenance, and the guarantees it carried are the shared one's
 * guarantees: the accepted protected receipt, its completion, and the execution that must agree.
 */

/** Retained as the S3 spelling of the shared bound. */
export const FACTORY_S3_PROVENANCE_SCAN_LIMIT = FACTORY_PUBLICATION_PROVENANCE_SCAN_LIMIT;

export const FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION = "factory.s3-accepted-publication.v1";

/** The verified attempt behind one acceptance decision. The shared shape, under the S3 name. */
export type FactoryS3VerifiedAttempt = FactoryVerifiedPublicationAttempt;

export interface FactoryS3PublicationProvenanceOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  /** Bounds the accepted-receipt search. Defaults to `FACTORY_S3_PROVENANCE_SCAN_LIMIT`. */
  readonly scanLimit?: number;
}

/**
 * The S3 publication-set scope resolver, and the attempt source the provider reads its members
 * under.
 *
 * One object serves both consumers so the attempt id has exactly one derivation: W04a's
 * `factoryArchivePublicationSet` uses it to archive members before the dispatch claim, and
 * `S3FactoryManifestReleaseProvider` uses it to read those same members at publication time.
 */
export class FactoryS3PublicationProvenance implements FactoryS3PublicationAttempts, FactoryPublicationMembers {
  readonly tenantId: string;
  private readonly provenance: FactoryPublicationProvenance;

  constructor(options: FactoryS3PublicationProvenanceOptions) {
    assertFactoryIdentity(options.tenantId);
    this.tenantId = options.tenantId;
    this.provenance = new FactoryPublicationProvenance({
      database: options.database, tenantId: options.tenantId, members: this,
      ...(options.scanLimit === undefined ? {} : { scanLimit: options.scanLimit }),
    });
  }

  /**
   * The S3 member half: the material operation and the candidate the frozen request pins.
   *
   * The published members are not archived as bytes because one may be the full 256 MiB export and
   * `FACTORY_ARCHIVE_MEMBER_LIMITS.maxMemberBytes` is 16 MiB. Reconciliation does not need them:
   * the archived recovery intent already carries the whole frozen request, so every member's key,
   * media type, and SHA-256 survives in the archive without it.
   */
  async membersFor(facts: FactoryPublicationOperationFacts): Promise<{ materialOperationId: string; candidate: FactoryArtifactReference }> {
    const request = publicationRequestOf(facts.canonicalRequest);
    return { materialOperationId: request.materialOperationId, candidate: request.candidate };
  }

  /**
   * The verified attempt behind one acceptance decision.
   *
   * Used before an operation exists, by the release profile, and again through `attemptFor` once it
   * does.
   */
  attemptForDecision(projectId: string, runId: string, decisionId: string, signal?: AbortSignal): Promise<FactoryS3VerifiedAttempt> {
    return this.provenance.attemptForDecision(projectId, runId, decisionId, signal);
  }

  /** `FactoryS3PublicationAttempts`: the same read, reconciled against a release operation. */
  attemptFor(operation: FactoryReleaseOperation, signal?: AbortSignal): Promise<string> {
    return this.provenance.attemptFor(operation, signal);
  }

  /** W04a's publication-set source resolver for an S3 operation. */
  sourcesFor(tenantId: string, operationId: string, material: FactoryReleaseMaterial, signal?: AbortSignal): Promise<FactoryArchiveMemberSources> {
    return this.provenance.sourcesFor(tenantId, operationId, material, signal);
  }

  /** The seam W09 hands `FactoryArchiveWriter`. */
  publicationSet(): FactoryArchivePublicationSet {
    return this.provenance.publicationSet();
  }
}

/** Reads the frozen publication request out of one stored canonical request envelope. */
function publicationRequestOf(canonicalRequest: string): FactoryS3PublicationSetRequest {
  let parsed: unknown;
  try { parsed = JSON.parse(canonicalRequest); }
  catch { factoryPublicationProvenanceUntrusted(); }
  const envelope = parsed as { provider?: unknown; request?: unknown };
  if (!envelope || typeof envelope !== "object" || envelope.provider !== "s3") factoryPublicationProvenanceUntrusted();
  return assertFactoryS3PublicationRequest(envelope.request, "x");
}

/** One accepted output the protected candidate names for publication. */
export interface FactoryS3AcceptedFile {
  /** The published path under the operation directory. */
  readonly name: string;
  /** The sealed material this file's bytes come from. */
  readonly objectName: string;
  readonly version: number;
}

/**
 * The protected accepted candidate an S3 publication resolves from.
 *
 * The caller chooses where a set lands through `requestedDestination`; this
 * value, which the acceptance decision froze, chooses what is in it.
 */
export interface FactoryS3AcceptedPublication {
  readonly schemaVersion: typeof FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION;
  /** The gateway operation the producing attempt wrote its materials under. */
  readonly materialOperationId: string;
  /** The material holding the accepted candidate manifest itself. */
  readonly candidateObjectName: string;
  readonly candidateVersion: number;
  readonly files: readonly FactoryS3AcceptedFile[];
}

function invalidProfile(): never {
  throw new FactoryReleaseError("factory_s3_profile_invalid");
}

function materialName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > FACTORY_MATERIAL_LIMITS.maxNameLength || value.includes("\0")) invalidProfile();
  return value;
}

function materialVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalidProfile();
  return value as number;
}

/** Every rule the accepted candidate must satisfy before it can name a publication. */
export function assertFactoryS3AcceptedPublication(value: unknown): FactoryS3AcceptedPublication {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidProfile();
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION || Object.keys(record).length !== 5) invalidProfile();
  const materialOperationId = materialName(record.materialOperationId);
  const candidateObjectName = materialName(record.candidateObjectName);
  const candidateVersion = materialVersion(record.candidateVersion);
  if (!Array.isArray(record.files) || record.files.length < 1 || record.files.length > FACTORY_S3_PUBLICATION_LIMITS.maxMembers) invalidProfile();
  let previous = "";
  const files: FactoryS3AcceptedFile[] = record.files.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry as object).length !== 3) invalidProfile();
    const file = entry as Record<string, unknown>;
    if (typeof file.name !== "string" || file.name <= previous) invalidProfile();
    previous = file.name;
    return Object.freeze({ name: file.name, objectName: materialName(file.objectName), version: materialVersion(file.version) });
  });
  return Object.freeze({ schemaVersion: FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION, materialOperationId, candidateObjectName, candidateVersion, files: Object.freeze(files) });
}

/** The directory a caller asked for, validated before it can become a destination. */
export function assertFactoryS3RequestedDirectory(value: unknown, account: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidProfile();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || record.provider !== "s3" || record.account !== account) invalidProfile();
  if (typeof record.object !== "string") invalidProfile();
  try { factoryS3PublicationDirectory({ provider: "s3", account, object: record.object }, account); }
  catch { invalidProfile(); }
  return record.object;
}

export interface FactoryVerifiedAttemptMaterialsOptions {
  readonly database: TransactionalDb;
  readonly blobs: FactoryArtifactBlobStore;
  readonly journal: FactoryExecutionJournal;
}

/**
 * Lists one already-named attempt's own sealed materials, buildable once in a production
 * composition with no authority beyond that one call.
 *
 * `S3FactoryManifestReleaseProfile` is composed once and later resolves for whichever attempt an
 * acceptance decision names; the attempt is not known until `resolve` runs. `FactoryAttemptMaterials`
 * cannot serve that composition directly because it is bound to one attempt's authority at
 * construction, so a single instance could only ever answer for the one attempt it was built with —
 * exactly the gap that left `release.profiles` unbuildable. This reader stays attempt-agnostic at
 * construction. On every call it re-derives the NAMED attempt's own current authority, fresh, from
 * `FactoryExecutionJournal.readAuthorityInTransaction` — the same durable row every attempt-scoped
 * write and read already trusts — and then delegates the actual listing to `FactoryAttemptMaterials`
 * under that freshly read authority. The query, the scope check, and the liveness rule stay the one
 * implementation W04 wrote; nothing here repeats them, widens them, or holds a grant past the call
 * in flight.
 *
 * An attempt id the journal does not currently recognize under the caller's own tenant/project/run
 * is refused by name, before any material row is read. There is no listing by tenant alone: every
 * call is bound to the exact attempt its scope names, so this is not a tenant-wide lister and never
 * answers for an attempt other than the one requested.
 */
export class FactoryVerifiedAttemptMaterials implements Pick<FactoryMaterialService, "list"> {
  private readonly database: TransactionalDb;
  private readonly blobs: FactoryArtifactBlobStore;
  private readonly journal: FactoryExecutionJournal;

  constructor(options: FactoryVerifiedAttemptMaterialsOptions) {
    this.database = options.database;
    this.blobs = options.blobs;
    this.journal = options.journal;
  }

  async list(scopeValue: FactoryMaterialScope, signal?: AbortSignal): Promise<readonly FactoryMaterialRecord[]> {
    const scope = snapshotFactoryMaterialScope(scopeValue);
    signal?.throwIfAborted();
    const authority = await this.journal.readAuthorityInTransaction(this.database, {
      tenantId: scope.tenantId, projectId: scope.projectId, runId: scope.runId, attemptId: scope.attemptId,
    });
    if (!authority) throw new FactoryMaterialError("factory_material_scope_denied");
    signal?.throwIfAborted();
    const artifacts = new FactoryArtifacts(this.database, this.blobs, scope.tenantId);
    const materials = new FactoryAttemptMaterials({ database: this.database, artifacts, blobs: this.blobs, journal: this.journal, authority });
    return materials.list(scope, signal);
  }
}

export interface FactoryS3ManifestReleaseProfileOptions {
  readonly adapter: RunnerReference;
  readonly action?: string;
  /** The destination account this profile may resolve for. */
  readonly account: string;
  readonly provenance: Pick<FactoryS3PublicationProvenance, "attemptForDecision">;
  /** W04's material service. Only its listing is used, and only to pin immutable facts. */
  readonly materials: Pick<FactoryMaterialService, "list">;
  readonly spendMicrosPerMebibyte?: number;
  readonly now?: () => number;
}

/**
 * The S3 half of the shared asynchronous release profile.
 *
 * It runs outside every transaction: it reads the verified attempt, lists the
 * sealed materials that attempt produced, and pins each published file's
 * artifact, digest, media type, byte count, and chunk count from those immutable
 * records. Nothing it returns is recomputed at dispatch time, so the bytes that
 * reach S3 are the bytes the acceptance decision froze.
 */
export class S3FactoryManifestReleaseProfile implements FactoryAsyncReleaseProfile {
  readonly adapter: RunnerReference;
  readonly action: string;
  private readonly now: () => number;
  private readonly spendMicrosPerMebibyte: number;

  constructor(private readonly options: FactoryS3ManifestReleaseProfileOptions) {
    this.adapter = JSON.parse(canonicalJson(options.adapter)) as RunnerReference;
    this.action = options.action ?? "publish-manifest";
    assertFactoryIdentity(this.action);
    this.now = options.now ?? Date.now;
    this.spendMicrosPerMebibyte = options.spendMicrosPerMebibyte ?? 0;
    if (!Number.isSafeInteger(this.spendMicrosPerMebibyte) || this.spendMicrosPerMebibyte < 0) invalidProfile();
    if (!options.account) invalidProfile();
  }

  async resolve(input: FactoryReleaseProfileInput, signal: AbortSignal): Promise<FactoryReleaseProfileResult> {
    signal.throwIfAborted();
    const accepted = assertFactoryS3AcceptedPublication(input.acceptedManifest);
    const object = assertFactoryS3RequestedDirectory(input.requestedDestination, this.options.account);
    const verified = await this.options.provenance.attemptForDecision(input.projectId, input.runId, input.decision.decisionId, signal);
    if (verified.nodeInstanceId !== input.decision.nodeInstanceId || verified.candidateGeneration !== input.decision.candidateGeneration || verified.candidateDigest !== input.decision.candidateDigest) factoryPublicationProvenanceUntrusted();
    const scope: FactoryMaterialScope = {
      tenantId: input.tenantId, projectId: input.projectId, runId: input.runId,
      attemptId: verified.attemptId, operationId: accepted.materialOperationId,
    };
    const sealed = new Map<string, FactoryMaterialRecord>();
    for (const record of await this.options.materials.list(scope, signal)) {
      if (record.sealed && record.artifact) sealed.set(`${record.objectName}:${record.version}`, record);
    }
    signal.throwIfAborted();
    const candidate = sealed.get(`${accepted.candidateObjectName}:${accepted.candidateVersion}`);
    if (!candidate?.artifact) invalidProfile();
    let totalBytes = 0;
    const members: FactoryS3PublicationMember[] = accepted.files.map(file => {
      const record = sealed.get(`${file.objectName}:${file.version}`);
      if (!record?.artifact) invalidProfile();
      totalBytes += record.totalBytes;
      return { name: file.name, mediaType: record.mediaType, digest: record.digest, totalBytes: record.totalBytes, chunkCount: record.chunkCount, artifact: record.artifact };
    });
    const destination: FactoryReleaseDestination = { provider: "s3", account: this.options.account, object };
    const request: FactoryS3PublicationSetRequest = {
      schemaVersion: FACTORY_S3_PUBLICATION_REQUEST_SCHEMA_VERSION,
      materialOperationId: accepted.materialOperationId, candidate: candidate.artifact, members,
    };
    assertFactoryS3PublicationRequest(request, factoryS3PublicationDirectory(destination, this.options.account));
    const estimatedSpendMicros = Math.ceil(totalBytes / (1024 * 1024)) * this.spendMicrosPerMebibyte;
    return sealFactoryReleaseProfileResult(input, { destination, request: request as unknown as JsonValue, estimatedSpendMicros }, this.now());
  }
}
