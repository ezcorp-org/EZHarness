import { sql } from "drizzle-orm";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { factoryArchivePublicationSet, type FactoryArchiveMemberSources, type FactoryArchivePublicationSet } from "./archive-writer";
import type { FactoryMaterialScope } from "./artifact-materials";
import { assertFactoryIdentity } from "./records";
import type { FactoryReleaseAuthorityStore } from "./release-authority";
import { FactoryReleaseError, type FactoryReleaseMaterial, type FactoryReleaseOperation } from "./releases";

/**
 * The one publication-set scope resolver, shared by every release provider.
 *
 * The archive writer must read every publication member through W04's scoped reader, and that
 * reader authorizes by an attempt-scoped `FactoryMaterialScope`. A release operation carries no
 * attempt id — it names a tenant, project, run, node instance, and candidate generation. This is
 * the mapping between them, and the rule that matters is where the attempt id comes from:
 *
 *   the accepted protected command receipt in `factory_protected_command_effects`. Its `source` is
 *   the output of `resolveFactoryProtectedTaskSource`, so the command it names is the succeeded,
 *   stopped, non-uncertain task attempt at the current generation. `factory_task_completions`
 *   turns that command into an attempt id, and `factory_executions` must agree the attempt ran
 *   that node at that generation.
 *
 * Never caller input, and never the release operation's own id. A caller that could name the
 * attempt could point the archive at another attempt's materials.
 *
 * W07 and W08 arrived at this mapping independently and landed two implementations of it. They are
 * consolidated here: this class owns the derivation, and each provider supplies only the part that
 * is genuinely provider-specific — which material operation its members were written under, and
 * which artifact is the candidate.
 */

/** How many accepted protected receipts one run may hold before the search gives up. */
export const FACTORY_PUBLICATION_PROVENANCE_SCAN_LIMIT = 512;

/** The verified attempt behind one acceptance decision. */
export interface FactoryVerifiedPublicationAttempt {
  readonly attemptId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly candidateGeneration: number;
  readonly decisionId: string;
  readonly candidateDigest: string;
}

/** The durable identity of one release operation, before any provider reads its request. */
export interface FactoryPublicationOperationFacts {
  readonly projectId: string;
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly candidateGeneration: number;
  readonly candidateDigest: string;
  readonly decisionId: string;
  /** The stored `{ provider, request }` envelope, for a provider that pins members in it. */
  readonly canonicalRequest: string;
}

/**
 * The provider-specific half: which material operation holds this operation's members.
 *
 * A provider that freezes the material operation into its own request reads it from there; one
 * that does not looks the member up by the artifact the verified attempt produced. Neither may
 * name the attempt, which is why this seam receives it rather than deciding it.
 */
export interface FactoryPublicationMembers {
  membersFor(
    facts: FactoryPublicationOperationFacts,
    verified: FactoryVerifiedPublicationAttempt,
    signal?: AbortSignal,
  ): Promise<{ readonly materialOperationId: string; readonly candidate?: FactoryArtifactReference; readonly request?: FactoryArtifactReference }>;
}

/**
 * An optional second, independent derivation of the same attempt id.
 *
 * `factory_release_current_candidates.attempt_id` is written by
 * `FactoryReleaseAuthorityStore.completeCurrentCandidateInTransaction` from the same protected
 * provenance. When a composition supplies this reader, the two paths must agree; a disagreement is
 * corruption rather than a choice between answers.
 */
