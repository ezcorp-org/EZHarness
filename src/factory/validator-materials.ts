import type {
  CompiledFactory,
  FactoryArtifactReference,
  FactoryModelPin,
  FactoryRunnerRequestIdentity,
  FactoryRunnerResult,
  ResourceBounds,
  RunnerReference,
} from "@ezcorp/factory-sdk";
import { compileFactory, factoryRunnerRequestIdentity } from "@ezcorp/factory-sdk/compiler";
import { validateCompiledFactory } from "@ezcorp/factory-sdk/validation";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import type {
  FactoryCandidateKey,
  FactoryClaimGroup,
  FactoryContractRevision,
  FactoryCurrentCandidateResolver,
  FactoryMandatoryClaim,
  FactoryTrustedEvidence,
  FactoryTrustedValidatorGateway,
} from "./assurance";
import type { FactoryArtifacts } from "./artifacts";
import type { FactoryAttemptAuthority, FactoryDurableRunnerRequest, FactoryExecutionTerminalFact } from "./executions";
import type { FactoryReleaseAuthorityStore, FactoryValidationCandidate } from "./release-authority";
import { assertFactoryIdentity, type FactoryRunKey } from "./records";
import type { FactoryRunFence } from "./run-lifecycle";

const MAX_EVIDENCE_AGE_MS = 86_400_000;
const MAX_VALIDATOR_RESULT_BYTES = 1024 * 1024;

export interface FactoryTrustedValidatorRuntime {
  readonly runner: RunnerReference;
  readonly resources: ResourceBounds;
  readonly model?: FactoryModelPin;
  readonly brokerAudience: string;
  readonly environmentDigest: string;
  readonly configurationDigest: string;
  readonly maxEvidenceAgeMs: number;
}

export interface FactoryValidatorRunLifecycle {
  readonly tenantId: string;
  readExecutionPlanInTransaction(transaction: MigrationDb, key: FactoryRunKey): Promise<{ readonly fence: FactoryRunFence; readonly compiled: CompiledFactory }>;
}

export interface FactoryValidatorTerminalReader {
  readonly database: TransactionalDb;
  requestInTransaction(transaction: MigrationDb, authority: FactoryAttemptAuthority): Promise<FactoryDurableRunnerRequest>;
  readCompletedTerminalInTransaction(transaction: MigrationDb, authority: FactoryAttemptAuthority, artifacts: FactoryArtifacts): Promise<{ readonly terminal: FactoryExecutionTerminalFact; readonly result: Extract<FactoryRunnerResult, { status: "completed" }>; readonly createdAtMs: number }>;
}

export interface FactoryValidatorMaterial {
  readonly projectId: string;
  readonly factoryId: string;
  readonly factoryVersion: string;
  readonly definitionDigest: string;
  readonly contractId: string;
  readonly contractVersion: string;
  readonly contractDigest: string;
  readonly validatorLockDigest: string;
  readonly mandatoryClaims: readonly FactoryMandatoryClaim[];
  readonly claimGroups: readonly FactoryClaimGroup[];
}

export interface FactoryValidatorAssignmentRequest {
  readonly candidate: FactoryCandidateKey;
  readonly validatorId: string;
  readonly authority: FactoryAttemptAuthority;
}

interface ValidatorManifestEntry {
  readonly validatorId: string;
  readonly runner: RunnerReference;
  readonly runnerDigest: string;
  readonly resources: ResourceBounds;
  readonly model?: FactoryModelPin;
  readonly brokerAudience: string;
  readonly environmentDigest: string;
  readonly configurationDigest: string;
  readonly freshnessMs: number;
  readonly maxEvidenceAgeMs: number;
}

interface MaterialSnapshot extends FactoryValidatorMaterial {
  readonly validators: readonly ValidatorManifestEntry[];
  readonly materialDigest: string;
}

type MaterialRow = {
  factory_id: string; factory_version: string; definition_digest: string; contract_id: string; contract_version: string; contract_digest: string; validator_lock_digest: string;
  mandatory_claims: string; claim_groups: string; validators_json: string; material_digest: string;
};
type AssignmentRow = {
  project_id: string; run_id: string; candidate_node_instance_id: string; candidate_generation: number | string; validator_id: string; validator_attempt_id: string; validator_authority_json: string;
  definition_digest: string; validator_lock_digest: string; candidate_digest: string; candidate_artifact_id: string; candidate_artifact_digest: string; candidate_artifact_bytes: number | string;
  runner_json: string; runner_digest: string; environment_digest: string; configuration_digest: string; freshness_ms: number | string; trust_revision: number | string; issuer_grant_revision: number | string; assignment_digest: string;
};
type ResultRow = { terminal_fact_digest: string; artifact_id: string; artifact_digest: string; artifact_bytes: number | string; claims_json: string; issued_at_ms: number | string; expires_at_ms: number | string; evidence_digest: string; result_digest: string };

