import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { approvalContextDigest, assertApprovalUsable, canonicalApprovalContext, consumeApproval } from "../extensions/v4/approval-context";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { assertFactoryIdentity } from "./records";

export interface FactoryCandidateKey { readonly projectId: string; readonly runId: string; readonly nodeInstanceId: string; readonly candidateGeneration: number }
export interface FactoryMandatoryClaim { readonly id: string; readonly validatorId: string; readonly freshnessMs: number }
export interface FactoryClaimGroup { readonly id: string; readonly claimIds: readonly string[]; readonly minimumPasses: number; readonly requireAllDecisive: boolean }
export interface FactoryContractRevision { readonly projectId: string; readonly contractId: string; readonly revision: number; readonly contractDigest: string; readonly validatorLockDigest: string; readonly mandatoryClaims: readonly FactoryMandatoryClaim[]; readonly claimGroups: readonly FactoryClaimGroup[] }
export interface FactoryTrustedEvidence extends FactoryCandidateKey { readonly validatorId: string; readonly validatorLockDigest: string; readonly issuerGrantRevision: number; readonly candidateDigest: string; readonly artifact: FactoryArtifactReference; readonly environmentDigest: string; readonly configurationDigest: string; readonly runnerDigest: string; readonly claims: readonly { id: string; passed: boolean; decisive: boolean }[]; readonly issuedAtMs: number; readonly expiresAtMs: number }
/** Only the configured gateway may construct this from its exact attempt, validator lock, journal, and host-issued artifact record. */
export interface FactoryTrustedValidatorGateway { resolveValidatorInTransaction(transaction: MigrationDb, tenantId: string, key: FactoryCandidateKey, validatorId: string): Promise<FactoryTrustedEvidence> }
export interface FactoryAcceptanceDecision extends FactoryCandidateKey { readonly decisionId: string; readonly candidateDigest: string; readonly evidenceSetDigest: string; readonly contractDigest: string; readonly executionEpoch: number; readonly cancellationEpoch: number }
export interface FactoryApprovalRequest { readonly projectId: string; readonly operationId: string; readonly decisionId: string; readonly destinationDigest: string; readonly expectedGeneration: number; readonly expiresAtMs: number }
/** Returned only by the composition-owned reader after it takes project, installation, run, and lifecycle locks. */
export interface FactoryReleaseFence { readonly runId: string; readonly executionEpoch: number; readonly cancellationEpoch: number; readonly status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelling" | "cancelled" | "uncertain"; readonly deadlineMs: number }
export interface FactoryReleaseFenceReader { readCurrentInTransaction(transaction: MigrationDb, tenantId: string, projectId: string, runId: string): Promise<FactoryReleaseFence> }
/** Composition resolves these records from the current protected journal and validator lock, never from caller JSON. */
export interface FactoryCurrentCandidateResolver { resolveCurrentEvidenceInTransaction(transaction: MigrationDb, tenantId: string, key: FactoryCandidateKey, validatorIds: readonly string[]): Promise<readonly FactoryTrustedEvidence[]> }
export interface FactoryApprovalConsumption extends FactoryApprovalRequest { readonly approvalId: string; readonly requester: FactoryPrincipal; readonly runId: string }
type ContractRow = { contract_digest: string; validator_lock_digest: string; mandatory_claims: string; claim_groups: string; approved_by: string; approval_grant_revision: number | string };
type EvidenceRow = { evidence_id: string; project_id: string; run_id: string; node_instance_id: string; candidate_generation: number | string; candidate_digest: string; validator_id: string; validator_lock_digest: string; issuer_grant_revision: number | string; artifact_id: string; artifact_digest: string; artifact_bytes: number | string; environment_digest: string; configuration_digest: string; runner_digest: string; claims: string; issued_at_ms: number | string; expires_at_ms: number | string; evidence_digest: string };
type DecisionRow = FactoryAcceptanceDecision & { contractId: string; contractRevision: number | string; decisionDigest: string };
type ApprovalRow = { context_digest: string; status: "pending" | "approved" | "rejected" | "consumed" | "revoked"; principal_id: string; grant_revision: number | string; expected_generation: number | string; expires_at_ms: number | string; decision_id: string; approved_by: string | null; approved_grant_revision: number | string | null };

export class FactoryAssuranceError extends Error { constructor(readonly code: string) { super(code); this.name = "FactoryAssuranceError"; } }
const digest = (value: unknown) => `sha256:${digestObject(value)}`;
const requiredText = (...values: readonly string[]) => { if (values.some(value => typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0"))) throw new FactoryAssuranceError("factory_assurance_invalid"); };
const requiredDigest = (...values: readonly string[]) => { if (values.some(value => !/^sha256:[a-f0-9]{64}$/.test(value))) throw new FactoryAssuranceError("factory_assurance_invalid"); };
const counter = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw new FactoryAssuranceError("factory_assurance_invalid"); };
const encoded = (value: unknown) => canonicalJson(value);
const snapshot = <Value>(value: Value): Value => JSON.parse(encoded(value)) as Value;
function key(input: FactoryCandidateKey): void { requiredText(input.projectId, input.runId, input.nodeInstanceId); counter(input.candidateGeneration); }
function claims(input: readonly FactoryMandatoryClaim[], groups: readonly FactoryClaimGroup[]): void {
  const ids = new Set<string>();
  if (input.length > 1000 || groups.length > 1000) throw new FactoryAssuranceError("factory_assurance_invalid");
  for (const claim of input) { requiredText(claim.id, claim.validatorId); if (!Number.isSafeInteger(claim.freshnessMs) || claim.freshnessMs < 1 || ids.has(claim.id)) throw new FactoryAssuranceError("factory_assurance_invalid"); ids.add(claim.id); }
  const groupIds = new Set<string>();
  for (const group of groups) { requiredText(group.id); if (typeof group.requireAllDecisive !== "boolean" || group.claimIds.length > 1000 || groupIds.has(group.id) || !Number.isSafeInteger(group.minimumPasses) || group.minimumPasses < 1 || group.minimumPasses > group.claimIds.length || !group.claimIds.every(id => ids.has(id))) throw new FactoryAssuranceError("factory_assurance_invalid"); groupIds.add(group.id); }
}

/** C04 product facts. Tenant identity is constructor-owned and cannot come from an input body. */
export class FactoryAssurance {
  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly grants: FactoryGrants, private readonly gateway: FactoryTrustedValidatorGateway, private readonly releaseFenceReader: FactoryReleaseFenceReader, private readonly currentCandidate: FactoryCurrentCandidateResolver, private readonly now: () => number = Date.now) { assertFactoryIdentity(tenantId); if (grants.tenantId !== tenantId) throw new FactoryAssuranceError("factory_assurance_scope"); }

  async approveContract(actor: FactoryPrincipal, input: FactoryContractRevision): Promise<void> {
    [actor, input] = snapshot([actor, input]);
    this.contract(input);
    await this.database.transaction(async transaction => {
      const authority = await this.grants.authorizeInTransaction(transaction, actor, input.projectId, "factory.trust");
      await transaction.execute(sql`INSERT INTO factory_acceptance_contracts (tenant_id, project_id, contract_id, revision, contract_digest, validator_lock_digest, mandatory_claims, claim_groups, approved_by, approval_grant_revision) VALUES (${this.tenantId}, ${input.projectId}, ${input.contractId}, ${input.revision}, ${input.contractDigest}, ${input.validatorLockDigest}, ${encoded(input.mandatoryClaims)}, ${encoded(input.claimGroups)}, ${actor.id}, ${authority.revision}) ON CONFLICT (tenant_id, project_id, contract_id, revision) DO NOTHING`);
      const saved = (rows<ContractRow>(await transaction.execute(sql`SELECT contract_digest, validator_lock_digest, mandatory_claims, claim_groups, approved_by, approval_grant_revision FROM factory_acceptance_contracts WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND contract_id=${input.contractId} AND revision=${input.revision} FOR SHARE`))[0]);
      if (!saved || saved.contract_digest !== input.contractDigest || saved.validator_lock_digest !== input.validatorLockDigest || saved.mandatory_claims !== encoded(input.mandatoryClaims) || saved.claim_groups !== encoded(input.claimGroups)) throw new FactoryAssuranceError("factory_assurance_conflict");
      await insertTransactionalAuditEntry(transaction, `factory-assurance-contract:${digest(input)}:${authority.revision}`, actor.id, "factory.assurance.contract.approved", input.contractId, { tenantId: this.tenantId, projectId: input.projectId, revision: input.revision, contractDigest: input.contractDigest, validatorLockDigest: input.validatorLockDigest });
    });
  }

  async captureEvidence(input: FactoryCandidateKey & { readonly validatorId: string }): Promise<string> {
    input = snapshot(input);
    key(input); requiredText(input.validatorId);
    return this.database.transaction(async transaction => {
      const evidence = await this.gateway.resolveValidatorInTransaction(transaction, this.tenantId, input, input.validatorId);
      this.evidence(evidence, input);
      const evidenceDigest = digest(evidence);
      const id = randomUUID();
      await transaction.execute(sql`INSERT INTO factory_acceptance_evidence (tenant_id, project_id, evidence_id, run_id, node_instance_id, candidate_generation, candidate_digest, validator_id, validator_lock_digest, issuer_grant_revision, artifact_id, artifact_digest, artifact_bytes, environment_digest, configuration_digest, runner_digest, claims, issued_at_ms, expires_at_ms, evidence_digest) VALUES (${this.tenantId}, ${evidence.projectId}, ${id}, ${evidence.runId}, ${evidence.nodeInstanceId}, ${evidence.candidateGeneration}, ${evidence.candidateDigest}, ${evidence.validatorId}, ${evidence.validatorLockDigest}, ${evidence.issuerGrantRevision}, ${evidence.artifact.artifactId}, ${evidence.artifact.digest}, ${evidence.artifact.encodedBytes}, ${evidence.environmentDigest}, ${evidence.configurationDigest}, ${evidence.runnerDigest}, ${encoded(evidence.claims)}, ${evidence.issuedAtMs}, ${evidence.expiresAtMs}, ${evidenceDigest}) ON CONFLICT (tenant_id, project_id, run_id, node_instance_id, candidate_generation, validator_id) DO NOTHING`);
      const prior = (await this.evidenceRows(transaction, evidence.projectId, evidence, evidence.validatorId))[0];
      if (!prior || prior.evidence_digest !== evidenceDigest) throw new FactoryAssuranceError("factory_assurance_conflict");
      return prior.evidence_id;
    });
  }

  async accept(input: FactoryCandidateKey & { readonly contractId: string; readonly revision: number }): Promise<FactoryAcceptanceDecision> {
    input = snapshot(input);
    key(input); requiredText(input.contractId); if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new FactoryAssuranceError("factory_assurance_invalid");
    return this.database.transaction(async transaction => {
      const fence = await this.releaseFenceReader.readCurrentInTransaction(transaction, this.tenantId, input.projectId, input.runId);
      if (fence.runId !== input.runId || !["queued", "running", "waiting"].includes(fence.status) || fence.deadlineMs <= this.now() || !Number.isSafeInteger(fence.executionEpoch) || !Number.isSafeInteger(fence.cancellationEpoch)) throw new FactoryAssuranceError("factory_assurance_stale");
      const contract = await this.contractRow(transaction, input.projectId, input.contractId, input.revision);
      await this.grants.authorizeInTransaction(transaction, { kind: "user", id: contract.approved_by, authentication: "session" }, input.projectId, "factory.trust", Number(contract.approval_grant_revision));
      const requiredClaims = JSON.parse(contract.mandatory_claims) as FactoryMandatoryClaim[]; const groups = JSON.parse(contract.claim_groups) as FactoryClaimGroup[]; claims(requiredClaims, groups);
      const evidence = await this.evidenceRows(transaction, input.projectId, input);
      const candidateDigest = this.verifyEvidence(contract, requiredClaims, groups, evidence);
      const evidenceSetDigest = digest(evidence.map(row => row.evidence_digest).sort()); const decision = { ...input, decisionId: randomUUID(), candidateDigest, evidenceSetDigest, contractDigest: contract.contract_digest, executionEpoch: fence.executionEpoch, cancellationEpoch: fence.cancellationEpoch };
      const decisionDigest = digest(this.decisionSnapshot(decision, input.contractId, input.revision));
      await transaction.execute(sql`INSERT INTO factory_acceptance_decisions (tenant_id, project_id, decision_id, contract_id, contract_revision, contract_digest, candidate_digest, evidence_set_digest, decision_digest, run_id, node_instance_id, candidate_generation, execution_epoch, cancellation_epoch) VALUES (${this.tenantId}, ${input.projectId}, ${decision.decisionId}, ${input.contractId}, ${input.revision}, ${decision.contractDigest}, ${decision.candidateDigest}, ${decision.evidenceSetDigest}, ${decisionDigest}, ${input.runId}, ${input.nodeInstanceId}, ${input.candidateGeneration}, ${fence.executionEpoch}, ${fence.cancellationEpoch}) ON CONFLICT DO NOTHING`);
      const saved = rows<FactoryAcceptanceDecision>(await transaction.execute(sql`SELECT decision_id AS "decisionId", candidate_digest AS "candidateDigest", evidence_set_digest AS "evidenceSetDigest", contract_digest AS "contractDigest", project_id AS "projectId", run_id AS "runId", node_instance_id AS "nodeInstanceId", candidate_generation AS "candidateGeneration", execution_epoch AS "executionEpoch", cancellation_epoch AS "cancellationEpoch" FROM factory_acceptance_decisions WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND contract_id=${input.contractId} AND contract_revision=${input.revision} AND run_id=${input.runId} AND node_instance_id=${input.nodeInstanceId} AND candidate_generation=${input.candidateGeneration} AND candidate_digest=${candidateDigest} FOR SHARE`))[0];
      if (!saved || saved.evidenceSetDigest !== evidenceSetDigest) throw new FactoryAssuranceError("factory_assurance_conflict");
      return saved;
    });
  }

  async requestApproval(actor: FactoryPrincipal, input: FactoryApprovalRequest): Promise<{ approvalId: string; contextDigest: string }> {
    [actor, input] = snapshot([actor, input]);
    requiredText(input.projectId, input.operationId, input.decisionId); requiredDigest(input.destinationDigest); counter(input.expectedGeneration); if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= this.now() || input.expiresAtMs - this.now() > 86_400_000) throw new FactoryAssuranceError("factory_assurance_invalid");
    return this.database.transaction(async transaction => {
      const authority = await this.grants.authorizeInTransaction(transaction, actor, input.projectId, "factory.approve");
      const decision = await this.decisionRow(transaction, input.projectId, input.decisionId);
      if (!decision) throw new FactoryAssuranceError("factory_assurance_not_found");
      const context = canonicalApprovalContext({ subjectId: input.operationId, subjectDigest: digest({ decision, destinationDigest: input.destinationDigest }), principalId: actor.id, scope: input.projectId, grants: ["factory.release"], expectedGeneration: input.expectedGeneration, expiresAtMs: input.expiresAtMs }); const contextDigest = approvalContextDigest(context); const approvalId = randomUUID();
      await transaction.execute(sql`INSERT INTO factory_release_approvals (tenant_id, project_id, approval_id, operation_id, context_digest, decision_id, principal_id, grant_revision, expected_generation, expires_at_ms, status) VALUES (${this.tenantId}, ${input.projectId}, ${approvalId}, ${input.operationId}, ${contextDigest}, ${input.decisionId}, ${actor.id}, ${authority.revision}, ${input.expectedGeneration}, ${input.expiresAtMs}, 'pending')`);
      return { approvalId, contextDigest };
    });
  }

  async decideApproval(actor: FactoryPrincipal, projectId: string, approvalId: string, approved: boolean): Promise<void> {
    [actor, projectId, approvalId, approved] = snapshot([actor, projectId, approvalId, approved]);
    requiredText(projectId, approvalId);
    await this.database.transaction(async transaction => {
      const authority = await this.grants.authorizeInTransaction(transaction, actor, projectId, "factory.approve");
      const changed = rows(await transaction.execute(sql`UPDATE factory_release_approvals SET status=${approved ? "approved" : "rejected"}, approved_by=${actor.id}, approved_grant_revision=${authority.revision} WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND approval_id=${approvalId} AND status='pending' RETURNING approval_id`));
      if (!changed.length) throw new FactoryAssuranceError("factory_assurance_decided");
    });
  }

  /** The injected reader holds the shared project/install/run/lifecycle locks before this effect claim. */
  async consumeApprovalInTransaction(transaction: MigrationDb, input: FactoryApprovalConsumption): Promise<void> {
    input = snapshot(input);
    requiredText(input.projectId, input.operationId, input.decisionId, input.approvalId, input.requester.id, input.runId); requiredDigest(input.destinationDigest); counter(input.expectedGeneration);
    const fence = await this.releaseFenceReader.readCurrentInTransaction(transaction, this.tenantId, input.projectId, input.runId);
    if (fence.runId !== input.runId || !["queued", "running", "waiting"].includes(fence.status) || !Number.isSafeInteger(fence.executionEpoch) || fence.executionEpoch < 1 || !Number.isSafeInteger(fence.cancellationEpoch) || fence.cancellationEpoch < 0 || !Number.isSafeInteger(fence.deadlineMs) || fence.deadlineMs <= this.now()) throw new FactoryAssuranceError("factory_assurance_stale");
    const row = rows<ApprovalRow>(await transaction.execute(sql`SELECT context_digest, status, principal_id, grant_revision, expected_generation, expires_at_ms, decision_id, approved_by, approved_grant_revision FROM factory_release_approvals WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND approval_id=${input.approvalId} FOR UPDATE`))[0];
    if (!row || row.decision_id !== input.decisionId) throw new FactoryAssuranceError("factory_assurance_not_found");
    const decision = await this.decisionRow(transaction, input.projectId, input.decisionId);
    if (!decision) throw new FactoryAssuranceError("factory_assurance_not_found");
    if (decision.runId !== input.runId || decision.cancellationEpoch !== fence.cancellationEpoch || decision.executionEpoch !== fence.executionEpoch) throw new FactoryAssuranceError("factory_assurance_stale");
    const contract = await this.contractRow(transaction, input.projectId, decision.contractId, Number(decision.contractRevision));
    if (contract.contract_digest !== decision.contractDigest) throw new FactoryAssuranceError("factory_assurance_corrupt");
    await this.grants.authorizeInTransaction(transaction, { kind: "user", id: contract.approved_by, authentication: "session" }, input.projectId, "factory.trust", Number(contract.approval_grant_revision));
    const storedEvidence = await this.evidenceRows(transaction, input.projectId, decision);
    const requiredClaims = JSON.parse(contract.mandatory_claims) as FactoryMandatoryClaim[]; const groups = JSON.parse(contract.claim_groups) as FactoryClaimGroup[]; claims(requiredClaims, groups);
    if (this.verifyEvidence(contract, requiredClaims, groups, storedEvidence) !== decision.candidateDigest || digest(storedEvidence.map(item => item.evidence_digest).sort()) !== decision.evidenceSetDigest || digest(this.decisionSnapshot(decision, decision.contractId, Number(decision.contractRevision))) !== decision.decisionDigest) throw new FactoryAssuranceError("factory_assurance_corrupt");
    const currentEvidence = await this.currentCandidate.resolveCurrentEvidenceInTransaction(transaction, this.tenantId, decision, [...new Set(storedEvidence.map(row => row.validator_id))].sort());
    for (const evidence of currentEvidence) this.evidence(evidence, { ...decision, validatorId: evidence.validatorId });
    if (storedEvidence.length !== currentEvidence.length || currentEvidence.some(evidence => evidence.expiresAtMs <= this.now() || !storedEvidence.some(row => row.evidence_digest === digest(evidence)))) throw new FactoryAssuranceError("factory_assurance_stale");
    const context = { subjectId: input.operationId, subjectDigest: digest({ decision, destinationDigest: input.destinationDigest }), principalId: row.principal_id, scope: input.projectId, grants: ["factory.release"], expectedGeneration: Number(row.expected_generation), expiresAtMs: Number(row.expires_at_ms) };
    if (row.context_digest !== approvalContextDigest(context)) throw new FactoryAssuranceError("factory_assurance_corrupt");
    try { assertApprovalUsable(row.status, context, { subjectDigest: context.subjectDigest, principalId: row.principal_id, scope: input.projectId, expectedGeneration: input.expectedGeneration }, this.now(), true); } catch { throw new FactoryAssuranceError("factory_assurance_stale"); }
    await this.grants.authorizeInTransaction(transaction, input.requester, input.projectId, "factory.release");
    if (!row.approved_by || row.approved_grant_revision === null) throw new FactoryAssuranceError("factory_assurance_stale");
    await this.grants.authorizeInTransaction(transaction, { kind: "user", id: row.approved_by, authentication: "session" }, input.projectId, "factory.approve", Number(row.approved_grant_revision));
    const changed = rows(await transaction.execute(sql`UPDATE factory_release_approvals SET status=${consumeApproval(row.status)}, consumed_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND approval_id=${input.approvalId} AND status='approved' RETURNING approval_id`));
    if (!changed.length) throw new FactoryAssuranceError("factory_assurance_stale");
  }

  private contract(input: FactoryContractRevision): void { requiredText(input.projectId, input.contractId); requiredDigest(input.contractDigest, input.validatorLockDigest); if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new FactoryAssuranceError("factory_assurance_invalid"); claims(input.mandatoryClaims, input.claimGroups); }
  private evidence(evidence: FactoryTrustedEvidence, expected: FactoryCandidateKey & { validatorId: string }): void { key(evidence); if (evidence.projectId !== expected.projectId || evidence.runId !== expected.runId || evidence.nodeInstanceId !== expected.nodeInstanceId || evidence.candidateGeneration !== expected.candidateGeneration || evidence.validatorId !== expected.validatorId) throw new FactoryAssuranceError("factory_assurance_trust"); requiredText(evidence.validatorId, evidence.artifact.artifactId); requiredDigest(evidence.validatorLockDigest, evidence.candidateDigest, evidence.artifact.digest, evidence.environmentDigest, evidence.configurationDigest, evidence.runnerDigest); const claimIds = new Set<string>(); const invalidClaim = evidence.claims.some(claim => { if (typeof claim.id !== "string" || typeof claim.passed !== "boolean" || typeof claim.decisive !== "boolean" || claimIds.has(claim.id)) return true; claimIds.add(claim.id); return false; }); if (!Number.isSafeInteger(evidence.issuerGrantRevision) || evidence.issuerGrantRevision < 1 || !Number.isSafeInteger(evidence.artifact.encodedBytes) || evidence.artifact.encodedBytes < 0 || !Number.isSafeInteger(evidence.issuedAtMs) || !Number.isSafeInteger(evidence.expiresAtMs) || evidence.issuedAtMs > this.now() || evidence.expiresAtMs <= evidence.issuedAtMs || evidence.claims.length > 1000 || invalidClaim) throw new FactoryAssuranceError("factory_assurance_trust"); }
  private async contractRow(transaction: MigrationDb, projectId: string, contractId: string, revision: number): Promise<ContractRow> { const row = rows<ContractRow>(await transaction.execute(sql`SELECT contract_digest, validator_lock_digest, mandatory_claims, claim_groups, approved_by, approval_grant_revision FROM factory_acceptance_contracts WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND contract_id=${contractId} AND revision=${revision} FOR SHARE`))[0]; if (!row) throw new FactoryAssuranceError("factory_assurance_not_found"); return row; }
  private async decisionRow(transaction: MigrationDb, projectId: string, decisionId: string): Promise<DecisionRow | undefined> { const row = rows<DecisionRow>(await transaction.execute(sql`SELECT decision_id AS "decisionId", candidate_digest AS "candidateDigest", evidence_set_digest AS "evidenceSetDigest", contract_digest AS "contractDigest", contract_id AS "contractId", contract_revision AS "contractRevision", project_id AS "projectId", run_id AS "runId", node_instance_id AS "nodeInstanceId", candidate_generation AS "candidateGeneration", execution_epoch AS "executionEpoch", cancellation_epoch AS "cancellationEpoch", decision_digest AS "decisionDigest" FROM factory_acceptance_decisions WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND decision_id=${decisionId} FOR SHARE`))[0]; return row && { ...row, contractRevision: Number(row.contractRevision), candidateGeneration: Number(row.candidateGeneration), executionEpoch: Number(row.executionEpoch), cancellationEpoch: Number(row.cancellationEpoch) }; }
  private async evidenceRows(transaction: MigrationDb, projectId: string, input: FactoryCandidateKey, validatorId?: string): Promise<EvidenceRow[]> { return rows<EvidenceRow>(await transaction.execute(sql`SELECT evidence_id, project_id, run_id, node_instance_id, candidate_generation, candidate_digest, validator_id, validator_lock_digest, issuer_grant_revision, artifact_id, artifact_digest, artifact_bytes, environment_digest, configuration_digest, runner_digest, claims, issued_at_ms, expires_at_ms, evidence_digest FROM factory_acceptance_evidence WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND run_id=${input.runId} AND node_instance_id=${input.nodeInstanceId} AND candidate_generation=${input.candidateGeneration} ${validatorId === undefined ? sql`` : sql`AND validator_id=${validatorId}`} FOR SHARE`)); }
  private evidenceFromRow(row: EvidenceRow): FactoryTrustedEvidence { return { projectId: row.project_id, runId: row.run_id, nodeInstanceId: row.node_instance_id, candidateGeneration: Number(row.candidate_generation), validatorId: row.validator_id, validatorLockDigest: row.validator_lock_digest, issuerGrantRevision: Number(row.issuer_grant_revision), candidateDigest: row.candidate_digest, artifact: { artifactId: row.artifact_id, digest: row.artifact_digest, encodedBytes: Number(row.artifact_bytes) }, environmentDigest: row.environment_digest, configurationDigest: row.configuration_digest, runnerDigest: row.runner_digest, claims: JSON.parse(row.claims), issuedAtMs: Number(row.issued_at_ms), expiresAtMs: Number(row.expires_at_ms) }; }
  private decisionSnapshot(decision: FactoryAcceptanceDecision, contractId: string, contractRevision: number): object { return { tenantId: this.tenantId, projectId: decision.projectId, runId: decision.runId, nodeInstanceId: decision.nodeInstanceId, candidateGeneration: decision.candidateGeneration, executionEpoch: decision.executionEpoch, cancellationEpoch: decision.cancellationEpoch, contractId, contractRevision, decisionId: decision.decisionId, candidateDigest: decision.candidateDigest, evidenceSetDigest: decision.evidenceSetDigest, contractDigest: decision.contractDigest }; }
  private verifyEvidence(contract: ContractRow, requiredClaims: readonly FactoryMandatoryClaim[], groups: readonly FactoryClaimGroup[], evidence: readonly EvidenceRow[]): string { if (!evidence.length || evidence.some(row => row.validator_lock_digest !== contract.validator_lock_digest || Number(row.expires_at_ms) <= this.now() || Number(row.issued_at_ms) > this.now() || row.evidence_digest !== digest(this.evidenceFromRow(row)))) throw new FactoryAssuranceError("factory_assurance_evidence_stale"); const candidateDigest = evidence[0]!.candidate_digest; if (evidence.some(row => row.candidate_digest !== candidateDigest)) throw new FactoryAssuranceError("factory_assurance_corrupt"); const results = new Map<string, { passed: boolean; decisive: boolean; issuedAtMs: number }>(); for (const row of evidence) for (const claim of JSON.parse(row.claims) as Array<{ id: string; passed: boolean; decisive: boolean }>) results.set(`${row.validator_id}:${claim.id}`, { ...claim, issuedAtMs: Number(row.issued_at_ms) }); const passed = new Map<string, { passed: boolean; decisive: boolean }>(); for (const claim of requiredClaims) { const result = results.get(`${claim.validatorId}:${claim.id}`); if (!result?.passed || this.now() - result.issuedAtMs > claim.freshnessMs) throw new FactoryAssuranceError("factory_assurance_claim_failed"); passed.set(claim.id, result); } for (const group of groups) { const items = group.claimIds.map(id => passed.get(id)); if (items.filter(Boolean).length < group.minimumPasses || group.requireAllDecisive && items.some(item => !item?.decisive)) throw new FactoryAssuranceError("factory_assurance_claim_failed"); } return candidateDigest; }
}
