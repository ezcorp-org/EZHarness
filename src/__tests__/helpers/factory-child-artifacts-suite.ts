import { afterAll, beforeAll, expect, test } from "bun:test";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { BlobStore } from "../../extensions/v4/types";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { digestObject } from "../../extensions/v4/blobs";
import { FactoryArtifacts, artifactJson } from "../../factory/artifacts";
import { FactoryAssurance, type FactoryCandidateKey, type FactoryCurrentCandidateResolver, type FactoryReleaseFenceReader, type FactoryTrustedEvidence, type FactoryTrustedValidatorGateway } from "../../factory/assurance";
import { FactoryChildArtifacts, type FactoryAncestryFenceReader, type FactoryParentAttemptKey } from "../../factory/child-artifacts";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryRecords } from "../../factory/records";
import type { FactoryRunFence } from "../../factory/run-lifecycle";

interface Fixture { readonly db: TransactionalDb; readonly blobs: BlobStore; close(): Promise<void> }

export function factoryChildArtifactsConformance(createFixture: () => Promise<Fixture>): void {
  const tenantId = "child-artifact-tenant", projectId = "child-artifact-project";
  const parentRunId = "child-artifact-parent", childRunId = "child-artifact-child", foreignRunId = "child-artifact-foreign";
  const interpreterId = "root", commandId = "child-artifact-command", parentAttemptId = "child-artifact-parent-attempt";
  const now = Date.UTC(2030, 0, 1);
  const admin: FactoryPrincipal = { kind: "user", id: "child-artifact-admin", authentication: "session" };
  const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
  const hash = (value: unknown) => `sha256:${digestObject(value)}`;

  let fixture: Fixture, database: TransactionalDb, artifacts: FactoryArtifacts, assurance: FactoryAssurance, aliases: FactoryChildArtifacts;
  let candidateArtifact: { artifactId: string; digest: string; encodedBytes: number };
  let childDecisionId: string, trusted: FactoryTrustedEvidence;
  const epochs = new Map<string, { executionEpoch: number; cancellationEpoch: number }>();

  const childCandidate: FactoryCandidateKey = { projectId, runId: childRunId, nodeInstanceId: "child-candidate", candidateGeneration: 0 };
  const parent: FactoryParentAttemptKey = { runId: parentRunId, interpreterId, commandId, nodeInstanceId: "child-node", candidateGeneration: 0, attemptId: parentAttemptId };

  class Gateway implements FactoryTrustedValidatorGateway, FactoryCurrentCandidateResolver {
    async assertContractInTransaction(): Promise<void> {}
    async resolveValidatorInTransaction(_transaction: MigrationDb, tenant: string, key: FactoryCandidateKey, validatorId: string): Promise<FactoryTrustedEvidence> {
      if (tenant !== tenantId || key.runId !== childRunId || validatorId !== trusted.validatorId) throw new Error("configured validator did not authorize this candidate");
      return structuredClone(trusted);
    }
    async resolveCurrentEvidenceInTransaction(): Promise<readonly FactoryTrustedEvidence[]> { return [structuredClone(trusted)]; }
  }

  const fenceFor = (runId: string): FactoryRunFence => {
    const epoch = epochs.get(runId) ?? { executionEpoch: 1, cancellationEpoch: 0 };
    return { tenantId, projectId, runId, ...epoch, grantRevision: 1, revision: 1, deadlineAtMs: now + 600_000, definitionDigest: digest("d"), status: "running" };
  };
  const fences: FactoryAncestryFenceReader = {
    tenantId,
    async readCurrentFenceInTransaction(_transaction: MigrationDb, currentProject: string, runId: string) {
      if (currentProject !== projectId) throw new Error("ancestry fence scope mismatch");
      return fenceFor(runId);
    },
  };
  const releaseFences: FactoryReleaseFenceReader = {
    async readCurrentInTransaction(_transaction: MigrationDb, tenant: string, currentProject: string, runId: string) {
      if (tenant !== tenantId || currentProject !== projectId) throw new Error("release fence scope mismatch");
      const fence = fenceFor(runId);
      return { runId, executionEpoch: fence.executionEpoch, cancellationEpoch: fence.cancellationEpoch, status: fence.status, deadlineMs: fence.deadlineAtMs };
    },
  };

  /**
   * The parent's committed child binding.
   *
   * A real `FactoryChildRuns.resolve` needs a whole committed interpreter, which is another
   * package's fixture. The row below is built exactly as production seals it, and production's own
   * `verifyFactoryChildBinding` is what accepts or rejects it, so a wrong fixture fails the test
   * rather than passing it.
   */
  async function bindChild(parentRun: string, childRun: string, command: string, executionEpoch = 1): Promise<void> {
    const definition = { definitionDigest: digest("a"), definitionEncodedBytes: 32, manifest: { objectId: "child-manifest", digest: digest("b"), encodedBytes: 32 } };
    const raw = {
      parent_run_id: parentRun, parent_interpreter_id: interpreterId, parent_command_id: command, parent_source_sequence: 1, parent_command_digest: digest("c"),
      child_run_id: childRun, parent_envelope_id: "root", child_envelope_id: "root", child_factory_id: "child-factory", child_factory_version: "1.0.0",
      child_definition_digest: definition.definitionDigest, definition_json: canonicalJson(definition), started_ms: now,
      parent_execution_epoch: executionEpoch, parent_cancellation_epoch: 0, parent_grant_revision: 1, deadline_ms: now + 600_000,
    };
    const bindingDigest = hash({
      parentRunId: raw.parent_run_id, parentInterpreterId: raw.parent_interpreter_id, parentCommandId: raw.parent_command_id, parentSourceSequence: raw.parent_source_sequence,
      parentCommandDigest: raw.parent_command_digest, childRunId: raw.child_run_id, parentEnvelopeId: raw.parent_envelope_id, childEnvelopeId: raw.child_envelope_id,
      childFactoryId: raw.child_factory_id, childFactoryVersion: raw.child_factory_version, childDefinitionDigest: raw.child_definition_digest,
      definition, startedAtMs: raw.started_ms, parentExecutionEpoch: raw.parent_execution_epoch, parentCancellationEpoch: raw.parent_cancellation_epoch,
      parentGrantRevision: raw.parent_grant_revision, deadlineAtMs: raw.deadline_ms,
    });
    await database.execute(sql`INSERT INTO factory_audit_batches(tenant_id,project_id,run_id,interpreter_id,source_sequence,sequence,digest,payload) VALUES (${tenantId},${projectId},${parentRun},${interpreterId},1,${parentRun === parentRunId ? 1 : 2},${digest("e")},'{}')`);
    await database.execute(sql`INSERT INTO factory_transition_commands(tenant_id,project_id,run_id,interpreter_id,command_id,source_sequence,command_digest) VALUES (${tenantId},${projectId},${parentRun},${interpreterId},${command},1,${raw.parent_command_digest})`);
    await database.execute(sql`INSERT INTO factory_child_runs(tenant_id,project_id,parent_run_id,parent_interpreter_id,parent_command_id,parent_source_sequence,parent_command_digest,child_run_id,parent_envelope_id,child_envelope_id,child_factory_id,child_factory_version,child_definition_digest,definition_json,started_ms,parent_execution_epoch,parent_cancellation_epoch,parent_grant_revision,deadline_ms,binding_digest,state) VALUES (${tenantId},${projectId},${raw.parent_run_id},${interpreterId},${raw.parent_command_id},1,${raw.parent_command_digest},${raw.child_run_id},'root','root',${raw.child_factory_id},${raw.child_factory_version},${raw.child_definition_digest},${raw.definition_json},${raw.started_ms},${raw.parent_execution_epoch},0,1,${raw.deadline_ms},${bindingDigest},'open')`);
  }

  async function envelope(runId: string): Promise<void> {
    await database.execute(sql`INSERT INTO factory_budget_envelopes(tenant_id,project_id,run_id,envelope_id,request_digest,limits,allocated,spent,deadline_ms,state) VALUES (${tenantId},${projectId},${runId},'root',${digest("f")},'{}','{}','{}',${now + 600_000},'open')`);
  }

  async function attempt(attemptId: string, runId: string, nodeInstanceId: string, candidateGeneration: number, executionEpoch = 1): Promise<void> {
    await database.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES (${attemptId},${tenantId},${projectId},${runId},${nodeInstanceId},${candidateGeneration},1,1,1,${executionEpoch},0,${new Date(now + 600_000)},${"a".repeat(64)},'{}'::jsonb,'admitted')`);
  }

  beforeAll(async () => {
    fixture = await createFixture(); database = fixture.db;
    const records = new FactoryRecords(database, tenantId); await records.bindInstallation();
    await database.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Child artifacts','/tmp/child-artifacts')`);
    await database.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${admin.id},'child@example.test','x','Child','admin')`);
    await database.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('child-artifact-member',${projectId},${admin.id},'owner')`);
    await records.bindProject(projectId);
    for (const runId of [parentRunId, childRunId, foreignRunId]) {
      await records.createRun({ projectId, runId, definitionDigest: digest("d"), interpreterBuild: "factory-child-v1", executionEpoch: 1, input: {}, principalId: admin.id }, async () => {});
      await envelope(runId);
    }
    const grants = new FactoryGrants(database, tenantId, () => now);
    await grants.set(admin, { projectId, principal: admin, action: "factory.trust", expectedRevision: 0, expiresAtMs: null });
    artifacts = new FactoryArtifacts(database, fixture.blobs, tenantId);
    candidateArtifact = await database.transaction(transaction => artifacts.stageCandidateOutputInTransaction(transaction, { tenantId, projectId, logicalRunId: childRunId }, childCandidate.nodeInstanceId, 0, artifactJson.canonical({ accepted: "child bytes" })));
    trusted = {
      ...childCandidate, validatorId: "child-validator", validatorLockDigest: digest("b"), issuerGrantRevision: 1, candidateDigest: candidateArtifact.digest,
      artifact: candidateArtifact, environmentDigest: digest("e"), configurationDigest: digest("f"), runnerDigest: digest("c"),
      claims: [{ id: "child-claim", verdict: "PASS", decisive: true }], issuedAtMs: now - 1, expiresAtMs: now + 600_000,
    };
    assurance = new FactoryAssurance(database, tenantId, grants, new Gateway(), releaseFences, new Gateway(), () => now);
    await assurance.approveContract(admin, { projectId, contractId: "child-contract", revision: 1, contractDigest: digest("9"), validatorLockDigest: trusted.validatorLockDigest, mandatoryClaims: [{ id: "child-claim", validatorId: trusted.validatorId, freshnessMs: 600_000 }], claimGroups: [] }, "child-contract-approve");
    await assurance.captureEvidence({ ...childCandidate, validatorId: trusted.validatorId });
    childDecisionId = (await assurance.accept({ ...childCandidate, contractId: "child-contract", revision: 1 })).decisionId;
    await bindChild(parentRunId, childRunId, commandId);
    await bindChild(foreignRunId, foreignRunId, "foreign-command");
    await attempt(parentAttemptId, parentRunId, parent.nodeInstanceId, 0);
    await attempt("child-artifact-other-attempt", parentRunId, "another-node", 0);
    aliases = new FactoryChildArtifacts(database, tenantId, assurance, artifacts, fences);
  });

  afterAll(async () => { await fixture?.close(); });

  test("a child's accepted artifact binds to the exact parent attempt, and rebinding is idempotent", async () => {
    const alias = await aliases.bind({ projectId, parent, childRunId, childDecisionId, artifact: candidateArtifact });
    expect(alias).toMatchObject({
      childRunId, childDecisionId, childNodeInstanceId: childCandidate.nodeInstanceId, childCandidateGeneration: 0,
      childCandidateDigest: candidateArtifact.digest, parentExecutionEpoch: 1, parentCancellationEpoch: 0, childExecutionEpoch: 1,
      artifact: candidateArtifact,
    });
    expect(alias.aliasId).toBe(`factory-child-alias:${alias.aliasDigest.slice("sha256:".length)}`);
    expect(await aliases.bind({ projectId, parent, childRunId, childDecisionId, artifact: candidateArtifact })).toEqual(alias);
    expect(await database.transaction(transaction => aliases.resolveInTransaction(transaction, projectId, parent))).toEqual(alias);
    expect(rows(await database.execute(sql`SELECT alias_id FROM factory_child_artifact_aliases WHERE tenant_id=${tenantId} AND parent_run_id=${parentRunId}`))).toEqual([{ alias_id: alias.aliasId }]);
    // An alias is not an acceptance: the parent run still has no decision of its own.
    expect(rows(await database.execute(sql`SELECT decision_id FROM factory_acceptance_decisions WHERE tenant_id=${tenantId} AND run_id=${parentRunId}`))).toEqual([]);
  });

  test("a foreign child, a foreign decision, a changed artifact, and an unknown parent attempt are refused", async () => {
    // The stored attempt runs on `child-node`, so a request naming another node is not that attempt.
    const other = { ...parent, nodeInstanceId: "another-node" };
    for (const [request, code] of [
      [{ projectId, parent, childRunId: foreignRunId, childDecisionId, artifact: candidateArtifact }, "factory_child_artifact_foreign"],
      [{ projectId, parent: { ...parent, commandId: "foreign-command" }, childRunId, childDecisionId, artifact: candidateArtifact }, "factory_child_artifact_foreign"],
      [{ projectId, parent: { ...parent, attemptId: "child-artifact-missing-attempt" }, childRunId, childDecisionId, artifact: candidateArtifact }, "factory_child_artifact_foreign"],
      [{ projectId, parent: other, childRunId, childDecisionId, artifact: candidateArtifact }, "factory_child_artifact_foreign"],
      [{ projectId, parent, childRunId, childDecisionId, artifact: { ...candidateArtifact, digest: digest("1") } }, "factory_child_artifact_foreign"],
      [{ projectId, parent, childRunId, childDecisionId: "child-artifact-unknown-decision", artifact: candidateArtifact }, "factory_assurance_not_found"],
    ] as const) {
      await expect(aliases.bind(request)).rejects.toMatchObject({ code });
    }
    expect(rows(await database.execute(sql`SELECT alias_id FROM factory_child_artifact_aliases WHERE tenant_id=${tenantId}`))).toHaveLength(1);
  });

  test("a malformed request never reaches the database", async () => {
    for (const request of [
      { projectId, parent: { ...parent, candidateGeneration: -1 }, childRunId, childDecisionId, artifact: candidateArtifact },
      { projectId, parent: { ...parent, attemptId: "" }, childRunId, childDecisionId, artifact: candidateArtifact },
      { projectId, parent, childRunId, childDecisionId, artifact: { ...candidateArtifact, digest: "not-a-digest" } },
      { projectId, parent, childRunId, childDecisionId, artifact: { ...candidateArtifact, encodedBytes: 0 } },
    ]) {
      await expect(aliases.bind(request)).rejects.toThrow();
    }
    expect(() => new FactoryChildArtifacts(database, "foreign-tenant", assurance, artifacts, fences)).toThrow();
  });

  test("a moved ancestry fence stops an existing alias from feeding new parent work", async () => {
    const original = epochs.get(parentRunId);
    epochs.set(parentRunId, { executionEpoch: 1, cancellationEpoch: 1 });
    try {
      await expect(database.transaction(transaction => aliases.resolveInTransaction(transaction, projectId, parent))).rejects.toMatchObject({ code: "factory_child_artifact_stale" });
      await expect(aliases.bind({ projectId, parent, childRunId, childDecisionId, artifact: candidateArtifact })).rejects.toMatchObject({ code: "factory_child_artifact_stale" });
    } finally { if (original) epochs.set(parentRunId, original); else epochs.delete(parentRunId); }

    epochs.set(childRunId, { executionEpoch: 2, cancellationEpoch: 0 });
    try {
      await expect(database.transaction(transaction => aliases.resolveInTransaction(transaction, projectId, parent))).rejects.toMatchObject({ code: "factory_child_artifact_stale" });
      await expect(aliases.bind({ projectId, parent, childRunId, childDecisionId, artifact: candidateArtifact })).rejects.toMatchObject({ code: "factory_child_artifact_stale" });
    } finally { epochs.delete(childRunId); }

    await database.execute(sql`UPDATE factory_child_runs SET state='uncertain' WHERE tenant_id=${tenantId} AND parent_run_id=${parentRunId}`);
    try { await expect(database.transaction(transaction => aliases.resolveInTransaction(transaction, projectId, parent))).rejects.toMatchObject({ code: "factory_child_artifact_stale" }); }
    finally { await database.execute(sql`UPDATE factory_child_runs SET state='open' WHERE tenant_id=${tenantId} AND parent_run_id=${parentRunId}`); }

    expect(await database.transaction(transaction => aliases.resolveInTransaction(transaction, projectId, parent))).toMatchObject({ childRunId });
    await expect(database.transaction(transaction => aliases.resolveInTransaction(transaction, projectId, { ...parent, attemptId: "child-artifact-other-attempt" }))).rejects.toMatchObject({ code: "factory_child_artifact_foreign" });
  });

  test("a tampered alias row or child binding fails closed", async () => {
    const stored = rows<{ alias_digest: string; child_candidate_digest: string }>(await database.execute(sql`SELECT alias_digest, child_candidate_digest FROM factory_child_artifact_aliases WHERE tenant_id=${tenantId} AND parent_run_id=${parentRunId}`))[0]!;
    await database.execute(sql`UPDATE factory_child_artifact_aliases SET child_candidate_digest=${digest("2")} WHERE tenant_id=${tenantId} AND parent_run_id=${parentRunId}`);
    try { await expect(database.transaction(transaction => aliases.resolveInTransaction(transaction, projectId, parent))).rejects.toMatchObject({ code: "factory_child_artifact_corrupt" }); }
    finally { await database.execute(sql`UPDATE factory_child_artifact_aliases SET child_candidate_digest=${stored.child_candidate_digest} WHERE tenant_id=${tenantId} AND parent_run_id=${parentRunId}`); }

    const binding = rows<{ binding_digest: string }>(await database.execute(sql`SELECT binding_digest FROM factory_child_runs WHERE tenant_id=${tenantId} AND parent_run_id=${parentRunId}`))[0]!;
    await database.execute(sql`UPDATE factory_child_runs SET binding_digest=${digest("3")} WHERE tenant_id=${tenantId} AND parent_run_id=${parentRunId}`);
    try { await expect(database.transaction(transaction => aliases.resolveInTransaction(transaction, projectId, parent))).rejects.toMatchObject({ code: "factory_child_artifact_corrupt" }); }
    finally { await database.execute(sql`UPDATE factory_child_runs SET binding_digest=${binding.binding_digest} WHERE tenant_id=${tenantId} AND parent_run_id=${parentRunId}`); }

    expect(await database.transaction(transaction => aliases.resolveInTransaction(transaction, projectId, parent))).toMatchObject({ aliasDigest: stored.alias_digest });
  });
}
