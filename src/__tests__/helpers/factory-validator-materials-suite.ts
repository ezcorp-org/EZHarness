import { afterAll, beforeAll, expect, test } from "bun:test";
import { canonicalJson } from "@ezcorp/extension-contract";
import { compileFactory, factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import { referenceCodeV1, referenceFactories, type CompiledFactory, type FactoryArtifactReference, type FactoryRunnerRequest, type FactoryRunnerResult, type JsonValue, type RunnerReference } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { BlobStore } from "../../extensions/v4/types";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { digestBytes, digestObject } from "../../extensions/v4/blobs";
import { FactoryArtifacts, artifactJson } from "../../factory/artifacts";
import { FactoryAttemptMaterials } from "../../factory/artifact-materials";
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
  const tenantId = "validator-tenant", projectId = "validator-project", contractsProjectId = "validator-contracts", runId = "validator-run";
  const now = Date.now(), deadlineAtMs = now + 60_000;
  const admin: FactoryPrincipal = { kind: "user", id: "validator-admin", authentication: "session" };
  let fixture: Fixture, database: TransactionalDb, artifacts: FactoryArtifacts, grants: FactoryGrants, journal: FactoryExecutionJournal;
  let releases: FactoryReleaseAuthorityStore, validators: FactoryTrustedValidators, assurance: FactoryAssurance;
  let compiled: CompiledFactory;
  let runtime: FactoryTrustedValidatorRuntime, reviewRuntime: FactoryTrustedValidatorRuntime, material: Awaited<ReturnType<FactoryTrustedValidators["registerMaterialInTransaction"]>>;
  let candidateAdmission: FactoryAttemptAdmission, validatorAdmission: FactoryAttemptAdmission, reviewAdmission: FactoryAttemptAdmission;
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

  function admission(attemptId: string, nodeInstanceId: string, candidateGeneration: number, runner: RunnerReference, input: FactoryRunnerRequest["input"], validatorRuntime = nodeInstanceId.startsWith("validator") ? runtime : undefined): FactoryAttemptAdmission {
    const base = { attemptId, tenantId, projectId, runId, nodeInstanceId, candidateGeneration, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch, deadlineAt: new Date(deadlineAtMs) };
    const { deadlineAt: _deadline, ...wire } = base;
    const request: FactoryRunnerRequest = { schemaVersion: "factory.runner.request.v1", authority: { ...wire, deadlineAtMs, nextOperationIndex: 0 }, runner, input, grants: [], resources: validatorRuntime ? validatorRuntime.resources : {}, tools: [], broker: { attemptToken: `token-${attemptId}`, audience: validatorRuntime ? validatorRuntime.brokerAudience : "candidate-gateway" } };
    return { ...base, request, requestDigest: factoryRunnerRequestDigest(request) };
  }

  function completed(output: FactoryArtifactReference): Extract<FactoryRunnerResult, { status: "completed" }> {
    return { schemaVersion: "factory.runner.result.v1", status: "completed", journalCursor: -1, operations: [], resultDigest: output.digest.slice(7), output, usage: { kind: "measured", inputTokens: 0, outputTokens: 0, computeMs: 0, costMicros: "0" }, workspaceCheckpoint: { ...output, journalCursor: -1 } };
  }

  /** The guest envelope: claims only, no provenance, exactly as the SDK schema requires. */
  function claimReport(claims: readonly { readonly id: string; readonly verdict: "PASS" | "FAIL" | "INCONCLUSIVE" | "VALIDATOR_ERROR"; readonly decisive: boolean }[]) {
    return { schemaVersion: "factory.validator-claims.v1", claims: claims.map(claim => ({ ...claim, summary: `${claim.id} ${claim.verdict}`, reasonCode: claim.verdict.toLowerCase(), evidence: [], measuredAtMs: now })) };
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
    const definition = { ...referenceCodeV1, acceptance: { ...referenceCodeV1.acceptance, claims: [referenceCodeV1.acceptance.claims[0]!, referenceCodeV1.acceptance.claims[1]!, referenceCodeV1.acceptance.claims.at(-1)!] } };
    const result = compileFactory(definition); if (!result.ok) throw new Error("validator definition did not compile"); compiled = result.factory;
    const validatorRunner = compiled.definition.acceptance.claims[0]!.validator;
    runtime = { runner: validatorRunner, resources: { maxComputeMs: 1000 }, brokerAudience: "trusted-validator-gateway", environmentDigest: digest("validator-environment Hers"), configurationDigest: validatorRunner.configurationDigest!, maxEvidenceAgeMs: 10_000 };
    const records = new FactoryRecords(database, tenantId); await records.bindInstallation();
    await database.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Validator','/tmp/validator')`);
    await database.execute(sql`INSERT INTO projects(id,name,path) VALUES (${contractsProjectId},'Validator contracts','/tmp/validator-contracts')`);
    await database.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${admin.id},'validator@example.test','x','Validator','admin')`);
    await database.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('validator-member',${projectId},${admin.id},'owner')`);
    await database.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('validator-contracts-member',${contractsProjectId},${admin.id},'owner')`);
    await records.bindProject(projectId);
    await records.bindProject(contractsProjectId);
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
    const trustedRuntimes = new Map<string, FactoryTrustedValidatorRuntime>();
    trustedRuntimes.set(digest(runtime.runner), runtime);
    for (const definition of referenceFactories) for (const claim of definition.acceptance.claims) {
      const key = digest(claim.validator);
      if (!trustedRuntimes.has(key)) trustedRuntimes.set(key, { runner: claim.validator, resources: { maxComputeMs: 1000 }, brokerAudience: `trusted-${key.slice(-12)}`, environmentDigest: digest({ runner: claim.validator, kind: "environment" }), configurationDigest: claim.validator.configurationDigest!, maxEvidenceAgeMs: 86_400_000 });
    }
    reviewRuntime = trustedRuntimes.get(digest(compiled.definition.acceptance.claims.at(-1)!.validator))!;
    validators = new FactoryTrustedValidators(database, tenantId, lifecycle, journal, artifacts, releases, trustedRuntimes.values());
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

  test("all reference contracts retain protected optional quorum claims", async () => {
    for (const definition of referenceFactories) {
      const result = compileFactory(definition);
      if (!result.ok) throw new Error(`reference ${definition.id} did not compile`);
      const current = result.factory;
      await database.execute(sql`INSERT INTO factory_drafts(tenant_id,project_id,factory_id,revision,source_digest,source_json,required_resources_json,requirements_complete,validation_diagnostic_count) VALUES (${tenantId},${contractsProjectId},${current.definition.id},1,${digest(current.definition)},${canonicalJson(current.definition)},'[]',TRUE,0)`);
      await database.execute(sql`INSERT INTO factory_versions(tenant_id,project_id,factory_id,version,draft_revision,definition_digest,compiled_blob_digest,compiled_bytes,lock_json) VALUES (${tenantId},${contractsProjectId},${current.definition.id},${current.definition.version},1,${current.digest},${digest(current)},${new TextEncoder().encode(canonicalJson(current)).byteLength},${canonicalJson(current.lock)})`);
      const registered = await database.transaction(transaction => validators.registerMaterialInTransaction(transaction, contractsProjectId, current));
      const expected = current.definition.acceptance.claims.filter(claim => claim.required || current.definition.acceptance.groups?.some(group => group.claimIds.includes(claim.id)));
      expect(registered.mandatoryClaims).toEqual(expected.map(claim => ({ id: claim.id, validatorId: claim.id, freshnessMs: claim.freshnessMs ?? 86_400_000, ...(claim.required ? {} : { required: false }) })));
    }
    const image = referenceFactories.find(definition => definition.id === "reference.image.v1")!;
    const result = compileFactory(image); if (!result.ok) throw new Error("image reference did not compile");
    const registered = await database.transaction(transaction => validators.registerMaterialInTransaction(transaction, contractsProjectId, result.factory));
    expect(registered.mandatoryClaims.filter(claim => claim.required === false).map(claim => claim.id)).toEqual(["semantic-evaluation-1", "semantic-evaluation-2", "semantic-evaluation-3"]);
  });

  test("an admitted exact candidate and validator attempt produce immutable accepted evidence while release is disabled", async () => {
    candidateAdmission = admission("candidate-attempt", "candidate-node", 0, candidateRunner, { kind: "inline", value: { request: "candidate" } });
    await journal.admit(candidateAdmission);
    await database.transaction(async transaction => {
      candidateArtifact = await artifacts.stageCandidateOutputInTransaction(transaction, { tenantId, projectId, logicalRunId: runId }, candidateAdmission.nodeInstanceId, candidateAdmission.candidateGeneration, artifactJson.canonical({ candidate: "bytes" }));
      await releases.completeCurrentCandidateInTransaction(transaction, { authority: candidateAdmission, result: completed(candidateArtifact), expectedCurrentGeneration: null });
    });
    const taskClaims = material.mandatoryClaims.slice(0, 2).map(claim => claim.validatorId);
    const reviewClaim = material.mandatoryClaims.at(-1)!.validatorId;
    const taskInput = JSON.parse(canonicalJson({ candidate: { kind: "artifact", artifact: candidateArtifact } })) as JsonValue;
    validatorAdmission = admission("validator-attempt", "validator-node", 0, runtime.runner, { kind: "inline", value: taskInput });
    await journal.admit(validatorAdmission);
    const candidate = { projectId, runId, nodeInstanceId: candidateAdmission.nodeInstanceId, candidateGeneration: 0 };
    await database.transaction(transaction => validators.bindTaskAttemptInTransaction(transaction, { candidate, validatorIds: taskClaims, authority: validatorAdmission, expectedInput: taskInput }));
    await terminal(validatorAdmission, claimReport(material.mandatoryClaims.slice(0, 2).map(claim => ({ id: claim.id, verdict: "PASS" as const, decisive: true }))));
    reviewAdmission = admission("validator-review-attempt", "validator-review-node", 0, reviewRuntime.runner, { kind: "artifact", artifact: candidateArtifact }, reviewRuntime);
    await journal.admit(reviewAdmission);
    await database.transaction(transaction => validators.bindAttemptInTransaction(transaction, { candidate, validatorId: reviewClaim, authority: reviewAdmission }));
    await terminal(reviewAdmission, claimReport([{ id: reviewClaim, verdict: "PASS", decisive: true }]));
    const first = await database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, taskClaims[0]!));
    const second = await database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, taskClaims[0]!));
    expect(second).toEqual(first);
    expect(first).toMatchObject({ candidateDigest: candidateArtifact.digest, validatorLockDigest: material.validatorLockDigest, runnerDigest: digest(runtime.runner), environmentDigest: runtime.environmentDigest, configurationDigest: runtime.configurationDigest, claims: [{ id: taskClaims[0], verdict: "PASS", decisive: true }] });
    const sibling = await database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, taskClaims[1]!));
    expect(sibling.claims).toEqual([{ id: taskClaims[1]!, verdict: "PASS", decisive: true }]);
    expect(sibling.artifact).toEqual(first.artifact);
    expect(rows(await database.execute(sql`SELECT validator_id FROM factory_validator_assignments WHERE validator_attempt_id=${validatorAdmission.attemptId} ORDER BY validator_id`))).toEqual([...taskClaims].sort().map(validator_id => ({ validator_id })));
    expect(rows(await database.execute(sql`SELECT validator_id,result_digest FROM factory_validator_results WHERE validator_attempt_id=${validatorAdmission.attemptId} ORDER BY validator_id`)).map(row => (row as { validator_id: string }).validator_id)).toEqual([...taskClaims].sort());
    expect(new Set(rows<{ result_digest: string }>(await database.execute(sql`SELECT result_digest FROM factory_validator_results WHERE validator_attempt_id=${validatorAdmission.attemptId}`)).map(row => row.result_digest)).size).toBe(2);
    expect(rows(await database.execute(sql`SELECT enabled FROM factory_release_controls WHERE tenant_id=${tenantId} AND project_id=${projectId}`))).toEqual([]);
    for (const claim of material.mandatoryClaims) await assurance.captureEvidence({ ...candidate, validatorId: claim.validatorId });
    const accepted = await assurance.accept({ ...candidate, contractId: material.contractId, revision: 1 });
    expect(accepted).toMatchObject({ candidateDigest: candidateArtifact.digest });
    expect(await database.transaction(transaction => assurance.acceptCurrentInTransaction(transaction, candidate, material.contractId))).toEqual(accepted);
  });

  test("one attempt binds only claims that share its pinned execution profile, and only claims it was assigned", async () => {
    const candidate = { projectId, runId, nodeInstanceId: candidateAdmission.nodeInstanceId, candidateGeneration: 0 };
    const taskClaims = material.mandatoryClaims.slice(0, 2).map(claim => claim.validatorId);
    const reviewClaim = material.mandatoryClaims.at(-1)!.validatorId;
    const mixedInput = JSON.parse(canonicalJson({ candidate: { kind: "artifact", artifact: candidateArtifact } })) as JsonValue;
    const mixed = admission("validator-mixed-profile", "validator-mixed-profile", 0, runtime.runner, { kind: "inline", value: mixedInput });
    await journal.admit(mixed);
    await expect(database.transaction(transaction => validators.bindTaskAttemptInTransaction(transaction, { candidate, validatorIds: [taskClaims[0]!, reviewClaim], authority: mixed, expectedInput: mixedInput }))).rejects.toMatchObject({ code: "factory_validator_attempt_untrusted" });
    await expect(database.transaction(transaction => validators.bindTaskAttemptInTransaction(transaction, { candidate, validatorIds: [taskClaims[0]!, "claim-that-no-material-pins"], authority: mixed, expectedInput: mixedInput }))).rejects.toMatchObject({ code: "factory_validator_material_stale" });
    for (const validatorIds of [[], [taskClaims[0]!, taskClaims[0]!], Array.from({ length: 1001 }, (_value, index) => `claim-${index}`)]) {
      await expect(database.transaction(transaction => validators.bindTaskAttemptInTransaction(transaction, { candidate, validatorIds, authority: mixed, expectedInput: mixedInput }))).rejects.toMatchObject({ code: "factory_validator_invalid" });
    }
    expect(rows(await database.execute(sql`SELECT validator_id FROM factory_validator_assignments WHERE validator_attempt_id=${mixed.attemptId}`))).toEqual([]);
    await expect(database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, reviewClaim))).resolves.toMatchObject({ validatorId: reviewClaim, runnerDigest: digest(reviewRuntime.runner) });
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
    await terminal(unassigned, claimReport([{ id: material.mandatoryClaims[0]!.id, verdict: "PASS", decisive: true }]));
    expect(rows(await database.execute(sql`SELECT validator_attempt_id FROM factory_validator_results WHERE validator_attempt_id=${unassigned.attemptId}`))).toEqual([]);
    await expect(database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, { projectId, runId, nodeInstanceId: candidateAdmission.nodeInstanceId, candidateGeneration: 1 }, material.mandatoryClaims[0]!.validatorId))).rejects.toMatchObject({ code: "factory_release_authority_stale" });
  });

  test("tampered assignments, result records, terminal facts, and validator trust fail closed", async () => {
    const candidate = { projectId, runId, nodeInstanceId: candidateAdmission.nodeInstanceId, candidateGeneration: 0 };
    const stored = rows<{ environment_digest: string; configuration_digest: string; runner_json: string; claims_json: string }>(await database.execute(sql`SELECT a.environment_digest,a.configuration_digest,a.runner_json,r.claims_json FROM factory_validator_assignments a JOIN factory_validator_results r ON r.tenant_id=a.tenant_id AND r.project_id=a.project_id AND r.validator_attempt_id=a.validator_attempt_id AND r.validator_id=a.validator_id WHERE a.validator_attempt_id=${validatorAdmission.attemptId} AND a.validator_id=${material.mandatoryClaims[0]!.validatorId}`))[0]!;
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

  test("a repaired candidate rebinds by claim under the latest trust revision, and an omitted claim mints no evidence", async () => {
    await releases.publishTrust(admin, { projectId, expectedRevision: 2, packageLock: candidateRunner, validatorTrustDigest: material.validatorLockDigest }, "validator-trust-restored");
    const repaired = admission("candidate-attempt-repair", "candidate-node", 1, candidateRunner, { kind: "inline", value: { request: "candidate-repair" } });
    await journal.admit(repaired);
    const repairedArtifact = await database.transaction(async transaction => {
      const staged = await artifacts.stageCandidateOutputInTransaction(transaction, { tenantId, projectId, logicalRunId: runId }, repaired.nodeInstanceId, repaired.candidateGeneration, artifactJson.canonical({ candidate: "repaired-bytes" }));
      await releases.completeCurrentCandidateInTransaction(transaction, { authority: repaired, result: completed(staged), expectedCurrentGeneration: 0 });
      return staged;
    });
    const candidate = { projectId, runId, nodeInstanceId: repaired.nodeInstanceId, candidateGeneration: 1 };
    const claims = material.mandatoryClaims.slice(0, 2).map(claim => claim.validatorId);
    const input = JSON.parse(canonicalJson({ candidate: { kind: "artifact", artifact: repairedArtifact } })) as JsonValue;
    const attempt = admission("validator-repair-attempt", "validator-repair-node", 1, runtime.runner, { kind: "inline", value: input });
    await journal.admit(attempt);
    await database.transaction(transaction => validators.bindTaskAttemptInTransaction(transaction, { candidate, validatorIds: claims, authority: attempt, expectedInput: input }));
    await terminal(attempt, claimReport([{ id: claims[0]!, verdict: "FAIL", decisive: true }]));
    await expect(database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, claims[0]!))).resolves.toMatchObject({ candidateDigest: repairedArtifact.digest, claims: [{ id: claims[0], verdict: "FAIL", decisive: true }] });
    await expect(database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, claims[1]!))).rejects.toMatchObject({ code: "factory_validator_result_invalid" });
    expect(rows(await database.execute(sql`SELECT validator_id FROM factory_validator_results WHERE validator_attempt_id=${attempt.attemptId}`))).toEqual([{ validator_id: claims[0] }]);
    expect(rows<{ trust_revision: number | string }>(await database.execute(sql`SELECT DISTINCT trust_revision FROM factory_validator_assignments WHERE validator_attempt_id=${attempt.attemptId}`)).map(row => Number(row.trust_revision))).toEqual([3]);
    // The verdict is stored explicitly and the gateway seals the report it built from the row.
    const stored = rows<{ verdict: string; report_digest: string }>(await database.execute(sql`SELECT verdict, report_digest FROM factory_validator_results WHERE validator_attempt_id=${attempt.attemptId}`))[0]!;
    expect(stored.verdict).toBe("FAIL");
    expect(stored.report_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    await expect(database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, { projectId, runId, nodeInstanceId: candidateAdmission.nodeInstanceId, candidateGeneration: 0 }, claims[0]!))).rejects.toMatchObject({ code: "factory_release_authority_stale" });
  });

  test("a process that exits cleanly still needs a strict report, and no verdict but PASS satisfies a claim", async () => {
    const claimId = material.mandatoryClaims[0]!.validatorId;
    let generation = 1;
    /** One repaired candidate plus one bound protected task whose guest writes `report`. */
    async function round(report: unknown) {
      generation += 1;
      const candidateAttempt = admission(`candidate-attempt-${generation}`, "candidate-node", generation, candidateRunner, { kind: "inline", value: { request: `candidate-${generation}` } });
      await journal.admit(candidateAttempt);
      const staged = await database.transaction(async transaction => {
        const output = await artifacts.stageCandidateOutputInTransaction(transaction, { tenantId, projectId, logicalRunId: runId }, "candidate-node", generation, artifactJson.canonical({ candidate: `bytes-${generation}` }));
        await releases.completeCurrentCandidateInTransaction(transaction, { authority: candidateAttempt, result: completed(output), expectedCurrentGeneration: generation - 1 });
        return output;
      });
      const candidate = { projectId, runId, nodeInstanceId: "candidate-node", candidateGeneration: generation };
      const input = JSON.parse(canonicalJson({ candidate: { kind: "artifact", artifact: staged } })) as JsonValue;
      const attempt = admission(`validator-attempt-${generation}`, `validator-node-${generation}`, generation, runtime.runner, { kind: "inline", value: input });
      await journal.admit(attempt);
      await database.transaction(transaction => validators.bindTaskAttemptInTransaction(transaction, { candidate, validatorIds: [claimId], authority: attempt, expectedInput: input }));
      await terminal(attempt, report);
      return { candidate, attempt };
    }

    for (const verdict of ["INCONCLUSIVE", "VALIDATOR_ERROR"] as const) {
      const { candidate, attempt } = await round(claimReport([{ id: claimId, verdict, decisive: true }]));
      const evidence = await database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, claimId));
      expect(evidence.claims).toEqual([{ id: claimId, verdict, decisive: true }]);
      expect(rows(await database.execute(sql`SELECT verdict FROM factory_validator_results WHERE validator_attempt_id=${attempt.attemptId}`))).toEqual([{ verdict }]);
      await assurance.captureEvidence({ ...candidate, validatorId: claimId });
      // A completed process and a stored result are not acceptance: only PASS satisfies the claim.
      await expect(assurance.accept({ ...candidate, contractId: material.contractId, revision: 1 })).rejects.toMatchObject({ code: "factory_assurance_claim_failed" });
    }

    const provenance = { attemptId: "forged", tenantId, projectId, runId, candidateNodeInstanceId: "candidate-node", candidateGeneration: 0, candidateDigest: digest("forge"), validatorLockDigest: material.validatorLockDigest, runnerDigest: digest(runtime.runner), environmentDigest: runtime.environmentDigest, configurationDigest: runtime.configurationDigest, trustRevision: 1, issuerGrantRevision: 1, issuedAtMs: 1, expiresAtMs: 2 };
    for (const forged of [
      { ...claimReport([{ id: claimId, verdict: "PASS" as const, decisive: true }]), provenance },
      { schemaVersion: "factory.validator-result.v1", claims: [{ id: claimId, passed: true, decisive: true }] },
      claimReport([{ id: "a-claim-this-attempt-was-never-assigned", verdict: "PASS", decisive: true }]),
      { schemaVersion: "factory.validator-claims.v1", claims: [] },
    ]) {
      const { candidate } = await round(forged);
      await expect(database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, claimId))).rejects.toMatchObject({ code: "factory_validator_result_invalid" });
    }
  });

  test("a claim may cite only the evidence its own attempt wrote", async () => {
    const claimId = material.mandatoryClaims[0]!.validatorId;
    const bytes = new TextEncoder().encode("validator findings");
    const findingsDigest = `sha256:${digestBytes(bytes)}`;
    let sequence = 0;

    /**
     * One repaired candidate, one bound validator attempt, and one auxiliary material that attempt
     * wrote. Each round advances the candidate generation, because a candidate output is immutable
     * and one attempt cannot publish two different reports.
     */
    async function round() {
      sequence += 1;
      const previous = Number(rows<{ candidate_generation: number | string }>(await database.execute(sql`SELECT candidate_generation FROM factory_release_current_candidates WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${runId} AND node_instance_id='candidate-node'`))[0]!.candidate_generation);
      const generation = previous + 1;
      const candidateAttempt = admission(`candidate-attempt-evidence-${sequence}`, "candidate-node", generation, candidateRunner, { kind: "inline", value: { request: `candidate-evidence-${sequence}` } });
      await journal.admit(candidateAttempt);
      const staged = await database.transaction(async transaction => {
        const output = await artifacts.stageCandidateOutputInTransaction(transaction, { tenantId, projectId, logicalRunId: runId }, "candidate-node", generation, artifactJson.canonical({ candidate: `evidence-bytes-${sequence}` }));
        await releases.completeCurrentCandidateInTransaction(transaction, { authority: candidateAttempt, result: completed(output), expectedCurrentGeneration: previous });
        return output;
      });
      const candidate = { projectId, runId, nodeInstanceId: "candidate-node", candidateGeneration: generation };
      const input = JSON.parse(canonicalJson({ candidate: { kind: "artifact", artifact: staged } })) as JsonValue;
      const attempt = admission(`validator-attempt-evidence-${sequence}`, `validator-node-evidence-${sequence}`, generation, runtime.runner, { kind: "inline", value: input });
      await journal.admit(attempt);
      await database.transaction(transaction => validators.bindTaskAttemptInTransaction(transaction, { candidate, validatorIds: [claimId], authority: attempt, expectedInput: input }));
      const materials = new FactoryAttemptMaterials({ database, artifacts, blobs: fixture.blobs, journal, authority: attempt });
      const identity = { ...materials.scope(`${runId}:validator-node-evidence-${sequence}:${generation}:0`), objectName: "findings.txt", version: 1 };
      await materials.begin(identity, "text/plain", bytes.byteLength, 1);
      await materials.writeChunk(identity, { index: 0, digest: findingsDigest, encodedBytes: bytes.byteLength }, bytes);
      return { candidate, attempt, owned: await materials.seal(identity, findingsDigest) };
    }

    const cited = (evidence: readonly unknown[]) => ({ schemaVersion: "factory.validator-claims.v1", claims: [{ id: claimId, verdict: "FAIL", decisive: true, summary: "findings attached", reasonCode: "fail", evidence, measuredAtMs: now }] });
    const foreign = (await round()).owned;
    for (const build of [
      (_owned: FactoryArtifactReference) => foreign,
      (owned: FactoryArtifactReference) => ({ ...owned, digest: digest("tampered-evidence") }),
      (owned: FactoryArtifactReference) => ({ ...owned, encodedBytes: owned.encodedBytes + 1 }),
      (owned: FactoryArtifactReference) => ({ ...owned, artifactId: "an-artifact-that-does-not-exist" }),
    ]) {
      const { candidate, attempt, owned } = await round();
      await terminal(attempt, cited([build(owned)]));
      await expect(database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, candidate, claimId))).rejects.toMatchObject({ code: "factory_validator_evidence_scope" });
      expect(rows(await database.execute(sql`SELECT validator_id FROM factory_validator_results WHERE validator_attempt_id=${attempt.attemptId}`))).toEqual([]);
    }

    const duplicated = await round();
    await terminal(duplicated.attempt, cited([duplicated.owned, duplicated.owned]));
    await expect(database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, duplicated.candidate, claimId))).rejects.toMatchObject({ code: "factory_validator_evidence_scope" });

    const accepted = await round();
    await terminal(accepted.attempt, cited([accepted.owned]));
    const evidence = await database.transaction(transaction => validators.resolveValidatorInTransaction(transaction, tenantId, accepted.candidate, claimId));
    expect(evidence.claims).toEqual([{ id: claimId, verdict: "FAIL", decisive: true }]);
    expect(rows(await database.execute(sql`SELECT verdict FROM factory_validator_results WHERE validator_attempt_id=${accepted.attempt.attemptId}`))).toEqual([{ verdict: "FAIL" }]);
  });

}
