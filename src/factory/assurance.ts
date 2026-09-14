import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FactoryArtifactReference, FactoryValidatorVerdict } from "@ezcorp/factory-sdk";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { approvalContextDigest, assertApprovalUsable, canonicalApprovalContext, consumeApproval } from "../extensions/v4/approval-context";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { FactoryMutations } from "./mutations";
import { assertFactoryIdentity } from "./records";

/** The reduced claim outcome that is durable. The full sealed report stays the terminal artifact. */
export interface FactoryValidatorClaimVerdict { readonly id: string; readonly verdict: FactoryValidatorVerdict; readonly decisive: boolean }
export interface FactoryCandidateKey { readonly projectId: string; readonly runId: string; readonly nodeInstanceId: string; readonly candidateGeneration: number }
export interface FactoryMandatoryClaim { readonly id: string; readonly validatorId: string; readonly freshnessMs: number; readonly required?: boolean }
export interface FactoryClaimGroup { readonly id: string; readonly claimIds: readonly string[]; readonly minimumPasses: number; readonly requireAllDecisive: boolean }
export interface FactoryContractRevision { readonly projectId: string; readonly contractId: string; readonly revision: number; readonly contractDigest: string; readonly validatorLockDigest: string; readonly mandatoryClaims: readonly FactoryMandatoryClaim[]; readonly claimGroups: readonly FactoryClaimGroup[] }
export interface FactoryTrustedEvidence extends FactoryCandidateKey { readonly validatorId: string; readonly validatorLockDigest: string; readonly issuerGrantRevision: number; readonly candidateDigest: string; readonly artifact: FactoryArtifactReference; readonly environmentDigest: string; readonly configurationDigest: string; readonly runnerDigest: string; readonly claims: readonly FactoryValidatorClaimVerdict[]; readonly issuedAtMs: number; readonly expiresAtMs: number }
/** Only the configured gateway may bind an approved contract and construct evidence from protected host facts. */
export interface FactoryTrustedValidatorGateway {
  assertContractInTransaction(transaction: MigrationDb, tenantId: string, contract: FactoryContractRevision): Promise<void>;
  resolveValidatorInTransaction(transaction: MigrationDb, tenantId: string, key: FactoryCandidateKey, validatorId: string): Promise<FactoryTrustedEvidence>;
}
export interface FactoryAcceptanceDecision extends FactoryCandidateKey { readonly decisionId: string; readonly candidateDigest: string; readonly evidenceSetDigest: string; readonly contractDigest: string; readonly contractSnapshotDigest: string; readonly executionEpoch: number; readonly cancellationEpoch: number }
export interface FactoryApprovalRequest { readonly projectId: string; readonly operationId: string; readonly decisionId: string; readonly destinationDigest: string; readonly expectedGeneration: number; readonly expiresAtMs: number }
/** Returned only by the composition-owned reader after it takes project, installation, run, and lifecycle locks. */
export interface FactoryReleaseFence { readonly runId: string; readonly executionEpoch: number; readonly cancellationEpoch: number; readonly status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelling" | "cancelled" | "uncertain"; readonly deadlineMs: number }
export interface FactoryReleaseFenceReader { readCurrentInTransaction(transaction: MigrationDb, tenantId: string, projectId: string, runId: string): Promise<FactoryReleaseFence> }
/** Composition resolves these records from the current protected journal and validator lock, never from caller JSON. */
export interface FactoryCurrentCandidateResolver { resolveCurrentEvidenceInTransaction(transaction: MigrationDb, tenantId: string, key: FactoryCandidateKey, validatorIds: readonly string[]): Promise<readonly FactoryTrustedEvidence[]> }
export interface FactoryApprovalConsumption extends FactoryApprovalRequest { readonly approvalId: string; readonly requester: FactoryPrincipal; readonly runId: string }
export interface FactoryAcceptedRelease extends FactoryCandidateKey { readonly decisionId: string; readonly candidateDigest: string; readonly contractDigest: string; readonly executionEpoch: number; readonly cancellationEpoch: number; readonly approvalDecision: unknown }
export interface FactoryAcceptedReleaseCheck { readonly projectId: string; readonly runId: string; readonly decisionId: string; readonly nodeInstanceId?: string; readonly candidateGeneration?: number; readonly candidateDigest?: string }
type ContractRow = { contract_digest: string; validator_lock_digest: string; mandatory_claims: string; claim_groups: string; approved_by: string; approval_grant_revision: number | string; protected_snapshot_digest: string };
type EvidenceRow = { evidence_id: string; project_id: string; run_id: string; node_instance_id: string; candidate_generation: number | string; candidate_digest: string; validator_id: string; validator_lock_digest: string; issuer_grant_revision: number | string; artifact_id: string; artifact_digest: string; artifact_bytes: number | string; environment_digest: string; configuration_digest: string; runner_digest: string; claims: string; issued_at_ms: number | string; expires_at_ms: number | string; evidence_digest: string };
type DecisionRow = FactoryAcceptanceDecision & { contractId: string; contractRevision: number | string; decisionDigest: string };
type ApprovalRow = { context_digest: string; status: "pending" | "approved" | "rejected" | "consumed" | "revoked"; principal_id: string; grant_revision: number | string; expected_generation: number | string; expires_at_ms: number | string; decision_id: string; approved_by: string | null; approved_grant_revision: number | string | null };

export type FactoryAssuranceErrorCode =
  | "factory_assurance_invalid"
  | "factory_assurance_scope"
  | "factory_assurance_stale"
  | "factory_assurance_conflict"
  | "factory_assurance_not_found"
  | "factory_assurance_corrupt"
  | "factory_assurance_trust"
  | "factory_assurance_evidence_stale"
  | "factory_assurance_claim_failed";

export class FactoryAssuranceError extends Error { constructor(readonly code: FactoryAssuranceErrorCode) { super(code); this.name = "FactoryAssuranceError"; } }

/** One required claim that did not pass, named exactly enough for a bounded repair to read. */
export interface FactoryClaimFailure { readonly claimId: string; readonly validatorId: string; readonly verdict: FactoryValidatorVerdict; readonly reasonCode: string }
/** One claim group that fell below its declared quorum, or lost a decisive member. */
export interface FactoryGroupFailure { readonly groupId: string; readonly passes: number; readonly minimumPasses: number }

/**
 * The semantic acceptance failure, carrying every fact a rejection receipt needs.
 *
 * It is a distinct class rather than a bare code so a rejection can never be built from an
 * infrastructure, corruption, or trust error that happens to share a string.
 */
export class FactoryAssuranceClaimError extends FactoryAssuranceError {
  constructor(
    readonly candidateDigest: string,
    readonly contractDigest: string,
    readonly evidenceSetDigest: string,
    readonly failures: readonly FactoryClaimFailure[],
    readonly groupFailures: readonly FactoryGroupFailure[],
  ) {
    super("factory_assurance_claim_failed");
    this.name = "FactoryAssuranceClaimError";
  }
}
const digest = (value: unknown) => `sha256:${digestObject(value)}`;
const requiredText = (...values: readonly string[]) => { if (values.some(value => typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0"))) throw new FactoryAssuranceError("factory_assurance_invalid"); };
const requiredDigest = (...values: readonly string[]) => { if (values.some(value => !/^sha256:[a-f0-9]{64}$/.test(value))) throw new FactoryAssuranceError("factory_assurance_invalid"); };
const requiredContextDigest = (value: string) => { if (!/^[a-f0-9]{64}$/.test(value)) throw new FactoryAssuranceError("factory_assurance_invalid"); };
const VERDICTS = new Set<FactoryValidatorVerdict>(["PASS", "FAIL", "INCONCLUSIVE", "VALIDATOR_ERROR"]);
const counter = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw new FactoryAssuranceError("factory_assurance_invalid"); };
const encoded = (value: unknown) => canonicalJson(value);
const snapshot = <Value>(value: Value): Value => JSON.parse(encoded(value)) as Value;
const protectedContractSnapshot = (tenantId: string, contract: FactoryContractRevision, approvedBy: string, approvalGrantRevision: number) => ({ tenantId, projectId: contract.projectId, contractId: contract.contractId, revision: contract.revision, contractDigest: contract.contractDigest, validatorLockDigest: contract.validatorLockDigest, mandatoryClaims: contract.mandatoryClaims, claimGroups: contract.claimGroups, approvedBy, approvalGrantRevision });
const protectedContractSnapshotDigest = (tenantId: string, contract: FactoryContractRevision, approvedBy: string, approvalGrantRevision: number) => digest(protectedContractSnapshot(tenantId, contract, approvedBy, approvalGrantRevision));
function key(input: FactoryCandidateKey): void { requiredText(input.projectId, input.runId, input.nodeInstanceId); counter(input.candidateGeneration); }
function claims(input: readonly FactoryMandatoryClaim[], groups: readonly FactoryClaimGroup[]): void {
  const ids = new Set<string>();
  if (input.length > 1000 || groups.length > 1000) throw new FactoryAssuranceError("factory_assurance_invalid");
  for (const claim of input) { requiredText(claim.id, claim.validatorId); if (!Number.isSafeInteger(claim.freshnessMs) || claim.freshnessMs < 1 || ids.has(claim.id) || (claim.required !== undefined && typeof claim.required !== "boolean")) throw new FactoryAssuranceError("factory_assurance_invalid"); ids.add(claim.id); }
  const groupIds = new Set<string>();
  for (const group of groups) { requiredText(group.id); if (typeof group.requireAllDecisive !== "boolean" || group.claimIds.length > 1000 || groupIds.has(group.id) || !Number.isSafeInteger(group.minimumPasses) || group.minimumPasses < 1 || group.minimumPasses > group.claimIds.length || !group.claimIds.every(id => ids.has(id))) throw new FactoryAssuranceError("factory_assurance_invalid"); groupIds.add(group.id); }
}

/** C04 product facts. Tenant identity is constructor-owned and cannot come from an input body. */
export class FactoryAssurance {
  private readonly mutations: FactoryMutations;
  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly grants: FactoryGrants, private readonly gateway: FactoryTrustedValidatorGateway, private readonly releaseFenceReader: FactoryReleaseFenceReader, private readonly currentCandidate: FactoryCurrentCandidateResolver, private readonly now: () => number = Date.now) { assertFactoryIdentity(tenantId); if (grants.tenantId !== tenantId) throw new FactoryAssuranceError("factory_assurance_scope"); this.mutations = new FactoryMutations(database, tenantId, grants); }

  async approveContract(actor: FactoryPrincipal, input: FactoryContractRevision, idempotencyKey: string): Promise<void> {
    [actor, input] = snapshot([actor, input]);
    this.contract(input);
    await this.executeAuthorizedMutation(actor, input.projectId, "factory.trust", idempotencyKey, { kind: "assurance.contract.approve", contract: input }, async (transaction, approvalGrantRevision) => {
      await this.gateway.assertContractInTransaction(transaction, this.tenantId, input);
      const current = rows<{ revision: number | string } & ContractRow>(await transaction.execute(sql`SELECT revision,contract_digest,validator_lock_digest,mandatory_claims,claim_groups,approved_by,approval_grant_revision,protected_snapshot_digest FROM factory_acceptance_contracts WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND contract_id=${input.contractId} ORDER BY revision DESC LIMIT 1 FOR UPDATE`))[0];
      if (current) this.assertProtectedContractRow(current, input.projectId, input.contractId, Number(current.revision));
      if ((current ? Number(current.revision) : 0) !== input.revision - 1) throw new FactoryAssuranceError("factory_assurance_stale");
      const authority = { revision: approvalGrantRevision };
      const protectedSnapshotDigest = protectedContractSnapshotDigest(this.tenantId, input, actor.id, authority.revision);
      await transaction.execute(sql`INSERT INTO factory_acceptance_contracts (tenant_id, project_id, contract_id, revision, contract_digest, validator_lock_digest, mandatory_claims, claim_groups, approved_by, approval_grant_revision, protected_snapshot_digest) VALUES (${this.tenantId}, ${input.projectId}, ${input.contractId}, ${input.revision}, ${input.contractDigest}, ${input.validatorLockDigest}, ${encoded(input.mandatoryClaims)}, ${encoded(input.claimGroups)}, ${actor.id}, ${authority.revision}, ${protectedSnapshotDigest}) ON CONFLICT (tenant_id, project_id, contract_id, revision) DO NOTHING`);
      const saved = (rows<ContractRow>(await transaction.execute(sql`SELECT contract_digest, validator_lock_digest, mandatory_claims, claim_groups, approved_by, approval_grant_revision, protected_snapshot_digest FROM factory_acceptance_contracts WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND contract_id=${input.contractId} AND revision=${input.revision} FOR SHARE`))[0]);
      if (!saved || saved.contract_digest !== input.contractDigest || saved.validator_lock_digest !== input.validatorLockDigest || saved.mandatory_claims !== encoded(input.mandatoryClaims) || saved.claim_groups !== encoded(input.claimGroups) || saved.approved_by !== actor.id || Number(saved.approval_grant_revision) !== authority.revision || saved.protected_snapshot_digest !== protectedSnapshotDigest) throw new FactoryAssuranceError("factory_assurance_conflict");
      this.assertProtectedContractRow(saved, input.projectId, input.contractId, input.revision);
      await insertTransactionalAuditEntry(transaction, `factory-assurance-contract:${digest(input)}:${authority.revision}`, actor.id, "factory.assurance.contract.approved", input.contractId, { tenantId: this.tenantId, projectId: input.projectId, revision: input.revision, contractDigest: input.contractDigest, validatorLockDigest: input.validatorLockDigest });
      return { contractId: input.contractId, revision: input.revision };
    }, true);
  }

  async captureEvidence(input: FactoryCandidateKey & { readonly validatorId: string }): Promise<string> {
    input = snapshot(input);
    key(input); requiredText(input.validatorId);
    return this.database.transaction(transaction => this.captureEvidenceInTransaction(transaction, input));
  }

  async accept(input: FactoryCandidateKey & { readonly contractId: string; readonly revision: number }): Promise<FactoryAcceptanceDecision> {
    input = snapshot(input);
    key(input); requiredText(input.contractId); if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new FactoryAssuranceError("factory_assurance_invalid");
    return this.database.transaction(transaction => this.acceptInTransaction(transaction, input));
  }

  /** Resolves the latest approved compiled contract and its protected validator results in one caller-owned transaction. */
  async acceptCurrentInTransaction(transaction: MigrationDb, value: FactoryCandidateKey, contractId: string): Promise<FactoryAcceptanceDecision> {
    const input = snapshot(value);
    contractId = snapshot(contractId);
    key(input); requiredText(contractId);
    const latest = rows<{ revision: number | string }>(await transaction.execute(sql`SELECT revision FROM factory_acceptance_contracts WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND contract_id=${contractId} ORDER BY revision DESC LIMIT 1 FOR SHARE`))[0];
    const revision = Number(latest?.revision);
    if (!latest || !Number.isSafeInteger(revision) || revision < 1) throw new FactoryAssuranceError("factory_assurance_not_found");
    const contract = await this.contractRow(transaction, input.projectId, contractId, revision);
    const { requiredClaims } = this.contractClaims(contract);
    const validators = new Map<string, boolean>();
    for (const claim of requiredClaims) validators.set(claim.validatorId, validators.get(claim.validatorId) === true || claim.required !== false);
    const evidence: FactoryTrustedEvidence[] = [];
    for (const [validatorId, required] of [...validators].sort(([left], [right]) => left.localeCompare(right))) {
      try { evidence.push(snapshot(await this.gateway.resolveValidatorInTransaction(transaction, this.tenantId, input, validatorId))); }
      catch (error) {
        if (required || (error as { code?: unknown })?.code !== "factory_validator_assignment_missing") throw error;
      }
    }
    for (const item of evidence) await this.storeEvidenceInTransaction(transaction, { ...input, validatorId: item.validatorId }, item);
    return this.acceptInTransaction(transaction, { ...input, contractId, revision });
  }

  private async captureEvidenceInTransaction(transaction: MigrationDb, input: FactoryCandidateKey & { readonly validatorId: string }): Promise<string> {
    const evidence = snapshot(await this.gateway.resolveValidatorInTransaction(transaction, this.tenantId, input, input.validatorId));
    return this.storeEvidenceInTransaction(transaction, input, evidence);
  }

  private async storeEvidenceInTransaction(transaction: MigrationDb, input: FactoryCandidateKey & { readonly validatorId: string }, evidence: FactoryTrustedEvidence): Promise<string> {
    this.evidence(evidence, input);
    const evidenceDigest = digest(evidence);
    const id = randomUUID();
    await transaction.execute(sql`INSERT INTO factory_acceptance_evidence (tenant_id, project_id, evidence_id, run_id, node_instance_id, candidate_generation, candidate_digest, validator_id, validator_lock_digest, issuer_grant_revision, artifact_id, artifact_digest, artifact_bytes, environment_digest, configuration_digest, runner_digest, claims, issued_at_ms, expires_at_ms, evidence_digest) VALUES (${this.tenantId}, ${evidence.projectId}, ${id}, ${evidence.runId}, ${evidence.nodeInstanceId}, ${evidence.candidateGeneration}, ${evidence.candidateDigest}, ${evidence.validatorId}, ${evidence.validatorLockDigest}, ${evidence.issuerGrantRevision}, ${evidence.artifact.artifactId}, ${evidence.artifact.digest}, ${evidence.artifact.encodedBytes}, ${evidence.environmentDigest}, ${evidence.configurationDigest}, ${evidence.runnerDigest}, ${encoded(evidence.claims)}, ${evidence.issuedAtMs}, ${evidence.expiresAtMs}, ${evidenceDigest}) ON CONFLICT (tenant_id, project_id, run_id, node_instance_id, candidate_generation, validator_id) DO NOTHING`);
    const prior = (await this.evidenceRows(transaction, evidence.projectId, evidence, evidence.validatorId))[0];
    if (!prior || prior.evidence_digest !== evidenceDigest) throw new FactoryAssuranceError("factory_assurance_conflict");
    return prior.evidence_id;
  }

  private async acceptInTransaction(transaction: MigrationDb, input: FactoryCandidateKey & { readonly contractId: string; readonly revision: number }): Promise<FactoryAcceptanceDecision> {
      const fence = await this.releaseFenceReader.readCurrentInTransaction(transaction, this.tenantId, input.projectId, input.runId);
      if (fence.runId !== input.runId || !["queued", "running", "waiting"].includes(fence.status) || fence.deadlineMs <= this.now() || !Number.isSafeInteger(fence.executionEpoch) || !Number.isSafeInteger(fence.cancellationEpoch)) throw new FactoryAssuranceError("factory_assurance_stale");
      const contract = await this.contractRow(transaction, input.projectId, input.contractId, input.revision);
      await this.grants.authorizeInTransaction(transaction, { kind: "user", id: contract.approved_by, authentication: "session" }, input.projectId, "factory.trust", Number(contract.approval_grant_revision));
      const { requiredClaims, groups } = this.contractClaims(contract);
      const evidence = await this.evidenceRows(transaction, input.projectId, input);
      const candidateDigest = this.verifyEvidence(contract, requiredClaims, groups, evidence);
      await this.verifyCurrentCandidate(transaction, input, evidence);
      const evidenceSetDigest = digest(evidence.map(row => row.evidence_digest).sort()); const decision = { ...input, decisionId: randomUUID(), candidateDigest, evidenceSetDigest, contractDigest: contract.contract_digest, contractSnapshotDigest: contract.protected_snapshot_digest, executionEpoch: fence.executionEpoch, cancellationEpoch: fence.cancellationEpoch };
      const decisionDigest = digest(this.decisionSnapshot(decision, input.contractId, input.revision));
      await transaction.execute(sql`INSERT INTO factory_acceptance_decisions (tenant_id, project_id, decision_id, contract_id, contract_revision, contract_digest, contract_snapshot_digest, candidate_digest, evidence_set_digest, decision_digest, run_id, node_instance_id, candidate_generation, execution_epoch, cancellation_epoch) VALUES (${this.tenantId}, ${input.projectId}, ${decision.decisionId}, ${input.contractId}, ${input.revision}, ${decision.contractDigest}, ${decision.contractSnapshotDigest}, ${decision.candidateDigest}, ${decision.evidenceSetDigest}, ${decisionDigest}, ${input.runId}, ${input.nodeInstanceId}, ${input.candidateGeneration}, ${fence.executionEpoch}, ${fence.cancellationEpoch}) ON CONFLICT DO NOTHING`);
      const saved = rows<FactoryAcceptanceDecision>(await transaction.execute(sql`SELECT decision_id AS "decisionId", candidate_digest AS "candidateDigest", evidence_set_digest AS "evidenceSetDigest", contract_digest AS "contractDigest", contract_snapshot_digest AS "contractSnapshotDigest", project_id AS "projectId", run_id AS "runId", node_instance_id AS "nodeInstanceId", candidate_generation AS "candidateGeneration", execution_epoch AS "executionEpoch", cancellation_epoch AS "cancellationEpoch" FROM factory_acceptance_decisions WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND contract_id=${input.contractId} AND contract_revision=${input.revision} AND run_id=${input.runId} AND node_instance_id=${input.nodeInstanceId} AND candidate_generation=${input.candidateGeneration} AND candidate_digest=${candidateDigest} FOR SHARE`))[0];
      if (!saved || saved.evidenceSetDigest !== evidenceSetDigest) throw new FactoryAssuranceError("factory_assurance_conflict");
      return { ...saved, candidateGeneration: Number(saved.candidateGeneration), executionEpoch: Number(saved.executionEpoch), cancellationEpoch: Number(saved.cancellationEpoch) };
  }

  async requestApproval(actor: FactoryPrincipal, input: FactoryApprovalRequest, idempotencyKey: string): Promise<{ approvalId: string; contextDigest: string }> {
    [actor, input] = snapshot([actor, input]);
    this.approvalRequest(input);
    return this.executeAuthorizedMutation(actor, input.projectId, "factory.approve", idempotencyKey, { kind: "assurance.approval.request", request: input }, (transaction, grantRevision) => this.requestApprovalAuthorizedInTransaction(transaction, actor, input, grantRevision));
  }

  /** Allows the release service to commit the approval request and its human notification in one transaction. */
  async requestApprovalInTransaction(transaction: MigrationDb, actor: FactoryPrincipal, input: FactoryApprovalRequest): Promise<{ approvalId: string; contextDigest: string }> {
    [actor, input] = snapshot([actor, input]);
    this.approvalRequest(input);
    const authority = await this.grants.authorizeInTransaction(transaction, actor, input.projectId, "factory.approve");
    return this.requestApprovalAuthorizedInTransaction(transaction, actor, input, authority.revision);
  }

  private async requestApprovalAuthorizedInTransaction(transaction: MigrationDb, actor: FactoryPrincipal, input: FactoryApprovalRequest, grantRevision: number): Promise<{ approvalId: string; contextDigest: string }> {
    const decision = await this.decisionRow(transaction, input.projectId, input.decisionId);
    if (!decision) throw new FactoryAssuranceError("factory_assurance_not_found");
    const context = canonicalApprovalContext({ subjectId: input.operationId, subjectDigest: digest({ decision, destinationDigest: input.destinationDigest }), principalId: actor.id, scope: input.projectId, grants: ["factory.release"], expectedGeneration: input.expectedGeneration, expiresAtMs: input.expiresAtMs }); const contextDigest = approvalContextDigest(context); const approvalId = randomUUID();
    await transaction.execute(sql`INSERT INTO factory_release_approvals (tenant_id, project_id, approval_id, operation_id, context_digest, decision_id, principal_id, grant_revision, expected_generation, expires_at_ms, status) VALUES (${this.tenantId}, ${input.projectId}, ${approvalId}, ${input.operationId}, ${contextDigest}, ${input.decisionId}, ${actor.id}, ${grantRevision}, ${input.expectedGeneration}, ${input.expiresAtMs}, 'pending')`);
    await insertTransactionalAuditEntry(transaction, `factory-assurance-approval-request:${approvalId}`, actor.id, "factory.assurance.approval.requested", input.operationId, { tenantId: this.tenantId, projectId: input.projectId, approvalId, decisionId: input.decisionId, contextDigest });
    return { approvalId, contextDigest };
  }

  async decideApproval(actor: FactoryPrincipal, projectId: string, approvalId: string, contextDigest: string, approved: boolean, idempotencyKey: string): Promise<void> {
    [actor, projectId, approvalId, contextDigest, approved] = snapshot([actor, projectId, approvalId, contextDigest, approved]);
    requiredText(projectId, approvalId); requiredContextDigest(contextDigest);
    await this.executeAuthorizedMutation(actor, projectId, "factory.approve", idempotencyKey, { kind: "assurance.approval.decide", approvalId, contextDigest, approved }, async (transaction, approvalGrantRevision) => {
      const changed = rows(await transaction.execute(sql`UPDATE factory_release_approvals SET status=${approved ? "approved" : "rejected"}, approved_by=${actor.id}, approved_grant_revision=${approvalGrantRevision} WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND approval_id=${approvalId} AND context_digest=${contextDigest} AND status='pending' RETURNING approval_id`));
      if (!changed.length) throw new FactoryAssuranceError("factory_assurance_stale");
      await insertTransactionalAuditEntry(transaction, `factory-assurance-approval-decision:${approvalId}`, actor.id, "factory.assurance.approval.decided", approvalId, { tenantId: this.tenantId, projectId, approvalId, approved, contextDigest, approvalGrantRevision });
      return { approvalId, approved };
    });
  }

  /** The injected reader holds the shared project/install/run/lifecycle locks before this effect claim. */
  async consumeApprovalInTransaction(transaction: MigrationDb, input: FactoryApprovalConsumption): Promise<void> {
    input = snapshot(input);
    requiredText(input.projectId, input.operationId, input.decisionId, input.approvalId, input.requester.id, input.runId); requiredDigest(input.destinationDigest); counter(input.expectedGeneration);
    const decision = await this.assertAcceptedReleaseInTransaction(transaction, { projectId: input.projectId, runId: input.runId, decisionId: input.decisionId });
    const row = rows<ApprovalRow>(await transaction.execute(sql`SELECT context_digest, status, principal_id, grant_revision, expected_generation, expires_at_ms, decision_id, approved_by, approved_grant_revision FROM factory_release_approvals WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND approval_id=${input.approvalId} FOR UPDATE`))[0];
    if (!row || row.decision_id !== input.decisionId) throw new FactoryAssuranceError("factory_assurance_not_found");
    const context = { subjectId: input.operationId, subjectDigest: digest({ decision: decision.approvalDecision, destinationDigest: input.destinationDigest }), principalId: row.principal_id, scope: input.projectId, grants: ["factory.release"], expectedGeneration: Number(row.expected_generation), expiresAtMs: Number(row.expires_at_ms) };
    if (row.context_digest !== approvalContextDigest(context)) throw new FactoryAssuranceError("factory_assurance_corrupt");
    try { assertApprovalUsable(row.status, context, { subjectDigest: context.subjectDigest, principalId: row.principal_id, scope: input.projectId, expectedGeneration: input.expectedGeneration }, this.now(), true); } catch { throw new FactoryAssuranceError("factory_assurance_stale"); }
    await this.grants.authorizeInTransaction(transaction, input.requester, input.projectId, "factory.release");
    if (!row.approved_by || row.approved_grant_revision === null) throw new FactoryAssuranceError("factory_assurance_stale");
    await this.grants.authorizeInTransaction(transaction, { kind: "user", id: row.approved_by, authentication: "session" }, input.projectId, "factory.approve", Number(row.approved_grant_revision));
    const changed = rows(await transaction.execute(sql`UPDATE factory_release_approvals SET status=${consumeApproval(row.status)}, consumed_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND approval_id=${input.approvalId} AND status='approved' RETURNING approval_id`));
    if (!changed.length) throw new FactoryAssuranceError("factory_assurance_stale");
    await insertTransactionalAuditEntry(transaction, `factory-assurance-approval-consumed:${input.approvalId}`, input.requester.kind === "user" ? input.requester.id : null, "factory.assurance.approval.consumed", input.operationId, { tenantId: this.tenantId, projectId: input.projectId, approvalId: input.approvalId, decisionId: input.decisionId, runId: input.runId, principalKind: input.requester.kind, principalId: input.requester.id });
  }

  /** Revalidates the immutable decision, current run epochs, protected contract, evidence, and current candidate for approval and policy claims. */
  async assertAcceptedReleaseInTransaction(transaction: MigrationDb, input: FactoryAcceptedReleaseCheck): Promise<FactoryAcceptedRelease> {
    input = snapshot(input);
    requiredText(input.projectId, input.runId, input.decisionId);
    const exactIdentity = input.nodeInstanceId !== undefined || input.candidateGeneration !== undefined || input.candidateDigest !== undefined;
    if (exactIdentity && (input.nodeInstanceId === undefined || input.candidateGeneration === undefined || input.candidateDigest === undefined)) throw new FactoryAssuranceError("factory_assurance_invalid");
    const fence = await this.releaseFenceReader.readCurrentInTransaction(transaction, this.tenantId, input.projectId, input.runId);
    if (fence.runId !== input.runId || !["queued", "running", "waiting"].includes(fence.status) || !Number.isSafeInteger(fence.executionEpoch) || fence.executionEpoch < 1 || !Number.isSafeInteger(fence.cancellationEpoch) || fence.cancellationEpoch < 0 || !Number.isSafeInteger(fence.deadlineMs) || fence.deadlineMs <= this.now()) throw new FactoryAssuranceError("factory_assurance_stale");
    const decision = await this.decisionRow(transaction, input.projectId, input.decisionId);
    if (!decision) throw new FactoryAssuranceError("factory_assurance_not_found");
    if (decision.runId !== input.runId || decision.cancellationEpoch !== fence.cancellationEpoch || decision.executionEpoch !== fence.executionEpoch || exactIdentity && (decision.nodeInstanceId !== input.nodeInstanceId || decision.candidateGeneration !== input.candidateGeneration || decision.candidateDigest !== input.candidateDigest)) throw new FactoryAssuranceError("factory_assurance_stale");
    const contract = await this.contractRow(transaction, input.projectId, decision.contractId, Number(decision.contractRevision));
    if (contract.contract_digest !== decision.contractDigest || contract.protected_snapshot_digest !== decision.contractSnapshotDigest) throw new FactoryAssuranceError("factory_assurance_corrupt");
    await this.grants.authorizeInTransaction(transaction, { kind: "user", id: contract.approved_by, authentication: "session" }, input.projectId, "factory.trust", Number(contract.approval_grant_revision));
    const storedEvidence = await this.evidenceRows(transaction, input.projectId, decision);
    const { requiredClaims, groups } = this.contractClaims(contract);
    if (this.verifyEvidence(contract, requiredClaims, groups, storedEvidence) !== decision.candidateDigest || digest(storedEvidence.map(item => item.evidence_digest).sort()) !== decision.evidenceSetDigest || digest(this.decisionSnapshot(decision, decision.contractId, Number(decision.contractRevision))) !== decision.decisionDigest) throw new FactoryAssuranceError("factory_assurance_corrupt");
    await this.verifyCurrentCandidate(transaction, decision, storedEvidence);
    return { projectId: decision.projectId, runId: decision.runId, nodeInstanceId: decision.nodeInstanceId, candidateGeneration: decision.candidateGeneration, decisionId: decision.decisionId, candidateDigest: decision.candidateDigest, contractDigest: decision.contractDigest, executionEpoch: decision.executionEpoch, cancellationEpoch: decision.cancellationEpoch, approvalDecision: decision };
  }

  private contract(input: FactoryContractRevision): void { requiredText(input.projectId, input.contractId); requiredDigest(input.contractDigest, input.validatorLockDigest); if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new FactoryAssuranceError("factory_assurance_invalid"); claims(input.mandatoryClaims, input.claimGroups); }
  private approvalRequest(input: FactoryApprovalRequest): void { requiredText(input.projectId, input.operationId, input.decisionId); requiredDigest(input.destinationDigest); counter(input.expectedGeneration); if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= this.now() || input.expiresAtMs - this.now() > 86_400_000) throw new FactoryAssuranceError("factory_assurance_invalid"); }
  private async executeAuthorizedMutation<Result>(actor: FactoryPrincipal, projectId: string, action: "factory.trust" | "factory.approve", idempotencyKey: string, input: unknown, apply: (transaction: MigrationDb, grantRevision: number) => Promise<Result>, serializeProject = false): Promise<Result> {
    let grantRevision: number | undefined;
    return this.mutations.execute({ principal: actor, projectId, action, idempotencyKey, input }, transaction => {
      if (grantRevision === undefined) throw new FactoryAssuranceError("factory_assurance_stale");
      return apply(transaction, grantRevision);
    }, async transaction => {
      if (serializeProject) {
        const project = rows(await transaction.execute(sql`SELECT project_id FROM factory_projects WHERE tenant_id=${this.tenantId} AND project_id=${projectId} FOR UPDATE`))[0];
        if (!project) throw new FactoryAssuranceError("factory_assurance_not_found");
      }
      grantRevision = (await this.grants.authorizeInTransaction(transaction, actor, projectId, action)).revision;
    });
  }
  private evidence(evidence: FactoryTrustedEvidence, expected: FactoryCandidateKey & { validatorId: string }): void { key(evidence); if (evidence.projectId !== expected.projectId || evidence.runId !== expected.runId || evidence.nodeInstanceId !== expected.nodeInstanceId || evidence.candidateGeneration !== expected.candidateGeneration || evidence.validatorId !== expected.validatorId) throw new FactoryAssuranceError("factory_assurance_trust"); requiredText(evidence.validatorId, evidence.artifact.artifactId); requiredDigest(evidence.validatorLockDigest, evidence.candidateDigest, evidence.artifact.digest, evidence.environmentDigest, evidence.configurationDigest, evidence.runnerDigest); const claimIds = new Set<string>(); const invalidClaim = evidence.claims.some(claim => { if (typeof claim.id !== "string" || !VERDICTS.has(claim.verdict) || typeof claim.decisive !== "boolean" || claimIds.has(claim.id)) return true; claimIds.add(claim.id); return false; }); if (!Number.isSafeInteger(evidence.issuerGrantRevision) || evidence.issuerGrantRevision < 1 || !Number.isSafeInteger(evidence.artifact.encodedBytes) || evidence.artifact.encodedBytes < 0 || !Number.isSafeInteger(evidence.issuedAtMs) || !Number.isSafeInteger(evidence.expiresAtMs) || evidence.issuedAtMs > this.now() || evidence.expiresAtMs <= evidence.issuedAtMs || evidence.claims.length > 1000 || invalidClaim) throw new FactoryAssuranceError("factory_assurance_trust"); }
  private async contractRow(transaction: MigrationDb, projectId: string, contractId: string, revision: number): Promise<ContractRow> { const row = rows<ContractRow>(await transaction.execute(sql`SELECT contract_digest, validator_lock_digest, mandatory_claims, claim_groups, approved_by, approval_grant_revision, protected_snapshot_digest FROM factory_acceptance_contracts WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND contract_id=${contractId} AND revision=${revision} FOR SHARE`))[0]; if (!row) throw new FactoryAssuranceError("factory_assurance_not_found"); this.assertProtectedContractRow(row, projectId, contractId, revision); return row; }
  private async decisionRow(transaction: MigrationDb, projectId: string, decisionId: string): Promise<DecisionRow | undefined> { const row = rows<DecisionRow>(await transaction.execute(sql`SELECT decision_id AS "decisionId", candidate_digest AS "candidateDigest", evidence_set_digest AS "evidenceSetDigest", contract_digest AS "contractDigest", contract_snapshot_digest AS "contractSnapshotDigest", contract_id AS "contractId", contract_revision AS "contractRevision", project_id AS "projectId", run_id AS "runId", node_instance_id AS "nodeInstanceId", candidate_generation AS "candidateGeneration", execution_epoch AS "executionEpoch", cancellation_epoch AS "cancellationEpoch", decision_digest AS "decisionDigest" FROM factory_acceptance_decisions WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND decision_id=${decisionId} FOR SHARE`))[0]; if (!row) return undefined; const decision = { ...row, contractRevision: Number(row.contractRevision), candidateGeneration: Number(row.candidateGeneration), executionEpoch: Number(row.executionEpoch), cancellationEpoch: Number(row.cancellationEpoch) }; this.assertDecisionRow(decision); return decision; }
  private async evidenceRows(transaction: MigrationDb, projectId: string, input: FactoryCandidateKey, validatorId?: string): Promise<EvidenceRow[]> { return rows<EvidenceRow>(await transaction.execute(sql`SELECT evidence_id, project_id, run_id, node_instance_id, candidate_generation, candidate_digest, validator_id, validator_lock_digest, issuer_grant_revision, artifact_id, artifact_digest, artifact_bytes, environment_digest, configuration_digest, runner_digest, claims, issued_at_ms, expires_at_ms, evidence_digest FROM factory_acceptance_evidence WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND run_id=${input.runId} AND node_instance_id=${input.nodeInstanceId} AND candidate_generation=${input.candidateGeneration} ${validatorId === undefined ? sql`` : sql`AND validator_id=${validatorId}`} FOR SHARE`)); }
  private evidenceFromRow(row: EvidenceRow): FactoryTrustedEvidence { return { projectId: row.project_id, runId: row.run_id, nodeInstanceId: row.node_instance_id, candidateGeneration: Number(row.candidate_generation), validatorId: row.validator_id, validatorLockDigest: row.validator_lock_digest, issuerGrantRevision: Number(row.issuer_grant_revision), candidateDigest: row.candidate_digest, artifact: { artifactId: row.artifact_id, digest: row.artifact_digest, encodedBytes: Number(row.artifact_bytes) }, environmentDigest: row.environment_digest, configurationDigest: row.configuration_digest, runnerDigest: row.runner_digest, claims: JSON.parse(row.claims), issuedAtMs: Number(row.issued_at_ms), expiresAtMs: Number(row.expires_at_ms) }; }
  private decisionSnapshot(decision: FactoryAcceptanceDecision, contractId: string, contractRevision: number): object { return { tenantId: this.tenantId, projectId: decision.projectId, runId: decision.runId, nodeInstanceId: decision.nodeInstanceId, candidateGeneration: decision.candidateGeneration, executionEpoch: decision.executionEpoch, cancellationEpoch: decision.cancellationEpoch, contractId, contractRevision, decisionId: decision.decisionId, candidateDigest: decision.candidateDigest, evidenceSetDigest: decision.evidenceSetDigest, contractDigest: decision.contractDigest, contractSnapshotDigest: decision.contractSnapshotDigest }; }
  private contractClaims(contract: ContractRow): { requiredClaims: FactoryMandatoryClaim[]; groups: FactoryClaimGroup[] } { try { const requiredClaims = JSON.parse(contract.mandatory_claims) as FactoryMandatoryClaim[]; const groups = JSON.parse(contract.claim_groups) as FactoryClaimGroup[]; claims(requiredClaims, groups); return { requiredClaims, groups }; } catch { throw new FactoryAssuranceError("factory_assurance_corrupt"); } }
  private assertProtectedContractRow(row: ContractRow, projectId: string, contractId: string, revision: number): void { try { const { requiredClaims, groups } = this.contractClaims(row); requiredDigest(row.contract_digest, row.validator_lock_digest, row.protected_snapshot_digest); requiredText(row.approved_by); const approvalGrantRevision = Number(row.approval_grant_revision); if (!Number.isSafeInteger(approvalGrantRevision) || approvalGrantRevision < 1) throw new FactoryAssuranceError("factory_assurance_corrupt"); const actual = protectedContractSnapshotDigest(this.tenantId, { projectId, contractId, revision, contractDigest: row.contract_digest, validatorLockDigest: row.validator_lock_digest, mandatoryClaims: requiredClaims, claimGroups: groups }, row.approved_by, approvalGrantRevision); if (row.protected_snapshot_digest !== actual) throw new FactoryAssuranceError("factory_assurance_corrupt"); } catch { throw new FactoryAssuranceError("factory_assurance_corrupt"); } }
  private assertDecisionRow(decision: DecisionRow): void { try { const contractRevision = Number(decision.contractRevision); key(decision); requiredText(decision.decisionId, decision.contractId); requiredDigest(decision.candidateDigest, decision.evidenceSetDigest, decision.contractDigest, decision.contractSnapshotDigest, decision.decisionDigest); if (!Number.isSafeInteger(contractRevision) || contractRevision < 1 || !Number.isSafeInteger(decision.executionEpoch) || decision.executionEpoch < 1 || !Number.isSafeInteger(decision.cancellationEpoch) || decision.cancellationEpoch < 0 || digest(this.decisionSnapshot(decision, decision.contractId, contractRevision)) !== decision.decisionDigest) throw new FactoryAssuranceError("factory_assurance_corrupt"); } catch { throw new FactoryAssuranceError("factory_assurance_corrupt"); } }
  private async verifyCurrentCandidate(transaction: MigrationDb, key: FactoryCandidateKey, storedEvidence: readonly EvidenceRow[]): Promise<void> { const currentEvidence = snapshot(await this.currentCandidate.resolveCurrentEvidenceInTransaction(transaction, this.tenantId, key, [...new Set(storedEvidence.map(row => row.validator_id))].sort())); for (const evidence of currentEvidence) this.evidence(evidence, { ...key, validatorId: evidence.validatorId }); if (storedEvidence.length !== currentEvidence.length || currentEvidence.some(evidence => evidence.expiresAtMs <= this.now() || !storedEvidence.some(row => row.evidence_digest === digest(evidence)))) throw new FactoryAssuranceError("factory_assurance_stale"); }
  /**
   * Evaluates every required claim and every group, then reports all of them at once.
   *
   * It collects instead of throwing on the first failure because a rejection receipt has to name
   * everything a bounded repair must fix; stopping at the first claim would hide the rest.
   * A missing or stale claim is INCONCLUSIVE, which never satisfies a required claim.
   */
  private verifyEvidence(contract: ContractRow, requiredClaims: readonly FactoryMandatoryClaim[], groups: readonly FactoryClaimGroup[], evidence: readonly EvidenceRow[]): string {
    if (!evidence.length || evidence.some(row => row.validator_lock_digest !== contract.validator_lock_digest || Number(row.expires_at_ms) <= this.now() || Number(row.issued_at_ms) > this.now() || row.evidence_digest !== digest(this.evidenceFromRow(row)))) throw new FactoryAssuranceError("factory_assurance_evidence_stale");
    const candidateDigest = evidence[0]!.candidate_digest;
    if (evidence.some(row => row.candidate_digest !== candidateDigest)) throw new FactoryAssuranceError("factory_assurance_corrupt");
    const results = new Map<string, FactoryValidatorClaimVerdict & { issuedAtMs: number }>();
    for (const row of evidence) for (const claim of JSON.parse(row.claims) as FactoryValidatorClaimVerdict[]) results.set(`${row.validator_id}:${claim.id}`, { ...claim, issuedAtMs: Number(row.issued_at_ms) });
    const evaluated = new Map<string, FactoryValidatorClaimVerdict>();
    const failures: FactoryClaimFailure[] = [];
    for (const claim of requiredClaims) {
      const result = results.get(`${claim.validatorId}:${claim.id}`);
      const fresh = result && this.now() - result.issuedAtMs <= claim.freshnessMs;
      // INCONCLUSIVE and VALIDATOR_ERROR never satisfy a required claim: only PASS does.
      if (claim.required !== false && (!fresh || result.verdict !== "PASS")) failures.push({ claimId: claim.id, validatorId: claim.validatorId, verdict: fresh ? result.verdict : "INCONCLUSIVE", reasonCode: fresh ? result.verdict === "FAIL" ? "claim_failed" : `claim_${result.verdict.toLowerCase()}` : result ? "claim_stale" : "claim_missing" });
      if (fresh) evaluated.set(claim.id, result);
    }
    const groupFailures: FactoryGroupFailure[] = [];
    for (const group of groups) {
      const items = group.claimIds.map(id => evaluated.get(id));
      const passes = items.filter(item => item?.verdict === "PASS").length;
      if (passes < group.minimumPasses || group.requireAllDecisive && items.some(item => !item?.decisive)) groupFailures.push({ groupId: group.id, passes, minimumPasses: group.minimumPasses });
    }
    if (failures.length || groupFailures.length) throw new FactoryAssuranceClaimError(candidateDigest, contract.contract_digest, digest(evidence.map(row => row.evidence_digest).sort()), failures, groupFailures);
    return candidateDigest;
  }
}