export class FactoryTrustedValidatorError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryTrustedValidatorError"; }
}

const hash = (value: unknown): string => `sha256:${digestObject(value)}`;
const snapshot = <Value>(value: Value): Value => JSON.parse(canonicalJson(value)) as Value;
function digest(value: string): void { if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new FactoryTrustedValidatorError("factory_validator_invalid"); }
function text(...values: readonly string[]): void { if (values.some(value => typeof value !== "string" || value.length < 1 || value.length > 512 || value.includes("\0"))) throw new FactoryTrustedValidatorError("factory_validator_invalid"); }
function counter(value: number, minimum = 0): void { if (!Number.isSafeInteger(value) || value < minimum) throw new FactoryTrustedValidatorError("factory_validator_invalid"); }
function parse<Value>(value: unknown, code = "factory_validator_corrupt"): Value { try { return (typeof value === "string" ? JSON.parse(value) : value) as Value; } catch { throw new FactoryTrustedValidatorError(code); } }
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

function authoritySnapshot(authority: FactoryAttemptAuthority): Omit<FactoryAttemptAuthority, "deadlineAt"> & { readonly deadlineAtMs: number } {
  const { deadlineAt, ...wire } = authority;
  const copy = snapshot({ ...wire, deadlineAtMs: deadlineAt instanceof Date ? deadlineAt.getTime() : Number.NaN });
  text(copy.attemptId, copy.tenantId, copy.projectId, copy.runId, copy.nodeInstanceId, copy.requestDigest);
  digest(`sha256:${copy.requestDigest}`);
  [copy.candidateGeneration, copy.attemptNumber, copy.grantRevision, copy.reservationGeneration, copy.executionEpoch, copy.cancellationEpoch].forEach(value => { counter(value); });
  counter(copy.deadlineAtMs, 1);
  return copy;
}

function authorityFromStored(value: unknown): FactoryAttemptAuthority {
  const stored = parse<ReturnType<typeof authoritySnapshot>>(value);
  const authority = { ...stored, deadlineAt: new Date(stored.deadlineAtMs) };
  authoritySnapshot(authority);
  return authority;
}
function validateRuntime(value: FactoryTrustedValidatorRuntime): FactoryTrustedValidatorRuntime {
  const runtime = snapshot(value);
  text(runtime.runner.package, runtime.runner.version, runtime.runner.export, runtime.brokerAudience);
  [runtime.runner.digest, runtime.environmentDigest, runtime.configurationDigest].forEach(digest);
  if (runtime.runner.configurationDigest !== runtime.configurationDigest) throw new FactoryTrustedValidatorError("factory_validator_runtime_invalid");
  counter(runtime.maxEvidenceAgeMs, 1);
  if (runtime.maxEvidenceAgeMs > MAX_EVIDENCE_AGE_MS) throw new FactoryTrustedValidatorError("factory_validator_runtime_invalid");
  const probe = factoryRunnerRequestIdentity({
    schemaVersion: "factory.runner.request.v1",
    authority: { attemptId: "validator-profile", tenantId: "validator-profile", projectId: "validator-profile", runId: "validator-profile", nodeInstanceId: "validator-profile", candidateGeneration: 0, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, deadlineAtMs: 1, nextOperationIndex: 0 },
    runner: runtime.runner, input: { kind: "inline", value: null }, grants: [], resources: runtime.resources, ...(runtime.model ? { model: runtime.model } : {}), tools: [], broker: { attemptToken: "validator-profile-token", audience: runtime.brokerAudience },
  });
  void probe;
  return runtime;
}

function materialFields(material: Omit<MaterialSnapshot, "materialDigest">): object {
  return { schemaVersion: "factory.validator-material.v1", ...material };
}

function assignmentFields(row: Omit<AssignmentRow, "assignment_digest">): object {
  return {
    schemaVersion: "factory.validator-assignment.v1", projectId: row.project_id, runId: row.run_id, candidateNodeInstanceId: row.candidate_node_instance_id,
    candidateGeneration: Number(row.candidate_generation), validatorId: row.validator_id, validatorAttemptId: row.validator_attempt_id, validatorAuthority: parse(row.validator_authority_json),
    definitionDigest: row.definition_digest, validatorLockDigest: row.validator_lock_digest, candidateDigest: row.candidate_digest,
    candidateArtifact: { artifactId: row.candidate_artifact_id, digest: row.candidate_artifact_digest, encodedBytes: Number(row.candidate_artifact_bytes) },
    runner: parse(row.runner_json), runnerDigest: row.runner_digest, environmentDigest: row.environment_digest, configurationDigest: row.configuration_digest,
    freshnessMs: Number(row.freshness_ms), trustRevision: Number(row.trust_revision), issuerGrantRevision: Number(row.issuer_grant_revision),
  };
}