export interface FactoryPublicationAgreement {
  attemptForCandidate(facts: FactoryPublicationOperationFacts, signal?: AbortSignal): Promise<string>;
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

export function factoryPublicationProvenanceMissing(): never {
  throw new FactoryReleaseError("factory_publication_provenance_missing");
}

export function factoryPublicationProvenanceUntrusted(): never {
  throw new FactoryReleaseError("factory_publication_provenance_untrusted");
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

export interface FactoryPublicationProvenanceOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  /** The provider's member resolver. Required, because a scope without members archives nothing. */
  readonly members: FactoryPublicationMembers;
  /** The optional second derivation. Supplied by compositions that keep a candidate pointer. */
  readonly agreement?: FactoryPublicationAgreement;
  /** Bounds the accepted-receipt search. Defaults to `FACTORY_PUBLICATION_PROVENANCE_SCAN_LIMIT`. */
  readonly scanLimit?: number;
}

export class FactoryPublicationProvenance {
  readonly tenantId: string;
  private readonly database: TransactionalDb;
  private readonly members: FactoryPublicationMembers;
  private readonly agreement?: FactoryPublicationAgreement;
  private readonly scanLimit: number;

  constructor(options: FactoryPublicationProvenanceOptions) {
    assertFactoryIdentity(options.tenantId);
    this.tenantId = options.tenantId;
    this.database = options.database;
    this.members = options.members;
    this.agreement = options.agreement;
    this.scanLimit = options.scanLimit ?? FACTORY_PUBLICATION_PROVENANCE_SCAN_LIMIT;
    if (!Number.isSafeInteger(this.scanLimit) || this.scanLimit < 1 || this.scanLimit > FACTORY_PUBLICATION_PROVENANCE_SCAN_LIMIT) throw new FactoryReleaseError("factory_publication_provenance_invalid");
  }

  /**
   * The verified attempt behind one acceptance decision.
   *
   * Used before an operation exists, by a release profile, and again through `attemptFor` once it
   * does.
   */
  async attemptForDecision(projectId: string, runId: string, decisionId: string, signal?: AbortSignal): Promise<FactoryVerifiedPublicationAttempt> {
    signal?.throwIfAborted();
    return this.database.transaction(transaction => this.readInTransaction(transaction, projectId, runId, decisionId));
  }

  private async readInTransaction(transaction: MigrationDb, projectId: string, runId: string, decisionId: string): Promise<FactoryVerifiedPublicationAttempt> {
    const candidates = rows<{ receipt_json: string }>(await transaction.execute(sql`SELECT receipt_json FROM factory_protected_command_effects
      WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND run_id=${runId} AND kind='request-acceptance' AND decision='accepted'
      ORDER BY command_id LIMIT ${this.scanLimit}`));
    const matches = candidates.map(row => acceptanceReceipt(row.receipt_json)).filter((receipt): receipt is AcceptanceReceiptShape => receipt?.decision.decisionId === decisionId);
    if (matches.length !== 1) factoryPublicationProvenanceMissing();
    const receipt = matches[0]!;
    if (receipt.reference.tenantId !== this.tenantId || receipt.reference.projectId !== projectId || receipt.reference.logicalRunId !== runId) factoryPublicationProvenanceUntrusted();
    if (receipt.decision.nodeInstanceId !== receipt.source.nodeInstanceId || receipt.decision.candidateGeneration !== receipt.source.candidateGeneration) factoryPublicationProvenanceUntrusted();
    const completion = rows<{ attempt_id: string }>(await transaction.execute(sql`SELECT attempt_id FROM factory_task_completions
      WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND run_id=${runId} AND interpreter_id=${receipt.reference.interpreterId} AND command_id=${receipt.source.attempt.commandId}`))[0];
    if (!completion) factoryPublicationProvenanceMissing();
    const execution = rows<{ attempt_id: string }>(await transaction.execute(sql`SELECT attempt_id FROM factory_executions
      WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND run_id=${runId} AND attempt_id=${completion.attempt_id}
        AND node_instance_id=${receipt.source.nodeInstanceId} AND candidate_generation=${receipt.source.candidateGeneration}`))[0];
    if (!execution) factoryPublicationProvenanceUntrusted();
    return Object.freeze({
      attemptId: execution.attempt_id, projectId, runId,
      nodeInstanceId: receipt.decision.nodeInstanceId, candidateGeneration: receipt.decision.candidateGeneration,
      decisionId: receipt.decision.decisionId, candidateDigest: receipt.decision.candidateDigest,
    });
  }

