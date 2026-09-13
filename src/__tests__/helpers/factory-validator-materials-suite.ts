import { afterAll, beforeAll, expect, test } from "bun:test";
import { canonicalJson } from "@ezcorp/extension-contract";
import { compileFactory, factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import { referenceCodeV1, type CompiledFactory, type FactoryArtifactReference, type FactoryRunnerRequest, type FactoryRunnerResult, type RunnerReference } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { BlobStore } from "../../extensions/v4/types";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { digestObject } from "../../extensions/v4/blobs";
import { FactoryArtifacts, artifactJson } from "../../factory/artifacts";
import { FactoryAssurance, type FactoryContractRevision, type FactoryReleaseFenceReader } from "../../factory/assurance";
import { FactoryExecutionJournal, type FactoryAttemptAdmission, type FactoryAttemptAuthority } from "../../factory/executions";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { lockFactoryScope } from "../../factory/locks";
import { FactoryRecords } from "../../factory/records";
import { FactoryReleaseAuthorityStore, type FactoryReleaseRunLifecycle } from "../../factory/release-authority";
import type { FactoryRunFence } from "../../factory/run-lifecycle";
import { FactoryTrustedValidators, type FactoryTrustedValidatorRuntime, type FactoryValidatorRunLifecycle } from "../../factory/validator-materials";

interface Fixture { readonly db: TransactionalDb; readonly blobs: BlobStore; close(): Promise<void> }

export function factoryValidatorMaterialsConformance(createFixture: () => Promise<Fixture>): void {
  const tenantId = "validator-tenant", projectId = "validator-project", runId = "validator-run";
  const now = Date.now(), deadlineAtMs = now + 60_000;
  const admin: FactoryPrincipal = { kind: "user", id: "validator-admin", authentication: "session" };
  let fixture: Fixture, database: TransactionalDb, artifacts: FactoryArtifacts, grants: FactoryGrants, journal: FactoryExecutionJournal;
  let releases: FactoryReleaseAuthorityStore, validators: FactoryTrustedValidators, assurance: FactoryAssurance;
  let compiled: CompiledFactory;
  let runtime: FactoryTrustedValidatorRuntime, material: Awaited<ReturnType<FactoryTrustedValidators["registerMaterialInTransaction"]>>;
  let candidateAdmission: FactoryAttemptAdmission, validatorAdmission: FactoryAttemptAdmission;
  let candidateArtifact: FactoryArtifactReference;
  const cancellationEpoch = 0;

  const digest = (value: unknown) => `sha256:${digestObject(value)}`;
  const candidateRunner: RunnerReference = { package: "@ezcorp/candidate", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, export: "run", configurationDigest: `sha256:${"b".repeat(64)}` };

  class Lifecycle implements FactoryReleaseRunLifecycle, FactoryValidatorRunLifecycle {
    readonly tenantId = tenantId;
    async authorizeRunInTransaction(transaction: MigrationDb, key: { projectId: string; runId: string }): Promise<FactoryRunFence> {
      const scope = await lockFactoryScope(transaction, tenantId, key.projectId);
      const run = rows<{ definition_digest: string; execution_epoch: number | string }>(await transaction.execute(sql`SELECT definition_digest,execution_epoch FROM factory_runs WHERE tenant_id=${tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} FOR UPDATE`))[0];
      if (!scope || !run || key.runId !== runId) throw new Error("validator lifecycle scope denied");
      await grants.authorizeInTransaction(transaction, admin, projectId, "factory.run", 1);
      return { tenantId, projectId, runId, executionEpoch: Number(run.execution_epoch), cancellationEpoch, grantRevision: 1, revision: 1, deadlineAtMs, definitionDigest: run.definition_digest, status: "running" };
    }
    async readExecutionPlanInTransaction(transaction: MigrationDb, key: { projectId: string; runId: string }) {
      return { fence: await this.authorizeRunInTransaction(transaction, key), compiled };
    }
  }
  const lifecycle = new Lifecycle();

  class FenceReader implements FactoryReleaseFenceReader {
    async readCurrentInTransaction(transaction: MigrationDb, tenant: string, project: string, currentRunId: string) {
      if (tenant !== tenantId || project !== projectId) throw new Error("validator fence scope denied");
      const fence = await lifecycle.authorizeRunInTransaction(transaction, { projectId: project, runId: currentRunId });
      return { runId: fence.runId, executionEpoch: fence.executionEpoch, cancellationEpoch: fence.cancellationEpoch, status: fence.status, deadlineMs: fence.deadlineAtMs };
    }
  }

  function admission(attemptId: string, nodeInstanceId: string, candidateGeneration: number, runner: RunnerReference, input: FactoryRunnerRequest["input"]): FactoryAttemptAdmission {
    const base = { attemptId, tenantId, projectId, runId, nodeInstanceId, candidateGeneration, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch, deadlineAt: new Date(deadlineAtMs) };
    const { deadlineAt: _deadline, ...wire } = base;
    const request: FactoryRunnerRequest = { schemaVersion: "factory.runner.request.v1", authority: { ...wire, deadlineAtMs, nextOperationIndex: 0 }, runner, input, grants: [], resources: nodeInstanceId.startsWith("validator") ? runtime.resources : {}, tools: [], broker: { attemptToken: `token-${attemptId}`, audience: nodeInstanceId.startsWith("validator") ? runtime.brokerAudience : "candidate-gateway" } };
    return { ...base, request, requestDigest: factoryRunnerRequestDigest(request) };
  }

  function completed(output: FactoryArtifactReference): Extract<FactoryRunnerResult, { status: "completed" }> {
    return { schemaVersion: "factory.runner.result.v1", status: "completed", journalCursor: -1, operations: [], resultDigest: output.digest.slice(7), output, usage: { kind: "measured", inputTokens: 0, outputTokens: 0, computeMs: 0, costMicros: "0" }, workspaceCheckpoint: { ...output, journalCursor: -1 } };
  }

  async function terminal(authority: FactoryAttemptAuthority, value: unknown): Promise<FactoryArtifactReference> {
    return database.transaction(async transaction => {
      const output = await artifacts.stageCandidateOutputInTransaction(transaction, { tenantId, projectId, logicalRunId: runId }, authority.nodeInstanceId, authority.candidateGeneration, artifactJson.canonical(value));
      await journal.recordCompletedTerminalInTransaction(transaction, authority, completed(output), artifacts);
      return output;
    });
  }

  beforeAll(async () => {
    fixture = await createFixture(); database = fixture.db;
    const definition = { ...referenceCodeV1, acceptance: { ...referenceCodeV1.acceptance, claims: [referenceCodeV1.acceptance.claims[0]!] } };
    const result = compileFactory(definition); if (!result.ok) throw new Error("validator definition did not compile"); compiled = result.factory;
    const validatorRunner = compiled.definition.acceptance.claims[0]!.validator;
    runtime = { runner: validatorRunner, resources: { maxComputeMs: 1000 }, brokerAudience: "trusted-validator-gateway", environmentDigest: digest("validator-environment Hers"), configurationDigest: validatorRunner.configurationDigest!, maxEvidenceAgeMs: 10_000 };
    const records = new FactoryRecords(database, tenantId); await records.bindInstallation();
    await database.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Validator','/tmp/validator')`);
    await database.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${admin.id},'validator@example.test','x','Validator','admin')`);
    await database.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('validator-member',${projectId},${admin.id},'owner')`);
    await records.bindProject(projectId);
    await records.createRun({ projectId, runId, definitionDigest: compiled.digest, interpreterBuild: "factory-validator-v1", executionEpoch: 1, input: {}, principalId: admin.id }, async () => {});
    await database.execute(sql`INSERT INTO factory_drafts(tenant_id,project_id,factory_id,revision,source_digest,source_json,required_resources_json,requirements_complete,validation_diagnostic_count) VALUES (${tenantId},${projectId},${compiled.definition.id},1,${digest(compiled.definition)},${canonicalJson(compiled.definition)},'[]',TRUE,0)`);
    await database.execute(sql`INSERT INTO factory_versions(tenant_id,project_id,factory_id,version,draft_revision,definition_digest,compiled_blob_digest,compiled_bytes,lock_json) VALUES (${tenantId},${projectId},${compiled.definition.id},${compiled.definition.version},1,${compiled.digest},${digest(compiled)},${new TextEncoder().encode(canonicalJson(compiled)).byteLength},${canonicalJson(compiled.lock)})`);
    grants = new FactoryGrants(database, tenantId, () => now);
    await grants.set(admin, { projectId, principal: admin, action: "factory.run", expectedRevision: 0, expiresAtMs: null });
    await grants.set(admin, { projectId, principal: admin, action: "factory.trust", expectedRevision: 0, expiresAtMs: null });
    artifacts = new FactoryArtifacts(database, fixture.blobs, tenantId);
    journal = new FactoryExecutionJournal(database, async (transaction, authority) => {
      const fence = await lifecycle.authorizeRunInTransaction(transaction, authority);
      if (authority.executionEpoch !== fence.executionEpoch || authority.cancellationEpoch !== fence.cancellationEpoch || authority.deadlineAt.getTime() > fence.deadlineAtMs) throw new Error("validator attempt stale");
    }, () => new Date(now));
    releases = new FactoryReleaseAuthorityStore(database, tenantId, grants, lifecycle, journal, artifacts);
    validators = new FactoryTrustedValidators(database, tenantId, lifecycle, journal, artifacts, releases, [runtime]);
    material = await database.transaction(transaction => validators.registerMaterialInTransaction(transaction, projectId, compiled));
    await releases.publishTrust(admin, { projectId, expectedRevision: 0, packageLock: candidateRunner, validatorTrustDigest: material.validatorLockDigest }, "validator-trust");
    assurance = new FactoryAssurance(database, tenantId, grants, validators, new FenceReader(), validators, Date.now);
  });

  afterAll(async () => { await fixture?.close(); });

  test("migration and compiled material bind the exact protected runner lock", async () => {
    expect(material).toMatchObject({ projectId, factoryId: compiled.definition.id, definitionDigest: compiled.digest, contractId: compiled.definition.acceptance.id });
    expect(rows<{ table_name: string }>(await database.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_name IN ('factory_validator_materials','factory_validator_assignments','factory_validator_results') ORDER BY table_name`)).map(row => row.table_name)).toEqual(["factory_validator_assignments", "factory_validator_materials", "factory_validator_results"]);
    const contract: FactoryContractRevision = { projectId, contractId: material.contractId, revision: 1, contractDigest: material.contractDigest, validatorLockDigest: material.validatorLockDigest, mandatoryClaims: material.mandatoryClaims, claimGroups: material.claimGroups };
    await expect(assurance.approveContract(admin, { ...contract, contractDigest: digest("caller-forgery") }, "forged-contract")).rejects.toMatchObject({ code: "factory_validator_contract_untrusted" });
    await assurance.approveContract(admin, contract, "trusted-contract");
    const materialRow = rows<{ validators_json: string }>(await database.execute(sql`SELECT validators_json FROM factory_validator_materials WHERE tenant_id=${tenantId} AND project_id=${projectId} AND validator_lock_digest=${material.validatorLockDigest}`))[0]!;
    await database.execute(sql`UPDATE factory_validator_materials SET validators_json='[]' WHERE tenant_id=${tenantId} AND project_id=${projectId} AND validator_lock_digest=${material.validatorLockDigest}`);
    await expect(database.transaction(transaction => validators.assertContractInTransaction(transaction, tenantId, contract))).rejects.toMatchObject({ code: "factory_validator_material_corrupt" });
    await database.execute(sql`UPDATE factory_validator_materials SET validators_json=${materialRow.validators_json} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND validator_lock_digest=${material.validatorLockDigest}`);
    const unprotected = compileFactory({ ...compiled.definition, acceptance: { ...compiled.definition.acceptance, claims: [{ ...compiled.definition.acceptance.claims[0]!, protected: false }] } });
    if (!unprotected.ok) throw new Error("unprotected fixture did not compile");
    await expect(database.transaction(transaction => validators.registerMaterialInTransaction(transaction, projectId, unprotected.factory))).rejects.toMatchObject({ code: "factory_validator_material_unprotected" });
    const unpublished = compileFactory({ ...compiled.definition, acceptance: { ...compiled.definition.acceptance, version: "1.0.1" } });
    if (!unpublished.ok) throw new Error("unpublished fixture did not compile");
    await expect(database.transaction(transaction => validators.registerMaterialInTransaction(transaction, projectId, unpublished.factory))).rejects.toMatchObject({ code: "factory_validator_material_unpublished" });
  });

  test("an admitted exact candidate and validator attempt produce immutable accepted evidence while release is disabled", async () => {
    candidateAdmission = admission("candidate-attempt", "candidate-node", 0, candidateRunner, { kind: "inline", value: { request: "candidate" } });
    await journal.admit(candidateAdmission);
    await database.transaction(async transaction => {
      candidateArtifact = await artifacts.stageCandidateOutputInTransaction(transaction, { tenantId, projectId, logicalRunId: runId }, candidateAdmission.nodeInstanceId, candidateAdmission.candidateGeneration, artifactJson.canonical({ candidate: "bytes" }));
      await releases.completeCurrentCandidateInTransaction(transaction, { authority: candidateAdmission, result: completed(candidateArtifact), expectedCurrentGeneration: null });
    });
    validatorAdmission = admission("validator-attempt", "validator-node", 0, runtime.runner, { kind: "artifact", artifact: candidateArtifact });
    await journal.admit(validatorAdmission);
    await database.transaction(transaction => validators.bindAttemptInTransaction(transaction, { candidate: { projectId, runId, nodeInstanceId: candidateAdmission.nodeInstanceId, candidateGeneration: 0 }, validatorId: material.mandatoryClaims[0]!.validatorId, authority: validatorAdmission }));
    await terminal(validatorAdmission, { schemaVersion: "factory.validator-result.v1", claims: [{ id: material.mandatoryClaims[0]!.id, passed: true, decisive: true }] });
    const candidate = { projectId, runId, nodeInstanceId: candidateAdmission.nodeInstanceId, candidateGeneration: 0 };
    const first = await database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, material.mandatoryClaims[0]!.validatorId));
    const second = await database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, material.mandatoryClaims[0]!.validatorId));
    expect(second).toEqual(first);
    expect(first).toMatchObject({ candidateDigest: candidateArtifact.digest, validatorLockDigest: material.validatorLockDigest, runnerDigest: digest(runtime.runner), environmentDigest: runtime.environmentDigest, configurationDigest: runtime.configurationDigest, claims: [{ passed: true, decisive: true }] });
    expect(rows(await database.execute(sql`SELECT enabled FROM factory_release_controls WHERE tenant_id=${tenantId} AND project_id=${projectId}`))).toEqual([]);
    await assurance.captureEvidence({ ...candidate, validatorId: material.mandatoryClaims[0]!.validatorId });
    await expect(assurance.accept({ ...candidate, contractId: material.contractId, revision: 1 })).resolves.toMatchObject({ candidateDigest: candidateArtifact.digest });
  });

  test("runner, candidate artifact, and validator result bytes cannot come from caller control", async () => {
    const wrongRunner = admission("validator-wrong-runner", "validator-wrong-runner", 1, candidateRunner, { kind: "artifact", artifact: candidateArtifact });
    await journal.admit(wrongRunner);
    await expect(database.transaction(transaction => validators.bindAttemptInTransaction(transaction, { candidate: { projectId, runId, nodeInstanceId: candidateAdmission.nodeInstanceId, candidateGeneration: 0 }, validatorId: material.mandatoryClaims[0]!.validatorId, authority: wrongRunner }))).rejects.toMatchObject({ code: "factory_validator_attempt_untrusted" });
    const wrongInput = admission("validator-wrong-input", "validator-wrong-input", 2, runtime.runner, { kind: "inline", value: { claims: [{ id: material.mandatoryClaims[0]!.id, passed: true, decisive: true }] } });
    await journal.admit(wrongInput);
    await expect(database.transaction(transaction => validators.bindAttemptInTransaction(transaction, { candidate: { projectId, runId, nodeInstanceId: candidateAdmission.nodeInstanceId, candidateGeneration: 0 }, validatorId: material.mandatoryClaims[0]!.validatorId, authority: wrongInput }))).rejects.toMatchObject({ code: "factory_validator_attempt_untrusted" });
    const unassigned = admission("validator-unassigned", "validator-unassigned", 3, runtime.runner, { kind: "artifact", artifact: candidateArtifact });
    await journal.admit(unassigned);
    await terminal(unassigned, { schemaVersion: "factory.validator-result.v1", claims: [{ id: material.mandatoryClaims[0]!.id, passed: true, decisive: true }] });
    expect(rows(await database.execute(sql`SELECT validator_attempt_id FROM factory_validator_results WHERE validator_attempt_id=${unassigned.attemptId}`))).toEqual([]);
    await expect(database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, { projectId, runId, nodeInstanceId: candidateAdmission.nodeInstanceId, candidateGeneration: 1 }, material.mandatoryClaims[0]!.validatorId))).rejects.toMatchObject({ code: "factory_release_authority_stale" });
  });

  test("tampered assignments, result records, terminal facts, and validator trust fail closed", async () => {
    const candidate = { projectId, runId, nodeInstanceId: candidateAdmission.nodeInstanceId, candidateGeneration: 0 };
    const stored = rows<{ environment_digest: string; configuration_digest: string; runner_json: string; claims_json: string }>(await database.execute(sql`SELECT a.environment_digest,a.configuration_digest,a.runner_json,r.claims_json FROM factory_validator_assignments a JOIN factory_validator_results r ON r.validator_attempt_id=a.validator_attempt_id WHERE a.validator_attempt_id=${validatorAdmission.attemptId}`))[0]!;
    await database.execute(sql`UPDATE factory_validator_assignments SET environment_digest=${digest("tampered-environment")} WHERE validator_attempt_id=${validatorAdmission.attemptId}`);
    await expect(database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, material.mandatoryClaims[0]!.validatorId))).rejects.toMatchObject({ code: "factory_validator_assignment_corrupt" });
    await database.execute(sql`UPDATE factory_validator_assignments SET environment_digest=${stored.environment_digest} WHERE validator_attempt_id=${validatorAdmission.attemptId}`);
    await database.execute(sql`UPDATE factory_validator_assignments SET configuration_digest=${digest("tampered-configuration")} WHERE validator_attempt_id=${validatorAdmission.attemptId}`);
    await expect(database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, material.mandatoryClaims[0]!.validatorId))).rejects.toMatchObject({ code: "factory_validator_assignment_corrupt" });
    await database.execute(sql`UPDATE factory_validator_assignments SET configuration_digest=${stored.configuration_digest},runner_json=${canonicalJson(candidateRunner)} WHERE validator_attempt_id=${validatorAdmission.attemptId}`);
    await expect(database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, material.mandatoryClaims[0]!.validatorId))).rejects.toMatchObject({ code: "factory_validator_assignment_corrupt" });
    await database.execute(sql`UPDATE factory_validator_assignments SET runner_json=${stored.runner_json} WHERE validator_attempt_id=${validatorAdmission.attemptId}`);
    await database.execute(sql`UPDATE factory_validator_results SET claims_json='[]' WHERE validator_attempt_id=${validatorAdmission.attemptId}`);
    await expect(database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, material.mandatoryClaims[0]!.validatorId))).rejects.toMatchObject({ code: "factory_validator_result_conflict" });
    await database.execute(sql`UPDATE factory_validator_results SET claims_json=${stored.claims_json} WHERE validator_attempt_id=${validatorAdmission.attemptId}`);
    const terminalFact = rows<{ terminal_fact_digest: string }>(await database.execute(sql`SELECT terminal_fact_digest FROM factory_execution_terminals WHERE attempt_id=${validatorAdmission.attemptId}`))[0]!;
    await database.execute(sql`UPDATE factory_execution_terminals SET terminal_fact_digest=${digest("tampered-terminal")} WHERE attempt_id=${validatorAdmission.attemptId}`);
    await expect(database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, material.mandatoryClaims[0]!.validatorId))).rejects.toThrow();
    await database.execute(sql`UPDATE factory_execution_terminals SET terminal_fact_digest=${terminalFact.terminal_fact_digest} WHERE attempt_id=${validatorAdmission.attemptId}`);
    await releases.revokeTrust(admin, projectId, 1, "revoke-validator-trust");
    await expect(database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, material.mandatoryClaims[0]!.validatorId))).rejects.toMatchObject({ code: "factory_release_trust_inactive" });
  });
}