function strictClaims(content: Uint8Array, validatorId: string): readonly { id: string; passed: boolean; decisive: boolean }[] {
  if (content.byteLength < 1 || content.byteLength > MAX_VALIDATOR_RESULT_BYTES) throw new FactoryTrustedValidatorError("factory_validator_result_invalid");
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)); } catch { throw new FactoryTrustedValidatorError("factory_validator_result_invalid"); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || !Object.keys(decoded).every(key => ["schemaVersion", "claims"].includes(key))) throw new FactoryTrustedValidatorError("factory_validator_result_invalid");
  const value = decoded as { schemaVersion?: unknown; claims?: unknown };
  if (value.schemaVersion !== "factory.validator-result.v1" || !Array.isArray(value.claims) || value.claims.length !== 1) throw new FactoryTrustedValidatorError("factory_validator_result_invalid");
  const claim = value.claims[0];
  if (!claim || typeof claim !== "object" || Array.isArray(claim) || !Object.keys(claim).every(key => ["id", "passed", "decisive"].includes(key))) throw new FactoryTrustedValidatorError("factory_validator_result_invalid");
  const result = claim as { id?: unknown; passed?: unknown; decisive?: unknown };
  if (result.id !== validatorId || typeof result.passed !== "boolean" || typeof result.decisive !== "boolean") throw new FactoryTrustedValidatorError("factory_validator_result_invalid");
  return [{ id: result.id, passed: result.passed, decisive: result.decisive }];
}

