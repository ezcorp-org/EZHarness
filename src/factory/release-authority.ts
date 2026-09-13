import type { FactoryArtifactReference, FactoryRunnerRequest, FactoryRunnerResult, RunnerReference } from "@ezcorp/factory-sdk";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryArtifacts } from "./artifacts";
import type { FactoryAcceptedRelease, FactoryCandidateKey } from "./assurance";
import type { FactoryExecutionJournal, FactoryAttemptAuthority, FactoryExecutionTerminalFact } from "./executions";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { lockFactoryScope } from "./locks";
import { FactoryMutations } from "./mutations";
import { assertFactoryIdentity, type FactoryRunKey } from "./records";
import type { FactoryReleaseAuthority, FactoryReleaseAuthorityReader, FactoryReleaseMaterial, FactoryReleaseMaterialReader } from "./releases";
import type { FactoryRunFence } from "./run-lifecycle";

const MAX_LOCK_BYTES = 16 * 1024;
const encoder = new TextEncoder();

export interface FactoryReleaseRunLifecycle {
  readonly tenantId: string;
  authorizeRunInTransaction(transaction: MigrationDb, key: FactoryRunKey): Promise<FactoryRunFence>;
}

export interface FactoryReleaseTrustPublication {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly packageLock: RunnerReference;
  readonly validatorTrustDigest: string;
}

export interface FactoryReleaseTrustRecord {
  readonly projectId: string;
  readonly revision: number;
  readonly state: "active" | "revoked";
  readonly packageLock: RunnerReference;
  readonly packageTrustDigest: string;
  readonly validatorTrustDigest: string;
  readonly approvedBy: string;
  readonly approvalGrantRevision: number;
}

export interface FactoryReleaseControl {
  readonly projectId: string;
  readonly enabled: boolean;
  readonly enableEpoch: number;
}

/** Current host-issued candidate material that may be read by protected validators. */
export interface FactoryValidationCandidate {
  readonly projectId: string;
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly candidateGeneration: number;
  readonly candidateDigest: string;
  readonly artifact: FactoryArtifactReference;
  readonly definitionDigest: string;
  readonly executionEpoch: number;
  readonly cancellationEpoch: number;
  readonly deadlineMs: number;
  readonly trustRevision: number;
  readonly issuerGrantRevision: number;
  readonly validatorLockDigest: string;
}

export interface FactoryCurrentCandidateCommit {
  readonly authority: FactoryAttemptAuthority;
  readonly result: FactoryRunnerResult;
  readonly expectedCurrentGeneration: number | null;
}

type TrustRow = { revision: number | string; state: "active" | "revoked"; package_lock_json: string; package_trust_digest: string; validator_trust_digest: string; approved_by: string; approval_grant_revision: number | string; protected_digest: string };
type ControlRow = { enabled: boolean; enable_epoch: number | string; changed_by: string; grant_revision: number | string; protected_digest: string };
type CandidateRow = { candidate_generation: number | string; candidate_digest: string; attempt_id: string; pointer_revision: number | string; execution_epoch: number | string; cancellation_epoch: number | string; terminal_fact_digest: string; output_artifact_id: string; output_bytes: number | string; trust_revision: number | string; package_trust_digest: string; validator_trust_digest: string; proof_digest: string };
type CandidateCommitSnapshot = {
  readonly authority: Omit<FactoryAttemptAuthority, "deadlineAt"> & { readonly deadlineAtMs: number };
  readonly result: FactoryRunnerResult;
  readonly expectedCurrentGeneration: number | null;
};

export class FactoryReleaseAuthorityError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryReleaseAuthorityError"; }
}

function hash(value: unknown): string { return `sha256:${digestObject(value)}`; }
function sha(value: string): void { if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new FactoryReleaseAuthorityError("factory_release_authority_invalid"); }
function counter(value: number, minimum: number): void { if (!Number.isSafeInteger(value) || value < minimum) throw new FactoryReleaseAuthorityError("factory_release_authority_invalid"); }
function human(actor: FactoryPrincipal): void { if (actor.kind !== "user" || actor.authentication !== "session") throw new FactoryReleaseAuthorityError("factory_release_authority_human_required"); }

function validatePackageLock(lock: RunnerReference): RunnerReference {
  const copy = JSON.parse(canonicalJson(lock)) as RunnerReference;
  const allowed = new Set(["package", "version", "digest", "export", "model", "configurationDigest"]);
  if (!Object.keys(copy).every(key => allowed.has(key)) || [copy.package, copy.version, copy.export].some(value => typeof value !== "string" || value.length < 1 || value.length > 512 || value.includes("\0")) || copy.version === "latest" || copy.version.includes("*") || encoder.encode(canonicalJson(copy)).byteLength > MAX_LOCK_BYTES) throw new FactoryReleaseAuthorityError("factory_release_authority_invalid");
  sha(copy.digest);
  if (copy.model !== undefined && (typeof copy.model !== "string" || copy.model.length < 1 || copy.model.length > 512)) throw new FactoryReleaseAuthorityError("factory_release_authority_invalid");
  if (copy.configurationDigest !== undefined) sha(copy.configurationDigest);
  return copy;
}

