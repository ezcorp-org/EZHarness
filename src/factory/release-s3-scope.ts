import { canonicalJson } from "@ezcorp/extension-contract";
import type { JsonValue, RunnerReference } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { factoryArchivePublicationSet, type FactoryArchiveMemberSources, type FactoryArchivePublicationSet } from "./archive-writer";
import { FACTORY_MATERIAL_LIMITS, type FactoryMaterialRecord, type FactoryMaterialScope, type FactoryMaterialService } from "./artifact-materials";
import { assertFactoryIdentity } from "./records";
import { sealFactoryReleaseProfileResult, type FactoryAsyncReleaseProfile, type FactoryReleaseProfileInput, type FactoryReleaseProfileResult } from "./release-profile";
import { FACTORY_S3_PUBLICATION_LIMITS, FACTORY_S3_PUBLICATION_REQUEST_SCHEMA_VERSION, assertFactoryS3PublicationRequest, factoryS3PublicationDirectory, type FactoryS3PublicationAttempts, type FactoryS3PublicationMember, type FactoryS3PublicationSetRequest } from "./release-s3-publication";
import { FactoryReleaseError, type FactoryReleaseDestination, type FactoryReleaseMaterial, type FactoryReleaseOperation } from "./releases";

/**
 * What binds one S3 release operation to the attempt that produced its bytes.
 *
 * W04a asked whoever owns this mapping to name the pinned source it reads the
 * attempt id from. It is the verified protected command provenance and nothing
 * else, in three durable hops:
 *
 * 1. `factory_release_operations` gives the operation's project, run, node
 *    instance, candidate generation, decision, and candidate digest.
 * 2. `factory_protected_command_effects` gives the accepted protected command
 *    receipt for that decision. Its `source` is the output of
 *    `resolveFactoryProtectedTaskSource`, so the command id it names is the
 *    stopped, non-uncertain task attempt at the current generation.
 * 3. `factory_task_completions` gives that command's `attempt_id`, which
 *    `protected-command-effects.ts` already proved equals the verified
 *    terminal's attempt.
 *
 * `factory_executions` then has to agree that the attempt ran that node at that
 * generation. Nothing in a caller's request, a claim, or a publication set can
 * move the attempt, so a request cannot widen the scope it is read under.
 */

/** How many accepted protected receipts one run may hold before the search gives up. */
export const FACTORY_S3_PROVENANCE_SCAN_LIMIT = 512;

export const FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION = "factory.s3-accepted-publication.v1";

/** The verified attempt behind one acceptance decision. */
export interface FactoryS3VerifiedAttempt {
  readonly attemptId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly candidateGeneration: number;
  readonly decisionId: string;
  readonly candidateDigest: string;
}

interface AcceptanceReceiptShape {
  readonly kind: string;
  readonly outcome: string;
  readonly reference: { readonly tenantId: string; readonly projectId: string; readonly logicalRunId: string; readonly interpreterId: string };
  readonly source: { readonly nodeInstanceId: string; readonly candidateGeneration: number; readonly attempt: { readonly commandId: string } };
  readonly decision: { readonly decisionId: string; readonly nodeInstanceId: string; readonly candidateGeneration: number; readonly candidateDigest: string };
}

interface OperationRow {
  readonly project_id: string;
  readonly run_id: string;
  readonly node_instance_id: string;
  readonly candidate_generation: number | string;
  readonly candidate_digest: string;
  readonly decision_id: string;
  readonly canonical_request: string;
}

function provenanceMissing(): never {
  throw new FactoryReleaseError("factory_s3_provenance_missing");
}

function provenanceUntrusted(): never {
  throw new FactoryReleaseError("factory_s3_provenance_untrusted");
}