  /** The same read, reconciled against a release operation. */
  async attemptFor(operation: FactoryReleaseOperation, signal?: AbortSignal): Promise<string> {
    if (operation.tenantId !== this.tenantId) factoryPublicationProvenanceUntrusted();
    const verified = await this.attemptForDecision(operation.projectId, operation.runId, operation.decisionId, signal);
    if (verified.nodeInstanceId !== operation.nodeInstanceId || verified.candidateGeneration !== operation.candidateGeneration || verified.candidateDigest !== operation.candidateDigest) factoryPublicationProvenanceUntrusted();
    return verified.attemptId;
  }

  /** The durable identity of one operation, read once and reconciled against the provenance. */
  async operationFacts(operationId: string, signal?: AbortSignal): Promise<FactoryPublicationOperationFacts> {
    signal?.throwIfAborted();
    assertFactoryIdentity(operationId);
    const row = rows<OperationRow>(await this.database.execute(sql`SELECT project_id,run_id,node_instance_id,candidate_generation,candidate_digest,decision_id,canonical_request
      FROM factory_release_operations WHERE tenant_id=${this.tenantId} AND operation_id=${operationId}`))[0];
    if (!row) factoryPublicationProvenanceMissing();
    return Object.freeze({
      projectId: row.project_id, runId: row.run_id, nodeInstanceId: row.node_instance_id,
      candidateGeneration: Number(row.candidate_generation), candidateDigest: row.candidate_digest,
      decisionId: row.decision_id, canonicalRequest: row.canonical_request,
    });
  }

  /**
   * W04a's publication-set source resolver for one operation, whatever its provider.
   *
   * The scope is the verified attempt plus the material operation the provider names. When a
   * second derivation is configured, both must produce the same attempt id.
   */
  async sourcesFor(tenantId: string, operationId: string, _material: FactoryReleaseMaterial, signal?: AbortSignal): Promise<FactoryArchiveMemberSources> {
    if (tenantId !== this.tenantId) factoryPublicationProvenanceUntrusted();
    const facts = await this.operationFacts(operationId, signal);
    const verified = await this.attemptForDecision(facts.projectId, facts.runId, facts.decisionId, signal);
    if (verified.nodeInstanceId !== facts.nodeInstanceId || verified.candidateGeneration !== facts.candidateGeneration || verified.candidateDigest !== facts.candidateDigest) factoryPublicationProvenanceUntrusted();
    if (this.agreement && await this.agreement.attemptForCandidate(facts, signal) !== verified.attemptId) factoryPublicationProvenanceUntrusted();
    const members = await this.members.membersFor(facts, verified, signal);
    assertFactoryIdentity(members.materialOperationId);
    const scope: FactoryMaterialScope = {
      tenantId: this.tenantId, projectId: facts.projectId, runId: facts.runId,
      attemptId: verified.attemptId, operationId: members.materialOperationId,
    };
    return Object.freeze({ scope, ...(members.candidate ? { candidate: members.candidate } : {}), ...(members.request ? { request: members.request } : {}) });
  }

  /** The seam W09 hands `FactoryArchiveWriter`. */
  publicationSet(): FactoryArchivePublicationSet {
    return factoryArchivePublicationSet((tenantId, operationId, material, signal) => this.sourcesFor(tenantId, operationId, material, signal));
  }
}

export interface FactoryGitPublicationMembersOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
}

/**
 * The git provider's member half.
 *
 * A git publication freezes no material operation into its request, so the member is looked up by
 * the artifact the verified attempt produced: one sealed material row for that exact attempt and
 * that exact object. When there is none, no readable scope exists, and the resolver refuses rather
 * than guessing — an unreadable member must leave publication pending, which
 * `FactoryArchiveWriter` already enforces by never setting `archive_ready`.
 */
export class FactoryGitPublicationMembers implements FactoryPublicationMembers {
  readonly tenantId: string;
  private readonly database: TransactionalDb;

  constructor(options: FactoryGitPublicationMembersOptions) {
    assertFactoryIdentity(options.tenantId);
    this.tenantId = options.tenantId;
    this.database = options.database;
  }