function trustSeal(tenantId: string, projectId: string, revision: number, state: TrustRow["state"], packageLock: RunnerReference, packageTrustDigest: string, validatorTrustDigest: string, approvedBy: string, approvalGrantRevision: number): string {
  return hash({ tenantId, projectId, revision, state, packageLock, packageTrustDigest, validatorTrustDigest, approvedBy, approvalGrantRevision });
}

function controlSeal(tenantId: string, projectId: string, enabled: boolean, enableEpoch: number, changedBy: string, grantRevision: number): string {
  return hash({ tenantId, projectId, enabled, enableEpoch, changedBy, grantRevision });
}

function candidateSeal(terminal: FactoryExecutionTerminalFact, trust: FactoryReleaseTrustRecord): string {
  return hash({ terminal, trustRevision: trust.revision, packageTrustDigest: trust.packageTrustDigest, validatorTrustDigest: trust.validatorTrustDigest });
}

/** Durable C04 authority composition. Historical terminal and candidate facts are immutable; only explicit pointers change. */
export class FactoryReleaseAuthorityStore implements FactoryReleaseAuthorityReader, FactoryReleaseMaterialReader {
  private readonly mutations: FactoryMutations;
  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly grants: FactoryGrants,
    private readonly lifecycle: FactoryReleaseRunLifecycle,
    private readonly journal: FactoryExecutionJournal,
    private readonly artifacts: FactoryArtifacts,
  ) {
    assertFactoryIdentity(tenantId);
    if (grants.tenantId !== tenantId || lifecycle.tenantId !== tenantId || journal.database !== database || artifacts.database !== database) throw new FactoryReleaseAuthorityError("factory_release_authority_scope");
    this.mutations = new FactoryMutations(database, tenantId, grants);
  }

  async publishTrust(actor: FactoryPrincipal, input: FactoryReleaseTrustPublication, idempotencyKey: string): Promise<FactoryReleaseTrustRecord> {
    actor = JSON.parse(canonicalJson(actor)) as FactoryPrincipal;
    input = JSON.parse(canonicalJson(input)) as FactoryReleaseTrustPublication;
    human(actor); assertFactoryIdentity(input.projectId); counter(input.expectedRevision, 0); sha(input.validatorTrustDigest);
    const packageLock = validatePackageLock(input.packageLock);
    return this.mutations.execute({ principal: actor, projectId: input.projectId, action: "factory.trust", idempotencyKey, input: { kind: "release.trust.publish", expectedRevision: input.expectedRevision, packageLock, validatorTrustDigest: input.validatorTrustDigest } }, async transaction => {
      if (!await lockFactoryScope(transaction, this.tenantId, input.projectId, "write")) throw new FactoryReleaseAuthorityError("factory_release_authority_scope");
      const current = await this.currentTrustRow(transaction, input.projectId, "update");
      if (current) this.trustRecord(current, input.projectId);
      if (Number(current?.revision ?? 0) !== input.expectedRevision) throw new FactoryReleaseAuthorityError("factory_release_trust_conflict");
      const authority = await this.grants.authorizeInTransaction(transaction, actor, input.projectId, "factory.trust");
      const revision = input.expectedRevision + 1; counter(revision, 1);
      const packageTrustDigest = hash(packageLock);
      const protectedDigest = trustSeal(this.tenantId, input.projectId, revision, "active", packageLock, packageTrustDigest, input.validatorTrustDigest, actor.id, authority.revision);
      await transaction.execute(sql`INSERT INTO factory_release_trust_revisions (tenant_id,project_id,revision,state,package_lock_json,package_trust_digest,validator_trust_digest,approved_by,approval_grant_revision,protected_digest) VALUES (${this.tenantId},${input.projectId},${revision},'active',${canonicalJson(packageLock)},${packageTrustDigest},${input.validatorTrustDigest},${actor.id},${authority.revision},${protectedDigest})`);
      await transaction.execute(sql`INSERT INTO factory_release_trust_current (tenant_id,project_id,revision) VALUES (${this.tenantId},${input.projectId},${revision}) ON CONFLICT (tenant_id,project_id) DO UPDATE SET revision=EXCLUDED.revision,updated_at=NOW()`);
      await insertTransactionalAuditEntry(transaction, `factory-release-trust:${this.tenantId}:${input.projectId}:${revision}`, actor.id, "factory.release.trust.published", input.projectId, { tenantId: this.tenantId, projectId: input.projectId, revision, packageTrustDigest, validatorTrustDigest: input.validatorTrustDigest, approvalGrantRevision: authority.revision });
      return { projectId: input.projectId, revision, state: "active", packageLock, packageTrustDigest, validatorTrustDigest: input.validatorTrustDigest, approvedBy: actor.id, approvalGrantRevision: authority.revision };
    });
  }

  async revokeTrust(actor: FactoryPrincipal, projectId: string, expectedRevision: number, idempotencyKey: string): Promise<FactoryReleaseTrustRecord> {
    actor = JSON.parse(canonicalJson(actor)) as FactoryPrincipal; projectId = JSON.parse(canonicalJson(projectId));
    human(actor); assertFactoryIdentity(projectId); counter(expectedRevision, 1);
    return this.mutations.execute({ principal: actor, projectId, action: "factory.trust", idempotencyKey, input: { kind: "release.trust.revoke", expectedRevision } }, async transaction => {
      if (!await lockFactoryScope(transaction, this.tenantId, projectId, "write")) throw new FactoryReleaseAuthorityError("factory_release_authority_scope");
      const current = await this.requireTrust(transaction, projectId, "update", false);
      if (current.revision !== expectedRevision || current.state !== "active") throw new FactoryReleaseAuthorityError("factory_release_trust_conflict");
      const authority = await this.grants.authorizeInTransaction(transaction, actor, projectId, "factory.trust");
      const revision = expectedRevision + 1; counter(revision, 1);
      const protectedDigest = trustSeal(this.tenantId, projectId, revision, "revoked", current.packageLock, current.packageTrustDigest, current.validatorTrustDigest, actor.id, authority.revision);
      await transaction.execute(sql`INSERT INTO factory_release_trust_revisions (tenant_id,project_id,revision,state,package_lock_json,package_trust_digest,validator_trust_digest,approved_by,approval_grant_revision,protected_digest) VALUES (${this.tenantId},${projectId},${revision},'revoked',${canonicalJson(current.packageLock)},${current.packageTrustDigest},${current.validatorTrustDigest},${actor.id},${authority.revision},${protectedDigest})`);
      const changed = rows(await transaction.execute(sql`UPDATE factory_release_trust_current SET revision=${revision},updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND revision=${expectedRevision} RETURNING revision`));
      if (changed.length !== 1) throw new FactoryReleaseAuthorityError("factory_release_trust_conflict");
      await insertTransactionalAuditEntry(transaction, `factory-release-trust:${this.tenantId}:${projectId}:${revision}`, actor.id, "factory.release.trust.revoked", projectId, { tenantId: this.tenantId, projectId, revision, priorRevision: expectedRevision, approvalGrantRevision: authority.revision });
      return { ...current, revision, state: "revoked", approvedBy: actor.id, approvalGrantRevision: authority.revision };
    });
  }

  async setReleaseEnabled(actor: FactoryPrincipal, projectId: string, enabled: boolean, expectedEpoch: number, idempotencyKey: string): Promise<FactoryReleaseControl> {
    actor = JSON.parse(canonicalJson(actor)) as FactoryPrincipal; projectId = JSON.parse(canonicalJson(projectId));
    human(actor); assertFactoryIdentity(projectId); counter(expectedEpoch, 0);
    if (typeof enabled !== "boolean") throw new FactoryReleaseAuthorityError("factory_release_authority_invalid");
    return this.mutations.execute({ principal: actor, projectId, action: "factory.trust", idempotencyKey, input: { kind: "release.control.set", enabled, expectedEpoch } }, async transaction => {
      if (!await lockFactoryScope(transaction, this.tenantId, projectId, "write")) throw new FactoryReleaseAuthorityError("factory_release_authority_scope");
      const current = await this.currentControlRow(transaction, projectId, "update");
      if (Number(current?.enable_epoch ?? 0) !== expectedEpoch || (current?.enabled ?? false) === enabled) throw new FactoryReleaseAuthorityError("factory_release_control_conflict");
      const authority = await this.grants.authorizeInTransaction(transaction, actor, projectId, "factory.trust");
      const enableEpoch = expectedEpoch + 1; counter(enableEpoch, 1);
      const protectedDigest = controlSeal(this.tenantId, projectId, enabled, enableEpoch, actor.id, authority.revision);
      const changed = rows(await transaction.execute(sql`INSERT INTO factory_release_controls (tenant_id,project_id,enabled,enable_epoch,changed_by,grant_revision,protected_digest) VALUES (${this.tenantId},${projectId},${enabled},${enableEpoch},${actor.id},${authority.revision},${protectedDigest}) ON CONFLICT (tenant_id,project_id) DO UPDATE SET enabled=EXCLUDED.enabled,enable_epoch=EXCLUDED.enable_epoch,changed_by=EXCLUDED.changed_by,grant_revision=EXCLUDED.grant_revision,protected_digest=EXCLUDED.protected_digest,updated_at=NOW() WHERE factory_release_controls.enable_epoch=${expectedEpoch} AND factory_release_controls.enabled<>${enabled} RETURNING enable_epoch`));
      if (changed.length !== 1) throw new FactoryReleaseAuthorityError("factory_release_control_conflict");
      await insertTransactionalAuditEntry(transaction, `factory-release-control:${this.tenantId}:${projectId}:${enableEpoch}`, actor.id, enabled ? "factory.release.enabled" : "factory.release.disabled", projectId, { tenantId: this.tenantId, projectId, enableEpoch, grantRevision: authority.revision });
      return { projectId, enabled, enableEpoch };
    });
  }

  /** Called only by the authenticated runner completion path, in its existing product transaction. */
  async completeCurrentCandidateInTransaction(transaction: MigrationDb, commit: FactoryCurrentCandidateCommit): Promise<{ candidateGeneration: number; candidateDigest: string; pointerRevision: number }> {
    const { deadlineAt, ...rawAuthority } = commit.authority;
    const snapshot = JSON.parse(canonicalJson({ authority: { ...rawAuthority, deadlineAtMs: deadlineAt.getTime() }, result: commit.result, expectedCurrentGeneration: commit.expectedCurrentGeneration })) as CandidateCommitSnapshot;
    const authority: FactoryAttemptAuthority = { ...snapshot.authority, deadlineAt: new Date(snapshot.authority.deadlineAtMs) };
    if (authority.tenantId !== this.tenantId) throw new FactoryReleaseAuthorityError("factory_release_authority_scope");
    if (snapshot.expectedCurrentGeneration !== null) counter(snapshot.expectedCurrentGeneration, 0);
    const fence = await this.lifecycle.authorizeRunInTransaction(transaction, { projectId: authority.projectId, runId: authority.runId });
    this.assertFence(authority, fence);
    const terminal = await this.journal.recordCompletedTerminalInTransaction(transaction, authority, snapshot.result, this.artifacts);
    const trust = await this.requireTrust(transaction, authority.projectId, "update", true);
    const requestRow = rows<{ request_json: unknown }>(await transaction.execute(sql`SELECT request_json FROM factory_executions WHERE attempt_id=${authority.attemptId} FOR SHARE`))[0];
    const request = this.parseStored(requestRow?.request_json) as Pick<FactoryRunnerRequest, "runner">;
    if (!request?.runner || canonicalJson(request.runner) !== canonicalJson(trust.packageLock)) throw new FactoryReleaseAuthorityError("factory_release_package_untrusted");
    const proofDigest = candidateSeal(terminal, trust);
    await transaction.execute(sql`INSERT INTO factory_release_candidate_history (tenant_id,project_id,run_id,node_instance_id,candidate_generation,candidate_digest,attempt_id,execution_epoch,cancellation_epoch,terminal_fact_digest,output_artifact_id,output_bytes,trust_revision,package_trust_digest,validator_trust_digest,proof_digest) VALUES (${this.tenantId},${authority.projectId},${authority.runId},${authority.nodeInstanceId},${authority.candidateGeneration},${terminal.candidateDigest},${authority.attemptId},${authority.executionEpoch},${authority.cancellationEpoch},${terminal.terminalFactDigest},${terminal.outputArtifactId},${terminal.outputBytes},${trust.revision},${trust.packageTrustDigest},${trust.validatorTrustDigest},${proofDigest}) ON CONFLICT DO NOTHING`);
    const existing = rows<CandidateRow>(await transaction.execute(sql`SELECT h.candidate_generation,h.candidate_digest,h.attempt_id,c.pointer_revision,h.execution_epoch,h.cancellation_epoch,h.terminal_fact_digest,h.output_artifact_id,h.output_bytes,h.trust_revision,h.package_trust_digest,h.validator_trust_digest,h.proof_digest FROM factory_release_candidate_history h LEFT JOIN factory_release_current_candidates c ON c.tenant_id=h.tenant_id AND c.project_id=h.project_id AND c.run_id=h.run_id AND c.node_instance_id=h.node_instance_id AND c.candidate_generation=h.candidate_generation WHERE h.tenant_id=${this.tenantId} AND h.project_id=${authority.projectId} AND h.run_id=${authority.runId} AND h.node_instance_id=${authority.nodeInstanceId} AND h.candidate_generation=${authority.candidateGeneration} FOR SHARE OF h`))[0];
    if (!existing || existing.attempt_id !== authority.attemptId || existing.candidate_digest !== terminal.candidateDigest || existing.proof_digest !== proofDigest) throw new FactoryReleaseAuthorityError("factory_release_candidate_conflict");
    if (existing.pointer_revision) return { candidateGeneration: Number(existing.candidate_generation), candidateDigest: existing.candidate_digest, pointerRevision: Number(existing.pointer_revision) };
    const current = rows<{ candidate_generation: number | string; pointer_revision: number | string }>(await transaction.execute(sql`SELECT candidate_generation,pointer_revision FROM factory_release_current_candidates WHERE tenant_id=${this.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} FOR UPDATE`))[0];
    if ((current ? Number(current.candidate_generation) : null) !== snapshot.expectedCurrentGeneration || current && authority.candidateGeneration <= Number(current.candidate_generation)) throw new FactoryReleaseAuthorityError("factory_release_candidate_cas");
    const pointerRevision = Number(current?.pointer_revision ?? 0) + 1; counter(pointerRevision, 1);
    const changed = current
      ? rows(await transaction.execute(sql`UPDATE factory_release_current_candidates SET candidate_generation=${authority.candidateGeneration},candidate_digest=${terminal.candidateDigest},attempt_id=${authority.attemptId},pointer_revision=${pointerRevision},updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${snapshot.expectedCurrentGeneration} RETURNING candidate_generation`))
      : rows(await transaction.execute(sql`INSERT INTO factory_release_current_candidates (tenant_id,project_id,run_id,node_instance_id,candidate_generation,candidate_digest,attempt_id,pointer_revision) VALUES (${this.tenantId},${authority.projectId},${authority.runId},${authority.nodeInstanceId},${authority.candidateGeneration},${terminal.candidateDigest},${authority.attemptId},${pointerRevision}) ON CONFLICT DO NOTHING RETURNING candidate_generation`));
    if (changed.length !== 1) throw new FactoryReleaseAuthorityError("factory_release_candidate_cas");
    await insertTransactionalAuditEntry(transaction, `factory-release-candidate:${authority.attemptId}`, null, "factory.release.candidate.current", authority.runId, { tenantId: this.tenantId, projectId: authority.projectId, runId: authority.runId, nodeInstanceId: authority.nodeInstanceId, candidateGeneration: authority.candidateGeneration, candidateDigest: terminal.candidateDigest, attemptId: authority.attemptId, pointerRevision, proofDigest });
    return { candidateGeneration: authority.candidateGeneration, candidateDigest: terminal.candidateDigest, pointerRevision };
  }

  async lockCurrentInTransaction(transaction: MigrationDb, tenantId: string, projectId: string, runId: string, nodeInstanceId: string): Promise<FactoryReleaseAuthority> {
    if (tenantId !== this.tenantId) throw new FactoryReleaseAuthorityError("factory_release_authority_scope");
    assertFactoryIdentity(projectId, runId, nodeInstanceId);
    const fence = await this.lifecycle.authorizeRunInTransaction(transaction, { projectId, runId });
    const control = await this.requireControl(transaction, projectId);
    const trust = await this.requireTrust(transaction, projectId, "share", true);
    const candidate = rows<CandidateRow>(await transaction.execute(sql`SELECT c.candidate_generation,c.candidate_digest,c.attempt_id,c.pointer_revision,h.execution_epoch,h.cancellation_epoch,h.terminal_fact_digest,h.output_artifact_id,h.output_bytes,h.trust_revision,h.package_trust_digest,h.validator_trust_digest,h.proof_digest FROM factory_release_current_candidates c JOIN factory_release_candidate_history h ON h.tenant_id=c.tenant_id AND h.project_id=c.project_id AND h.run_id=c.run_id AND h.node_instance_id=c.node_instance_id AND h.candidate_generation=c.candidate_generation WHERE c.tenant_id=${this.tenantId} AND c.project_id=${projectId} AND c.run_id=${runId} AND c.node_instance_id=${nodeInstanceId} FOR SHARE`))[0];
    if (!candidate || Number(candidate.execution_epoch) !== fence.executionEpoch || Number(candidate.cancellation_epoch) !== fence.cancellationEpoch || Number(candidate.trust_revision) !== trust.revision || candidate.package_trust_digest !== trust.packageTrustDigest || candidate.validator_trust_digest !== trust.validatorTrustDigest) throw new FactoryReleaseAuthorityError("factory_release_authority_stale");
    await this.verifyCandidate(transaction, projectId, runId, nodeInstanceId, candidate, trust);
    return { runId, nodeInstanceId, candidateGeneration: Number(candidate.candidate_generation), candidateDigest: candidate.candidate_digest, executionEpoch: fence.executionEpoch, cancellationEpoch: fence.cancellationEpoch, releaseEnableEpoch: control.enableEpoch, deadlineMs: fence.deadlineAtMs, status: fence.status, packageTrustDigest: trust.packageTrustDigest, validatorTrustDigest: trust.validatorTrustDigest };
  }

  /** Validation needs current trusted material, but release enable is a later dispatch fence. */
  async lockValidationCandidateInTransaction(transaction: MigrationDb, tenantId: string, key: FactoryCandidateKey): Promise<FactoryValidationCandidate> {
    key = JSON.parse(canonicalJson(key)) as FactoryCandidateKey;
    if (tenantId !== this.tenantId) throw new FactoryReleaseAuthorityError("factory_release_authority_scope");
    assertFactoryIdentity(key.projectId, key.runId, key.nodeInstanceId);
    counter(key.candidateGeneration, 0);
    const fence = await this.lifecycle.authorizeRunInTransaction(transaction, { projectId: key.projectId, runId: key.runId });
    const trust = await this.requireTrust(transaction, key.projectId, "share", true);
    const candidate = rows<CandidateRow>(await transaction.execute(sql`SELECT c.candidate_generation,c.candidate_digest,c.attempt_id,c.pointer_revision,h.execution_epoch,h.cancellation_epoch,h.terminal_fact_digest,h.output_artifact_id,h.output_bytes,h.trust_revision,h.package_trust_digest,h.validator_trust_digest,h.proof_digest FROM factory_release_current_candidates c JOIN factory_release_candidate_history h ON h.tenant_id=c.tenant_id AND h.project_id=c.project_id AND h.run_id=c.run_id AND h.node_instance_id=c.node_instance_id AND h.candidate_generation=c.candidate_generation WHERE c.tenant_id=${this.tenantId} AND c.project_id=${key.projectId} AND c.run_id=${key.runId} AND c.node_instance_id=${key.nodeInstanceId} AND c.candidate_generation=${key.candidateGeneration} FOR SHARE`))[0];
    if (!candidate || Number(candidate.execution_epoch) !== fence.executionEpoch || Number(candidate.cancellation_epoch) !== fence.cancellationEpoch || Number(candidate.trust_revision) !== trust.revision || candidate.package_trust_digest !== trust.packageTrustDigest || candidate.validator_trust_digest !== trust.validatorTrustDigest) throw new FactoryReleaseAuthorityError("factory_release_authority_stale");
    await this.verifyCandidate(transaction, key.projectId, key.runId, key.nodeInstanceId, candidate, trust);
    return {
      ...key,
      candidateDigest: candidate.candidate_digest,
      artifact: { artifactId: candidate.output_artifact_id, digest: candidate.candidate_digest, encodedBytes: Number(candidate.output_bytes) },
      definitionDigest: fence.definitionDigest,
      executionEpoch: fence.executionEpoch,
      cancellationEpoch: fence.cancellationEpoch,
      deadlineMs: fence.deadlineAtMs,
      trustRevision: trust.revision,
      issuerGrantRevision: trust.approvalGrantRevision,
      validatorLockDigest: trust.validatorTrustDigest,
    };
  }

  async readPinnedInTransaction(transaction: MigrationDb, tenantId: string, accepted: FactoryAcceptedRelease): Promise<FactoryReleaseMaterial> {
    if (tenantId !== this.tenantId) throw new FactoryReleaseAuthorityError("factory_release_authority_scope");
    const candidate = rows<CandidateRow>(await transaction.execute(sql`SELECT candidate_generation,candidate_digest,attempt_id,1 AS pointer_revision,execution_epoch,cancellation_epoch,terminal_fact_digest,output_artifact_id,output_bytes,trust_revision,package_trust_digest,validator_trust_digest,proof_digest FROM factory_release_candidate_history WHERE tenant_id=${this.tenantId} AND project_id=${accepted.projectId} AND run_id=${accepted.runId} AND node_instance_id=${accepted.nodeInstanceId} AND candidate_generation=${accepted.candidateGeneration} FOR SHARE`))[0];
    const decision = rows<{ validator_lock_digest: string; evidence_set_digest: string }>(await transaction.execute(sql`SELECT c.validator_lock_digest,d.evidence_set_digest FROM factory_acceptance_decisions d JOIN factory_acceptance_contracts c ON c.tenant_id=d.tenant_id AND c.project_id=d.project_id AND c.contract_id=d.contract_id AND c.revision=d.contract_revision WHERE d.tenant_id=${this.tenantId} AND d.project_id=${accepted.projectId} AND d.decision_id=${accepted.decisionId} AND d.run_id=${accepted.runId} AND d.node_instance_id=${accepted.nodeInstanceId} AND d.candidate_generation=${accepted.candidateGeneration} AND d.candidate_digest=${accepted.candidateDigest} AND d.contract_digest=${accepted.contractDigest} FOR SHARE`))[0];
    const evidence = rows<{ evidence_id: string; validator_id: string; candidate_digest: string; validator_lock_digest: string; evidence_digest: string; artifact_id: string; artifact_digest: string; artifact_bytes: number | string }>(await transaction.execute(sql`SELECT evidence_id,validator_id,candidate_digest,validator_lock_digest,evidence_digest,artifact_id,artifact_digest,artifact_bytes FROM factory_acceptance_evidence WHERE tenant_id=${this.tenantId} AND project_id=${accepted.projectId} AND run_id=${accepted.runId} AND node_instance_id=${accepted.nodeInstanceId} AND candidate_generation=${accepted.candidateGeneration} ORDER BY validator_id FOR SHARE`));
    if (!candidate || !decision || !evidence.length || candidate.candidate_digest !== accepted.candidateDigest || Number(candidate.execution_epoch) !== accepted.executionEpoch || Number(candidate.cancellation_epoch) !== accepted.cancellationEpoch || decision.validator_lock_digest !== candidate.validator_trust_digest || decision.evidence_set_digest !== hash(evidence.map(item => item.evidence_digest).sort()) || evidence.some(item => item.candidate_digest !== accepted.candidateDigest || item.validator_lock_digest !== decision.validator_lock_digest)) throw new FactoryReleaseAuthorityError("factory_release_material_stale");
    const trust = await this.requireTrust(transaction, accepted.projectId, "share", true);
    if (trust.revision !== Number(candidate.trust_revision) || trust.packageTrustDigest !== candidate.package_trust_digest || trust.validatorTrustDigest !== candidate.validator_trust_digest) throw new FactoryReleaseAuthorityError("factory_release_material_stale");
    await this.verifyCandidate(transaction, accepted.projectId, accepted.runId, accepted.nodeInstanceId, candidate, trust);
    return { decisionId: accepted.decisionId, packageTrustDigest: candidate.package_trust_digest, validatorTrustDigest: candidate.validator_trust_digest, evidence: evidence.map(item => ({ evidenceId: item.evidence_id, validatorId: item.validator_id, evidenceDigest: item.evidence_digest, artifact: { artifactId: item.artifact_id, digest: item.artifact_digest, encodedBytes: Number(item.artifact_bytes) } })) };
  }

  private assertFence(authority: FactoryAttemptAuthority, fence: FactoryRunFence): void {
    if (fence.tenantId !== this.tenantId || fence.projectId !== authority.projectId || fence.runId !== authority.runId || fence.executionEpoch !== authority.executionEpoch || fence.cancellationEpoch !== authority.cancellationEpoch || fence.deadlineAtMs < authority.deadlineAt.getTime() || !["queued", "running", "waiting"].includes(fence.status)) throw new FactoryReleaseAuthorityError("factory_release_authority_stale");
  }

  private parseStored(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { throw new FactoryReleaseAuthorityError("factory_release_authority_corrupt"); } }

  private async currentTrustRow(transaction: MigrationDb, projectId: string, lock: "share" | "update"): Promise<TrustRow | undefined> {
    const clause = lock === "update" ? sql`FOR UPDATE` : sql`FOR SHARE`;
    return rows<TrustRow>(await transaction.execute(sql`SELECT r.revision,r.state,r.package_lock_json,r.package_trust_digest,r.validator_trust_digest,r.approved_by,r.approval_grant_revision,r.protected_digest FROM factory_release_trust_current c JOIN factory_release_trust_revisions r ON r.tenant_id=c.tenant_id AND r.project_id=c.project_id AND r.revision=c.revision WHERE c.tenant_id=${this.tenantId} AND c.project_id=${projectId} ${clause}`))[0];
  }

  private async requireTrust(transaction: MigrationDb, projectId: string, lock: "share" | "update", active: boolean): Promise<FactoryReleaseTrustRecord> {
    const row = await this.currentTrustRow(transaction, projectId, lock);
    if (!row) throw new FactoryReleaseAuthorityError("factory_release_trust_missing");
    const trust = this.trustRecord(row, projectId);
    if (active && trust.state !== "active") throw new FactoryReleaseAuthorityError("factory_release_trust_inactive");
    if (active) await this.grants.authorizeInTransaction(transaction, { kind: "user", id: trust.approvedBy, authentication: "session" }, projectId, "factory.trust", trust.approvalGrantRevision);
    return trust;
  }

  private trustRecord(row: TrustRow, projectId: string): FactoryReleaseTrustRecord {
    let packageLock: RunnerReference;
    try { packageLock = validatePackageLock(JSON.parse(row.package_lock_json) as RunnerReference); } catch { throw new FactoryReleaseAuthorityError("factory_release_trust_corrupt"); }
    const revision = Number(row.revision), approvalGrantRevision = Number(row.approval_grant_revision);
    counter(revision, 1); counter(approvalGrantRevision, 1); sha(row.package_trust_digest); sha(row.validator_trust_digest); sha(row.protected_digest);
    if (row.package_trust_digest !== hash(packageLock) || row.protected_digest !== trustSeal(this.tenantId, projectId, revision, row.state, packageLock, row.package_trust_digest, row.validator_trust_digest, row.approved_by, approvalGrantRevision)) throw new FactoryReleaseAuthorityError("factory_release_trust_corrupt");
    return { projectId, revision, state: row.state, packageLock, packageTrustDigest: row.package_trust_digest, validatorTrustDigest: row.validator_trust_digest, approvedBy: row.approved_by, approvalGrantRevision };
  }

  private async requireControl(transaction: MigrationDb, projectId: string): Promise<FactoryReleaseControl> {
    const row = await this.currentControlRow(transaction, projectId, "share");
    if (!row?.enabled) throw new FactoryReleaseAuthorityError("factory_release_disabled");
    const epoch = Number(row.enable_epoch), grantRevision = Number(row.grant_revision);
    await this.grants.authorizeInTransaction(transaction, { kind: "user", id: row.changed_by, authentication: "session" }, projectId, "factory.trust", grantRevision);
    return { projectId, enabled: true, enableEpoch: epoch };
  }

  private async currentControlRow(transaction: MigrationDb, projectId: string, lock: "share" | "update"): Promise<ControlRow | undefined> {
    const clause = lock === "update" ? sql`FOR UPDATE` : sql`FOR SHARE`;
    const row = rows<ControlRow>(await transaction.execute(sql`SELECT enabled,enable_epoch,changed_by,grant_revision,protected_digest FROM factory_release_controls WHERE tenant_id=${this.tenantId} AND project_id=${projectId} ${clause}`))[0];
    if (!row) return undefined;
    const epoch = Number(row.enable_epoch), grantRevision = Number(row.grant_revision);
    if (!Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(grantRevision) || grantRevision < 1 || row.protected_digest !== controlSeal(this.tenantId, projectId, row.enabled, epoch, row.changed_by, grantRevision)) throw new FactoryReleaseAuthorityError("factory_release_control_corrupt");
    return row;
  }

  private async verifyCandidate(transaction: MigrationDb, projectId: string, runId: string, nodeInstanceId: string, candidate: CandidateRow, trust: FactoryReleaseTrustRecord): Promise<void> {
    const terminal = rows<{ request_digest: string; result_digest: string; terminal_result_digest: string; output_artifact_id: string; output_digest: string; output_bytes: number | string; terminal_fact_digest: string; execution_epoch: number | string; cancellation_epoch: number | string }>(await transaction.execute(sql`SELECT request_digest,result_digest,terminal_result_digest,output_artifact_id,output_digest,output_bytes,terminal_fact_digest,execution_epoch,cancellation_epoch FROM factory_execution_terminals WHERE attempt_id=${candidate.attempt_id} AND tenant_id=${this.tenantId} AND project_id=${projectId} AND run_id=${runId} AND node_instance_id=${nodeInstanceId} AND candidate_generation=${candidate.candidate_generation} FOR SHARE`))[0];
    if (!terminal || terminal.output_digest !== candidate.candidate_digest || terminal.output_artifact_id !== candidate.output_artifact_id || Number(terminal.output_bytes) !== Number(candidate.output_bytes) || terminal.terminal_fact_digest !== candidate.terminal_fact_digest) throw new FactoryReleaseAuthorityError("factory_release_candidate_corrupt");
    const terminalFact: FactoryExecutionTerminalFact = { attemptId: candidate.attempt_id, tenantId: this.tenantId, projectId, runId, nodeInstanceId, candidateGeneration: Number(candidate.candidate_generation), candidateDigest: terminal.output_digest, requestDigest: terminal.request_digest, resultDigest: terminal.result_digest, terminalResultDigest: terminal.terminal_result_digest, outputArtifactId: candidate.output_artifact_id, outputBytes: Number(candidate.output_bytes), executionEpoch: Number(terminal.execution_epoch), cancellationEpoch: Number(terminal.cancellation_epoch), terminalFactDigest: terminal.terminal_fact_digest };
    if (candidate.proof_digest !== candidateSeal(terminalFact, trust)) throw new FactoryReleaseAuthorityError("factory_release_candidate_corrupt");
  }
}