/** The one place a stored protected receipt becomes a typed acceptance. */
function acceptanceReceipt(encoded: string): AcceptanceReceiptShape | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(encoded); }
  catch { return undefined; }
  const receipt = parsed as AcceptanceReceiptShape;
  if (!receipt || typeof receipt !== "object" || receipt.kind !== "request-acceptance" || receipt.outcome !== "accepted") return undefined;
  if (!receipt.reference || !receipt.source?.attempt || !receipt.decision) return undefined;
  if (typeof receipt.source.attempt.commandId !== "string" || typeof receipt.decision.decisionId !== "string") return undefined;
  return receipt;
}

export interface FactoryS3PublicationProvenanceOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  /** Bounds the accepted-receipt search. Defaults to `FACTORY_S3_PROVENANCE_SCAN_LIMIT`. */
  readonly scanLimit?: number;
}

/**
 * The S3 publication-set scope resolver, and the attempt source the provider
 * reads its members under.
 *
 * One object serves both consumers so the attempt id has exactly one derivation:
 * W04a's `factoryArchivePublicationSet` uses it to archive members before the
 * dispatch claim, and `S3FactoryManifestReleaseProvider` uses it to read those
 * same members at publication time.
 */
export class FactoryS3PublicationProvenance implements FactoryS3PublicationAttempts {
  readonly tenantId: string;
  private readonly database: TransactionalDb;
  private readonly scanLimit: number;

  constructor(options: FactoryS3PublicationProvenanceOptions) {
    assertFactoryIdentity(options.tenantId);
    this.tenantId = options.tenantId;
    this.database = options.database;
    this.scanLimit = options.scanLimit ?? FACTORY_S3_PROVENANCE_SCAN_LIMIT;
    if (!Number.isSafeInteger(this.scanLimit) || this.scanLimit < 1 || this.scanLimit > FACTORY_S3_PROVENANCE_SCAN_LIMIT) throw new FactoryReleaseError("factory_s3_provenance_invalid");
  }

  /**
   * The verified attempt behind one acceptance decision.
   *
   * Used before an operation exists, by the release profile, and again through
   * `attemptFor` once it does.
   */
  async attemptForDecision(projectId: string, runId: string, decisionId: string, signal?: AbortSignal): Promise<FactoryS3VerifiedAttempt> {
    signal?.throwIfAborted();
    return this.database.transaction(transaction => this.readInTransaction(transaction, projectId, runId, decisionId));
  }

  private async readInTransaction(transaction: MigrationDb, projectId: string, runId: string, decisionId: string): Promise<FactoryS3VerifiedAttempt> {
    const candidates = rows<{ receipt_json: string }>(await transaction.execute(sql`SELECT receipt_json FROM factory_protected_command_effects
      WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND run_id=${runId} AND kind='request-acceptance' AND decision='accepted'
      ORDER BY command_id LIMIT ${this.scanLimit}`));
    const matches = candidates.map(row => acceptanceReceipt(row.receipt_json)).filter((receipt): receipt is AcceptanceReceiptShape => receipt?.decision.decisionId === decisionId);
    if (matches.length !== 1) provenanceMissing();
    const receipt = matches[0]!;
    if (receipt.reference.tenantId !== this.tenantId || receipt.reference.projectId !== projectId || receipt.reference.logicalRunId !== runId) provenanceUntrusted();
    if (receipt.decision.nodeInstanceId !== receipt.source.nodeInstanceId || receipt.decision.candidateGeneration !== receipt.source.candidateGeneration) provenanceUntrusted();
    const completion = rows<{ attempt_id: string }>(await transaction.execute(sql`SELECT attempt_id FROM factory_task_completions
      WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND run_id=${runId} AND interpreter_id=${receipt.reference.interpreterId} AND command_id=${receipt.source.attempt.commandId}`))[0];
    if (!completion) provenanceMissing();
    const execution = rows<{ attempt_id: string }>(await transaction.execute(sql`SELECT attempt_id FROM factory_executions
      WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND run_id=${runId} AND attempt_id=${completion.attempt_id}
        AND node_instance_id=${receipt.source.nodeInstanceId} AND candidate_generation=${receipt.source.candidateGeneration}`))[0];
    if (!execution) provenanceUntrusted();
    return Object.freeze({
      attemptId: execution.attempt_id, projectId, runId,
      nodeInstanceId: receipt.decision.nodeInstanceId, candidateGeneration: receipt.decision.candidateGeneration,
      decisionId: receipt.decision.decisionId, candidateDigest: receipt.decision.candidateDigest,
    });
  }