/** Concrete C04 gateway. It records only compiled material and verified host facts. */
export class FactoryTrustedValidators implements FactoryTrustedValidatorGateway, FactoryCurrentCandidateResolver {
  private readonly runtimes = new Map<string, FactoryTrustedValidatorRuntime>();

  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly lifecycle: FactoryValidatorRunLifecycle,
    private readonly journal: FactoryValidatorTerminalReader,
    private readonly artifacts: FactoryArtifacts,
    private readonly releaseAuthority: FactoryReleaseAuthorityStore,
    runtimes: Iterable<FactoryTrustedValidatorRuntime>,
  ) {
    assertFactoryIdentity(tenantId);
    if (lifecycle.tenantId !== tenantId || journal.database !== database || artifacts.database !== database || releaseAuthority.tenantId !== tenantId) throw new FactoryTrustedValidatorError("factory_validator_scope");
    for (const runtimeValue of runtimes) {
      const runtime = validateRuntime(runtimeValue);
      const key = hash(runtime.runner);
      if (this.runtimes.has(key)) throw new FactoryTrustedValidatorError("factory_validator_runtime_invalid");
      this.runtimes.set(key, Object.freeze(runtime));
    }
  }

  async registerMaterialInTransaction(transaction: MigrationDb, projectId: string, source: CompiledFactory): Promise<FactoryValidatorMaterial> {
    assertFactoryIdentity(projectId);
    const compiled = snapshot(source);
    const structural = validateCompiledFactory(compiled);
    const rebuilt = compileFactory(compiled.definition);
    if (!structural.ok || !rebuilt.ok || !same(rebuilt.factory, compiled)) throw new FactoryTrustedValidatorError("factory_validator_material_invalid");
    const acceptance = compiled.definition.acceptance;
    const mandatory = acceptance.claims.filter(claim => claim.required);
    if (!mandatory.length || mandatory.some(claim => !claim.protected)) throw new FactoryTrustedValidatorError("factory_validator_material_unprotected");
    const mandatoryIds = new Set(mandatory.map(claim => claim.id));
    if ((acceptance.groups ?? []).some(group => group.claimIds.some(id => !mandatoryIds.has(id)))) throw new FactoryTrustedValidatorError("factory_validator_material_unprotected");
    const validators = mandatory.map(claim => {
      const runnerDigest = hash(claim.validator);
      const runtime = this.runtimes.get(runnerDigest);
      if (!runtime || !same(runtime.runner, claim.validator)) throw new FactoryTrustedValidatorError("factory_validator_runtime_untrusted");
      const freshnessMs = claim.freshnessMs ?? runtime.maxEvidenceAgeMs;
      counter(freshnessMs, 1);
      if (freshnessMs > MAX_EVIDENCE_AGE_MS) throw new FactoryTrustedValidatorError("factory_validator_material_invalid");
      return { validatorId: claim.id, runner: runtime.runner, runnerDigest, resources: runtime.resources, ...(runtime.model ? { model: runtime.model } : {}), brokerAudience: runtime.brokerAudience, environmentDigest: runtime.environmentDigest, configurationDigest: runtime.configurationDigest, freshnessMs, maxEvidenceAgeMs: runtime.maxEvidenceAgeMs };
    });
    const mandatoryClaims = mandatory.map((claim, index) => ({ id: claim.id, validatorId: claim.id, freshnessMs: validators[index]!.freshnessMs }));
    const claimGroups = (acceptance.groups ?? []).map(group => ({ ...group, claimIds: [...group.claimIds] }));
    const published = rows<{ definition_digest: string; compiled_bytes: number | string; lock_json: string }>(await transaction.execute(sql`SELECT definition_digest,compiled_bytes,lock_json FROM factory_versions WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND factory_id=${compiled.definition.id} AND version=${compiled.definition.version} FOR SHARE`))[0];
    const compiledBytes = new TextEncoder().encode(canonicalJson(compiled)).byteLength;
    if (!published || published.definition_digest !== compiled.digest || Number(published.compiled_bytes) !== compiledBytes || published.lock_json !== canonicalJson(compiled.lock)) throw new FactoryTrustedValidatorError("factory_validator_material_unpublished");
    const contractDigest = hash(acceptance);
    const lock = { schemaVersion: "factory.validator-lock.v1", projectId, definitionDigest: compiled.digest, contractDigest, validators };
    const materialBase = { projectId, factoryId: compiled.definition.id, factoryVersion: compiled.definition.version, definitionDigest: compiled.digest, contractId: acceptance.id, contractVersion: acceptance.version, contractDigest, validatorLockDigest: hash(lock), mandatoryClaims, claimGroups, validators };
    const material: MaterialSnapshot = { ...materialBase, materialDigest: hash(materialFields(materialBase)) };
    await transaction.execute(sql`INSERT INTO factory_validator_materials (tenant_id,project_id,factory_id,factory_version,definition_digest,contract_id,contract_version,contract_digest,validator_lock_digest,mandatory_claims,claim_groups,validators_json,material_digest) VALUES (${this.tenantId},${projectId},${material.factoryId},${material.factoryVersion},${material.definitionDigest},${material.contractId},${material.contractVersion},${material.contractDigest},${material.validatorLockDigest},${canonicalJson(material.mandatoryClaims)},${canonicalJson(material.claimGroups)},${canonicalJson(material.validators)},${material.materialDigest}) ON CONFLICT DO NOTHING`);
    const stored = await this.materialForVersion(transaction, projectId, material.factoryId, material.factoryVersion);
    if (!same(stored, material)) throw new FactoryTrustedValidatorError("factory_validator_material_conflict");
    return this.publicMaterial(stored);
  }

  async assertContractInTransaction(transaction: MigrationDb, tenantId: string, contract: FactoryContractRevision): Promise<void> {
    contract = snapshot(contract);
    if (tenantId !== this.tenantId) throw new FactoryTrustedValidatorError("factory_validator_scope");
    const stored = await this.materialForLock(transaction, contract.projectId, contract.validatorLockDigest);
    this.assertConfiguredMaterial(stored);
    if (stored.contractId !== contract.contractId || stored.contractDigest !== contract.contractDigest || !same(stored.mandatoryClaims, contract.mandatoryClaims) || !same(stored.claimGroups, contract.claimGroups)) throw new FactoryTrustedValidatorError("factory_validator_contract_untrusted");
  }

  async bindAttemptInTransaction(transaction: MigrationDb, request: FactoryValidatorAssignmentRequest): Promise<void> {
    const authorityStored = authoritySnapshot(request.authority);
    request = { candidate: snapshot(request.candidate), validatorId: request.validatorId, authority: authorityFromStored(authorityStored) };
    text(request.validatorId);
    const plan = await this.lifecycle.readExecutionPlanInTransaction(transaction, request.candidate);
    const candidate = await this.releaseAuthority.lockValidationCandidateInTransaction(transaction, this.tenantId, request.candidate);
    if (plan.compiled.digest !== candidate.definitionDigest || plan.fence.executionEpoch !== candidate.executionEpoch || plan.fence.cancellationEpoch !== candidate.cancellationEpoch) throw new FactoryTrustedValidatorError("factory_validator_candidate_stale");
    const material = await this.materialForVersion(transaction, request.candidate.projectId, plan.compiled.definition.id, plan.compiled.definition.version);
    this.assertConfiguredMaterial(material);
    const validator = material.validators.find(item => item.validatorId === request.validatorId);
    if (!validator || material.definitionDigest !== candidate.definitionDigest || material.validatorLockDigest !== candidate.validatorLockDigest) throw new FactoryTrustedValidatorError("factory_validator_material_stale");
    if (authorityStored.tenantId !== this.tenantId || authorityStored.projectId !== request.candidate.projectId || authorityStored.runId !== request.candidate.runId || authorityStored.executionEpoch !== candidate.executionEpoch || authorityStored.cancellationEpoch !== candidate.cancellationEpoch || authorityStored.deadlineAtMs > candidate.deadlineMs) throw new FactoryTrustedValidatorError("factory_validator_attempt_stale");
    const durable = await this.journal.requestInTransaction(transaction, request.authority);
    this.assertDurableRequest(durable, request.authority, candidate.artifact, validator);
    const raw: Omit<AssignmentRow, "assignment_digest"> = {
      project_id: request.candidate.projectId, run_id: request.candidate.runId, candidate_node_instance_id: request.candidate.nodeInstanceId, candidate_generation: request.candidate.candidateGeneration, validator_id: request.validatorId,
      validator_attempt_id: request.authority.attemptId, validator_authority_json: canonicalJson(authorityStored), definition_digest: candidate.definitionDigest, validator_lock_digest: candidate.validatorLockDigest,
      candidate_digest: candidate.candidateDigest, candidate_artifact_id: candidate.artifact.artifactId, candidate_artifact_digest: candidate.artifact.digest, candidate_artifact_bytes: candidate.artifact.encodedBytes,
      runner_json: canonicalJson(validator.runner), runner_digest: validator.runnerDigest, environment_digest: validator.environmentDigest, configuration_digest: validator.configurationDigest, freshness_ms: Math.min(validator.freshnessMs, validator.maxEvidenceAgeMs),
      trust_revision: candidate.trustRevision, issuer_grant_revision: candidate.issuerGrantRevision,
    };
    const assignmentDigest = hash(assignmentFields(raw));
    await transaction.execute(sql`INSERT INTO factory_validator_assignments (tenant_id,project_id,run_id,candidate_node_instance_id,candidate_generation,validator_id,validator_attempt_id,validator_authority_json,definition_digest,validator_lock_digest,candidate_digest,candidate_artifact_id,candidate_artifact_digest,candidate_artifact_bytes,runner_json,runner_digest,environment_digest,configuration_digest,freshness_ms,trust_revision,issuer_grant_revision,assignment_digest) VALUES (${this.tenantId},${raw.project_id},${raw.run_id},${raw.candidate_node_instance_id},${raw.candidate_generation},${raw.validator_id},${raw.validator_attempt_id},${raw.validator_authority_json},${raw.definition_digest},${raw.validator_lock_digest},${raw.candidate_digest},${raw.candidate_artifact_id},${raw.candidate_artifact_digest},${raw.candidate_artifact_bytes},${raw.runner_json},${raw.runner_digest},${raw.environment_digest},${raw.configuration_digest},${raw.freshness_ms},${raw.trust_revision},${raw.issuer_grant_revision},${assignmentDigest}) ON CONFLICT DO NOTHING`);
    const saved = await this.assignment(transaction, request.candidate, request.validatorId);
    if (saved.validator_attempt_id !== request.authority.attemptId || saved.assignment_digest !== assignmentDigest) throw new FactoryTrustedValidatorError("factory_validator_assignment_conflict");
  }

  async resolveValidatorInTransaction(transaction: MigrationDb, tenantId: string, key: FactoryCandidateKey, validatorId: string): Promise<FactoryTrustedEvidence> {
    if (tenantId !== this.tenantId) throw new FactoryTrustedValidatorError("factory_validator_scope");
    key = snapshot(key); text(validatorId);
    const candidate = await this.releaseAuthority.lockValidationCandidateInTransaction(transaction, tenantId, key);
    return this.resolveLocked(transaction, candidate, validatorId);
  }

  async resolveCurrentEvidenceInTransaction(transaction: MigrationDb, tenantId: string, key: FactoryCandidateKey, validatorIds: readonly string[]): Promise<readonly FactoryTrustedEvidence[]> {
    if (tenantId !== this.tenantId) throw new FactoryTrustedValidatorError("factory_validator_scope");
    key = snapshot(key); validatorIds = snapshot(validatorIds);
    if (validatorIds.length < 1 || validatorIds.length > 1000 || new Set(validatorIds).size !== validatorIds.length) throw new FactoryTrustedValidatorError("factory_validator_invalid");
    validatorIds.forEach(id => { text(id); });
    const candidate = await this.releaseAuthority.lockValidationCandidateInTransaction(transaction, tenantId, key);
    const evidence: FactoryTrustedEvidence[] = [];
    for (const validatorId of [...validatorIds].sort()) evidence.push(await this.resolveLocked(transaction, candidate, validatorId));
    return evidence;
  }

  private async resolveLocked(transaction: MigrationDb, candidate: FactoryValidationCandidate, validatorId: string): Promise<FactoryTrustedEvidence> {
    const assignment = await this.assignment(transaction, candidate, validatorId, true);
    this.assertAssignment(assignment, candidate);
    const authority = authorityFromStored(assignment.validator_authority_json);
    const { terminal, result, createdAtMs } = await this.journal.readCompletedTerminalInTransaction(transaction, authority, this.artifacts);
    counter(createdAtMs, 1);
    if (terminal.attemptId !== assignment.validator_attempt_id || terminal.tenantId !== this.tenantId || terminal.projectId !== candidate.projectId || terminal.runId !== candidate.runId || terminal.nodeInstanceId !== authority.nodeInstanceId || terminal.candidateGeneration !== authority.candidateGeneration) throw new FactoryTrustedValidatorError("factory_validator_terminal_untrusted");
    const loaded = await this.artifacts.loadInTransaction(transaction, { tenantId: this.tenantId, projectId: candidate.projectId, logicalRunId: candidate.runId }, { objectId: result.output.artifactId, digest: result.output.digest, encodedBytes: result.output.encodedBytes }, ["candidate_output"]);
    if (loaded.candidateNodeInstanceId !== authority.nodeInstanceId || loaded.candidateGeneration !== authority.candidateGeneration) throw new FactoryTrustedValidatorError("factory_validator_terminal_untrusted");
    const claims = strictClaims(loaded.content, validatorId);
    const prior = rows<ResultRow>(await transaction.execute(sql`SELECT terminal_fact_digest,artifact_id,artifact_digest,artifact_bytes,claims_json,issued_at_ms,expires_at_ms,evidence_digest,result_digest FROM factory_validator_results WHERE validator_attempt_id=${authority.attemptId} FOR SHARE`))[0];
    const timestamp = prior ? undefined : rows<{ issued_at_ms: number | string }>(await transaction.execute(sql`SELECT FLOOR(EXTRACT(EPOCH FROM transaction_timestamp()) * 1000) AS issued_at_ms`))[0];
    const issuedAtMs = Number(prior?.issued_at_ms ?? timestamp?.issued_at_ms);
    counter(issuedAtMs, 1);
    if (createdAtMs > issuedAtMs) throw new FactoryTrustedValidatorError("factory_validator_terminal_untrusted");
    const expiresAtMs = Math.min(issuedAtMs + Number(assignment.freshness_ms), authority.deadlineAt.getTime(), candidate.deadlineMs);
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= issuedAtMs) throw new FactoryTrustedValidatorError("factory_validator_result_stale");
    const evidence: FactoryTrustedEvidence = {
      projectId: candidate.projectId, runId: candidate.runId, nodeInstanceId: candidate.nodeInstanceId, candidateGeneration: candidate.candidateGeneration,
      validatorId, validatorLockDigest: assignment.validator_lock_digest, issuerGrantRevision: Number(assignment.issuer_grant_revision), candidateDigest: candidate.candidateDigest,
      artifact: result.output, environmentDigest: assignment.environment_digest, configurationDigest: assignment.configuration_digest, runnerDigest: assignment.runner_digest,
      claims, issuedAtMs, expiresAtMs,
    };
    const evidenceDigest = hash(evidence);
    const resultDigest = hash({ schemaVersion: "factory.validator-result-record.v1", assignmentDigest: assignment.assignment_digest, terminalFactDigest: terminal.terminalFactDigest, evidence });
    if (!prior) await transaction.execute(sql`INSERT INTO factory_validator_results (tenant_id,project_id,validator_attempt_id,terminal_fact_digest,artifact_id,artifact_digest,artifact_bytes,claims_json,issued_at_ms,expires_at_ms,evidence_digest,result_digest) VALUES (${this.tenantId},${candidate.projectId},${authority.attemptId},${terminal.terminalFactDigest},${result.output.artifactId},${result.output.digest},${result.output.encodedBytes},${canonicalJson(claims)},${issuedAtMs},${expiresAtMs},${evidenceDigest},${resultDigest})`);
    const saved = prior ?? rows<ResultRow>(await transaction.execute(sql`SELECT terminal_fact_digest,artifact_id,artifact_digest,artifact_bytes,claims_json,issued_at_ms,expires_at_ms,evidence_digest,result_digest FROM factory_validator_results WHERE validator_attempt_id=${authority.attemptId} FOR SHARE`))[0];
    if (!saved || saved.terminal_fact_digest !== terminal.terminalFactDigest || saved.artifact_id !== result.output.artifactId || saved.artifact_digest !== result.output.digest || Number(saved.artifact_bytes) !== result.output.encodedBytes || saved.evidence_digest !== evidenceDigest || saved.result_digest !== resultDigest || saved.claims_json !== canonicalJson(claims) || Number(saved.issued_at_ms) !== issuedAtMs || Number(saved.expires_at_ms) !== expiresAtMs) throw new FactoryTrustedValidatorError("factory_validator_result_conflict");
    return evidence;
  }

  private assertDurableRequest(request: FactoryRunnerRequestIdentity, authority: FactoryAttemptAuthority, candidateArtifact: FactoryArtifactReference, validator: ValidatorManifestEntry): void {
    const expected = factoryRunnerRequestIdentity({
      schemaVersion: "factory.runner.request.v1", authority: request.authority, runner: validator.runner, input: { kind: "artifact", artifact: candidateArtifact }, grants: [], resources: validator.resources,
      ...(validator.model ? { model: validator.model } : {}), tools: [], broker: { attemptToken: "ignored", audience: validator.brokerAudience },
    });
    const wire = request.authority;
    const matchesAuthority = wire.attemptId === authority.attemptId && wire.tenantId === authority.tenantId && wire.projectId === authority.projectId && wire.runId === authority.runId && wire.nodeInstanceId === authority.nodeInstanceId && wire.candidateGeneration === authority.candidateGeneration && wire.attemptNumber === authority.attemptNumber && wire.grantRevision === authority.grantRevision && wire.reservationGeneration === authority.reservationGeneration && wire.executionEpoch === authority.executionEpoch && wire.cancellationEpoch === authority.cancellationEpoch && wire.deadlineAtMs === authority.deadlineAt.getTime();
    if (!same(request, expected) || !matchesAuthority || request.authority.nextOperationIndex !== 0 || request.checkpoint !== undefined) throw new FactoryTrustedValidatorError("factory_validator_attempt_untrusted");
  }

  private assertAssignment(row: AssignmentRow, candidate: FactoryValidationCandidate): void {
    try {
      const authority = authorityFromStored(row.validator_authority_json);
      const runner = parse<RunnerReference>(row.runner_json);
      const runtime = this.runtimes.get(row.runner_digest);
      [row.definition_digest, row.validator_lock_digest, row.candidate_digest, row.candidate_artifact_digest, row.runner_digest, row.environment_digest, row.configuration_digest, row.assignment_digest].forEach(digest);
      counter(Number(row.candidate_generation));
      [Number(row.candidate_artifact_bytes), Number(row.freshness_ms), Number(row.trust_revision), Number(row.issuer_grant_revision)].forEach(value => { counter(value, 1); });
      const { assignment_digest: _assignmentDigest, ...unsigned } = row;
      if (!runtime || !same(runtime.runner, runner) || runtime.environmentDigest !== row.environment_digest || runtime.configurationDigest !== row.configuration_digest || row.project_id !== candidate.projectId || row.run_id !== candidate.runId || row.candidate_node_instance_id !== candidate.nodeInstanceId || Number(row.candidate_generation) !== candidate.candidateGeneration || row.candidate_digest !== candidate.candidateDigest || row.candidate_artifact_id !== candidate.artifact.artifactId || row.candidate_artifact_digest !== candidate.artifact.digest || Number(row.candidate_artifact_bytes) !== candidate.artifact.encodedBytes || row.definition_digest !== candidate.definitionDigest || row.validator_lock_digest !== candidate.validatorLockDigest || Number(row.trust_revision) !== candidate.trustRevision || Number(row.issuer_grant_revision) !== candidate.issuerGrantRevision || row.runner_digest !== hash(runner) || authority.attemptId !== row.validator_attempt_id || row.assignment_digest !== hash(assignmentFields(unsigned))) throw new Error("mismatch");
    } catch { throw new FactoryTrustedValidatorError("factory_validator_assignment_corrupt"); }
  }

  private async assignment(transaction: MigrationDb, key: FactoryCandidateKey, validatorId: string, update = false): Promise<AssignmentRow> {
    const lock = update ? sql`FOR UPDATE` : sql`FOR SHARE`;
    const row = rows<AssignmentRow>(await transaction.execute(sql`SELECT project_id,run_id,candidate_node_instance_id,candidate_generation,validator_id,validator_attempt_id,validator_authority_json,definition_digest,validator_lock_digest,candidate_digest,candidate_artifact_id,candidate_artifact_digest,candidate_artifact_bytes,runner_json,runner_digest,environment_digest,configuration_digest,freshness_ms,trust_revision,issuer_grant_revision,assignment_digest FROM factory_validator_assignments WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND candidate_node_instance_id=${key.nodeInstanceId} AND candidate_generation=${key.candidateGeneration} AND validator_id=${validatorId} ${lock}`))[0];
    if (!row) throw new FactoryTrustedValidatorError("factory_validator_assignment_missing");
    return row;
  }

  private materialFromRow(projectId: string, row: MaterialRow): MaterialSnapshot {
    try {
      const base = { projectId, factoryId: row.factory_id, factoryVersion: row.factory_version, definitionDigest: row.definition_digest, contractId: row.contract_id, contractVersion: row.contract_version, contractDigest: row.contract_digest, validatorLockDigest: row.validator_lock_digest, mandatoryClaims: parse<FactoryMandatoryClaim[]>(row.mandatory_claims), claimGroups: parse<FactoryClaimGroup[]>(row.claim_groups), validators: parse<ValidatorManifestEntry[]>(row.validators_json) };
      [base.definitionDigest, base.contractDigest, base.validatorLockDigest, row.material_digest].forEach(digest);
      text(base.factoryId, base.factoryVersion, base.contractId, base.contractVersion);
      if (!base.validators.length || base.validators.some(item => item.validatorId.length < 1 || item.runnerDigest !== hash(item.runner) || validateRuntime({ runner: item.runner, resources: item.resources, ...(item.model ? { model: item.model } : {}), brokerAudience: item.brokerAudience, environmentDigest: item.environmentDigest, configurationDigest: item.configurationDigest, maxEvidenceAgeMs: item.maxEvidenceAgeMs }).maxEvidenceAgeMs !== item.maxEvidenceAgeMs) || row.material_digest !== hash(materialFields(base))) throw new Error("invalid");
      return { ...base, materialDigest: row.material_digest };
    } catch (error) { if (error instanceof FactoryTrustedValidatorError && error.code === "factory_validator_scope") throw error; throw new FactoryTrustedValidatorError("factory_validator_material_corrupt"); }
  }

  private async materialForVersion(transaction: MigrationDb, projectId: string, factoryId: string, factoryVersion: string): Promise<MaterialSnapshot> {
    const row = rows<MaterialRow>(await transaction.execute(sql`SELECT factory_id,factory_version,definition_digest,contract_id,contract_version,contract_digest,validator_lock_digest,mandatory_claims,claim_groups,validators_json,material_digest FROM factory_validator_materials WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND factory_id=${factoryId} AND factory_version=${factoryVersion} FOR SHARE`))[0];
    if (!row) throw new FactoryTrustedValidatorError("factory_validator_material_missing");
    return this.materialFromRow(projectId, row);
  }

  private async materialForLock(transaction: MigrationDb, projectId: string, validatorLockDigest: string): Promise<MaterialSnapshot> {
    const row = rows<MaterialRow>(await transaction.execute(sql`SELECT factory_id,factory_version,definition_digest,contract_id,contract_version,contract_digest,validator_lock_digest,mandatory_claims,claim_groups,validators_json,material_digest FROM factory_validator_materials WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND validator_lock_digest=${validatorLockDigest} FOR SHARE`))[0];
    if (!row) throw new FactoryTrustedValidatorError("factory_validator_material_missing");
    return this.materialFromRow(projectId, row);
  }

  private publicMaterial(material: MaterialSnapshot): FactoryValidatorMaterial {
    const { validators: _validators, materialDigest: _materialDigest, ...value } = material;
    return snapshot(value);
  }

  private assertConfiguredMaterial(material: MaterialSnapshot): void {
    if (material.validators.some(validator => {
      const runtime = this.runtimes.get(validator.runnerDigest);
      return !runtime || !same(runtime, { runner: validator.runner, resources: validator.resources, ...(validator.model ? { model: validator.model } : {}), brokerAudience: validator.brokerAudience, environmentDigest: validator.environmentDigest, configurationDigest: validator.configurationDigest, maxEvidenceAgeMs: validator.maxEvidenceAgeMs });
    })) throw new FactoryTrustedValidatorError("factory_validator_runtime_untrusted");
  }
}