  async membersFor(facts: FactoryPublicationOperationFacts, verified: FactoryVerifiedPublicationAttempt): Promise<{ materialOperationId: string; candidate?: FactoryArtifactReference }> {
    const material = rows<{ operation_id: string; object_id: string; digest: string; total_bytes: number | string }>(await this.database.execute(sql`
      SELECT material.operation_id,material.object_id,artifact.digest,artifact.encoded_bytes AS total_bytes
      FROM factory_artifact_materials AS material
      JOIN factory_artifacts AS artifact ON artifact.tenant_id=material.tenant_id AND artifact.project_id=material.project_id AND artifact.object_id=material.object_id
      WHERE material.tenant_id=${this.tenantId} AND material.project_id=${facts.projectId} AND material.run_id=${facts.runId}
        AND material.attempt_id=${verified.attemptId} AND material.digest=${facts.candidateDigest} AND material.sealed=TRUE
      ORDER BY material.object_id LIMIT 2`));
    if (material.length !== 1) factoryPublicationProvenanceMissing();
    const found = material[0]!;
    assertFactoryIdentity(found.operation_id, found.object_id);
    return { materialOperationId: found.operation_id, candidate: Object.freeze({ artifactId: found.object_id, digest: found.digest, encodedBytes: Number(found.total_bytes) }) };
  }
}

export interface FactoryCandidatePointerAgreementOptions {
  readonly tenantId: string;
  readonly database: TransactionalDb;
  readonly authority: FactoryReleaseAuthorityStore;
}

/**
 * The second derivation: `factory_release_current_candidates.attempt_id`.
 *
 * It exists so a composition that keeps that pointer can require the two provenance paths to
 * agree. It is never the only answer.
 */
export class FactoryCandidatePointerAgreement implements FactoryPublicationAgreement {
  readonly tenantId: string;
  private readonly database: TransactionalDb;
  private readonly authority: FactoryReleaseAuthorityStore;

  constructor(options: FactoryCandidatePointerAgreementOptions) {
    assertFactoryIdentity(options.tenantId);
    if (options.authority.tenantId !== options.tenantId) throw new FactoryReleaseError("factory_release_scope");
    this.tenantId = options.tenantId;
    this.database = options.database;
    this.authority = options.authority;
  }

  async attemptForCandidate(facts: FactoryPublicationOperationFacts): Promise<string> {
    const verified = await this.database.transaction(transaction => this.authority.readVerifiedCandidateInTransaction(transaction, this.tenantId, {
      projectId: facts.projectId, runId: facts.runId, nodeInstanceId: facts.nodeInstanceId, candidateGeneration: facts.candidateGeneration,
    }));
    if (verified.candidateDigest !== facts.candidateDigest) factoryPublicationProvenanceUntrusted();
    return verified.attemptId;
  }
}

export interface FactoryGitPublicationScopeOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  /** Supplying it turns the candidate pointer into an agreement check on every resolve. */
  readonly authority?: FactoryReleaseAuthorityStore;
  readonly scanLimit?: number;
}

/** The git provider's publication set: the shared provenance with the git member half. */
export function factoryGitPublicationProvenance(options: FactoryGitPublicationScopeOptions): FactoryPublicationProvenance {
  return new FactoryPublicationProvenance({
    database: options.database, tenantId: options.tenantId,
    members: new FactoryGitPublicationMembers({ database: options.database, tenantId: options.tenantId }),
    ...(options.authority ? { agreement: new FactoryCandidatePointerAgreement({ database: options.database, tenantId: options.tenantId, authority: options.authority }) } : {}),
    ...(options.scanLimit === undefined ? {} : { scanLimit: options.scanLimit }),
  });
}

/** The seam W09 wires into `FactoryArchiveWriter` for a git destination. */
export function factoryGitPublicationSet(options: FactoryGitPublicationScopeOptions): FactoryArchivePublicationSet {
  return factoryGitPublicationProvenance(options).publicationSet();
}