  /** `FactoryS3PublicationAttempts`: the same read, reconciled against a release operation. */
  async attemptFor(operation: FactoryReleaseOperation, signal?: AbortSignal): Promise<string> {
    if (operation.tenantId !== this.tenantId) provenanceUntrusted();
    const verified = await this.attemptForDecision(operation.projectId, operation.runId, operation.decisionId, signal);
    if (verified.nodeInstanceId !== operation.nodeInstanceId || verified.candidateGeneration !== operation.candidateGeneration || verified.candidateDigest !== operation.candidateDigest) provenanceUntrusted();
    return verified.attemptId;
  }

  /**
   * W04a's publication-set source resolver for an S3 operation.
   *
   * The scope is the verified attempt plus the gateway operation the frozen
   * request names. The candidate member is the accepted candidate manifest; the
   * published members are not archived as bytes because one may be the full
   * 256 MiB export and `FACTORY_ARCHIVE_MEMBER_LIMITS.maxMemberBytes` is 16 MiB.
   * Reconciliation does not need those bytes: the archived recovery intent
   * already carries the whole frozen request, so every member's key, media type,
   * and SHA-256 survives in the archive without it.
   */
  async sourcesFor(tenantId: string, operationId: string, _material: FactoryReleaseMaterial, signal?: AbortSignal): Promise<FactoryArchiveMemberSources> {
    if (tenantId !== this.tenantId) provenanceUntrusted();
    signal?.throwIfAborted();
    const row = rows<OperationRow>(await this.database.execute(sql`SELECT project_id,run_id,node_instance_id,candidate_generation,candidate_digest,decision_id,canonical_request
      FROM factory_release_operations WHERE tenant_id=${this.tenantId} AND operation_id=${operationId}`))[0];
    if (!row) provenanceMissing();
    const request = publicationRequestOf(row.canonical_request);
    const verified = await this.attemptForDecision(row.project_id, row.run_id, row.decision_id, signal);
    if (verified.nodeInstanceId !== row.node_instance_id || verified.candidateGeneration !== Number(row.candidate_generation) || verified.candidateDigest !== row.candidate_digest) provenanceUntrusted();
    const scope: FactoryMaterialScope = {
      tenantId: this.tenantId, projectId: row.project_id, runId: row.run_id,
      attemptId: verified.attemptId, operationId: request.materialOperationId,
    };
    return { scope, candidate: request.candidate };
  }

  /** The seam W09 hands `FactoryArchiveWriter`. */
  publicationSet(): FactoryArchivePublicationSet {
    return factoryArchivePublicationSet((tenantId, operationId, material, signal) => this.sourcesFor(tenantId, operationId, material, signal));
  }
}

/** Reads the frozen publication request out of one stored canonical request envelope. */
function publicationRequestOf(canonicalRequest: string): FactoryS3PublicationSetRequest {
  let parsed: unknown;
  try { parsed = JSON.parse(canonicalRequest); }
  catch { provenanceUntrusted(); }
  const envelope = parsed as { provider?: unknown; request?: unknown };
  if (!envelope || typeof envelope !== "object" || envelope.provider !== "s3") provenanceUntrusted();
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
    if (verified.nodeInstanceId !== input.decision.nodeInstanceId || verified.candidateGeneration !== input.decision.candidateGeneration || verified.candidateDigest !== input.decision.candidateDigest) provenanceUntrusted();
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
