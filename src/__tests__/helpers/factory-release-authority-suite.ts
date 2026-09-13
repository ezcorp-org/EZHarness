import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { FactoryArtifactReference, FactoryRunnerOperationResult, FactoryRunnerRequest, FactoryRunnerResult, RunnerReference } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { digestBytes, digestObject, FileBlobStore } from "../../extensions/v4/blobs";
import { FactoryArtifacts, FactoryArtifactError } from "../../factory/artifacts";
import type { FactoryAcceptedRelease } from "../../factory/assurance";
import { FactoryExecutionJournal, type FactoryAttemptAdmission } from "../../factory/executions";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { lockFactoryScope } from "../../factory/locks";
import { FactoryRecords } from "../../factory/records";
import { FactoryReleaseAuthorityError, FactoryReleaseAuthorityStore, type FactoryReleaseRunLifecycle } from "../../factory/release-authority";
import type { FactoryRunFence } from "../../factory/run-lifecycle";

interface Fixture { readonly db: TransactionalDb; close(): Promise<void> }

export function factoryReleaseAuthorityConformance(createFixture: () => Promise<Fixture>): void {
const tenantId = "release-authority-tenant";
const projectId = "release-authority-project";
const runId = "release-authority-run";
const now = Date.UTC(2035, 0, 1);
const deadlineAtMs = now + 60_000;
const definitionDigest = `sha256:${"d".repeat(64)}`;
const validatorTrustDigest = `sha256:${"v".repeat(64).replaceAll("v", "a")}`;
const admin: FactoryPrincipal = { kind: "user", id: "release-authority-admin", authentication: "session" };
const apiAdmin: FactoryPrincipal = { ...admin, authentication: "api-key" };
const service: FactoryPrincipal = { kind: "service", id: "release-authority-service", authentication: "service" };
const packageLock: RunnerReference = { package: "@ezcorp/release-runner", version: "1.2.3", digest: `sha256:${"b".repeat(64)}`, export: "run" };

let fixture: Fixture;
let database: TransactionalDb;
let grants: FactoryGrants;
let artifacts: FactoryArtifacts;
let journal: FactoryExecutionJournal;
let authorityStore: FactoryReleaseAuthorityStore;
let artifactRoot: string;
const lifecycleStatus: FactoryRunFence["status"] = "running";
let lifecycleCancellationEpoch = 0;

class DurableLifecycle implements FactoryReleaseRunLifecycle {
  readonly tenantId = tenantId;
  async authorizeRunInTransaction(transaction: MigrationDb, key: { projectId: string; runId: string }): Promise<FactoryRunFence> {
    const installation = await lockFactoryScope(transaction, tenantId, key.projectId);
    const run = rows<{ definition_digest: string; execution_epoch: number | string }>(await transaction.execute(sql`SELECT definition_digest,execution_epoch FROM factory_runs WHERE tenant_id=${tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} FOR UPDATE`))[0];
    if (!installation || !run || Number(run.execution_epoch) !== installation.executionEpoch || lifecycleStatus !== "running") throw new Error("durable lifecycle stopped");
    await grants.authorizeInTransaction(transaction, apiAdmin, key.projectId, "factory.run", 1);
    return { tenantId, projectId: key.projectId, runId: key.runId, executionEpoch: Number(run.execution_epoch), cancellationEpoch: lifecycleCancellationEpoch, grantRevision: 1, revision: 1, deadlineAtMs, definitionDigest: run.definition_digest, status: lifecycleStatus };
  }
}
const lifecycle = new DurableLifecycle();

const raw = (value: Uint8Array) => digestBytes(value);
const outputBytes = (label: string) => new TextEncoder().encode(canonicalJson({ label }));
const scope = { tenantId, projectId, logicalRunId: runId, interpreterId: "worker-interpreter" };

function makeAdmission(candidateGeneration: number, nodeInstanceId: string, attemptId = `attempt-${nodeInstanceId}-${candidateGeneration}`): FactoryAttemptAdmission {
  const base = { attemptId, tenantId, projectId, runId, nodeInstanceId, candidateGeneration, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: lifecycleCancellationEpoch, deadlineAt: new Date(deadlineAtMs) };
  const { deadlineAt: _deadlineAt, ...wireAuthority } = base;
  const request: FactoryRunnerRequest = { schemaVersion: "factory.runner.request.v1", authority: { ...wireAuthority, deadlineAtMs, nextOperationIndex: 0 }, runner: packageLock, input: { kind: "inline", value: { candidateGeneration, nodeInstanceId } }, grants: [], resources: {}, tools: [], broker: { attemptToken: `token-${attemptId}`, audience: "factory-gateway" } };
  const requestDigest = factoryRunnerRequestDigest(request);
  return { ...base, requestDigest, request };
}

function completedResult(output: FactoryArtifactReference, operations: readonly FactoryRunnerOperationResult[] = [], usage = { kind: "measured" as const, inputTokens: 0, outputTokens: 0, computeMs: 0, costMicros: "0" }): Extract<FactoryRunnerResult, { status: "completed" }> {
  const journalCursor = operations.length ? operations[operations.length - 1]!.operationIndex : -1;
  return { schemaVersion: "factory.runner.result.v1", status: "completed", journalCursor, operations, resultDigest: output.digest.slice("sha256:".length), output, usage, workspaceCheckpoint: { ...output, journalCursor } };
}

async function admit(candidateGeneration: number, nodeInstanceId: string, attemptId?: string): Promise<FactoryAttemptAdmission> {
  const admission = makeAdmission(candidateGeneration, nodeInstanceId, attemptId);
  await journal.admit(admission);
  return admission;
}

async function commitCandidate(admission: FactoryAttemptAdmission, label: string, expectedCurrentGeneration: number | null, resultTransform?: (result: Extract<FactoryRunnerResult, { status: "completed" }>, output: FactoryArtifactReference) => FactoryRunnerResult) {
  return database.transaction(async transaction => {
    const content = outputBytes(label);
    const output = await artifacts.stageCandidateOutputInTransaction(transaction, scope, admission.nodeInstanceId, admission.candidateGeneration, content);
    const result = completedResult(output);
    return authorityStore.completeCurrentCandidateInTransaction(transaction, { authority: admission, result: resultTransform?.(result, output) ?? result, expectedCurrentGeneration });
  });
}

beforeAll(async () => {
  fixture = await createFixture(); database = fixture.db;
  const records = new FactoryRecords(database, tenantId); await records.bindInstallation();
  await database.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Release authority','/tmp/release-authority')`);
  await database.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${admin.id},'release-authority@example.test','x','Release authority','admin')`);
  await database.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('release-authority-member',${projectId},${admin.id},'owner')`);
  await database.execute(sql`INSERT INTO service_accounts(id,name,created_by_user_id,project_id,max_tokens_per_day,expires_at) VALUES (${service.id},'Release authority service',${admin.id},${projectId},100,${new Date(deadlineAtMs)})`);
  await records.bindProject(projectId);
  await records.createRun({ projectId, runId, definitionDigest, interpreterBuild: "release-authority-v1", executionEpoch: 1, input: {}, principalId: admin.id }, async () => {});
  grants = new FactoryGrants(database, tenantId, () => now);
  await grants.set(admin, { projectId, principal: admin, action: "factory.run", expectedRevision: 0, expiresAtMs: null });
  await grants.set(admin, { projectId, principal: admin, action: "factory.trust", expectedRevision: 0, expiresAtMs: null });
  artifactRoot = await mkdtemp(join(tmpdir(), "factory-release-authority-"));
  artifacts = new FactoryArtifacts(database, new FileBlobStore(artifactRoot), tenantId);
  journal = new FactoryExecutionJournal(database, async (transaction, current) => {
    const fence = await lifecycle.authorizeRunInTransaction(transaction, { projectId: current.projectId, runId: current.runId });
    if (current.tenantId !== fence.tenantId || current.executionEpoch !== fence.executionEpoch || current.cancellationEpoch !== fence.cancellationEpoch || current.grantRevision !== fence.grantRevision || current.deadlineAt.getTime() > fence.deadlineAtMs) throw new Error("attempt lifecycle changed");
  }, () => new Date(now));
  authorityStore = new FactoryReleaseAuthorityStore(database, tenantId, grants, lifecycle, journal, artifacts);
});

afterAll(async () => { await fixture?.close(); if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true }); });

test("migration is idempotent and release authority is disabled by default", async () => {
  const { up } = await import("../../db/migrations/add-factory-release-authority"); await up(database); await up(database);
  const names = rows<{ table_name: string }>(await database.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('factory_execution_terminals','factory_release_trust_revisions','factory_release_trust_current','factory_release_controls','factory_release_candidate_history','factory_release_current_candidates') ORDER BY table_name`)).map(row => row.table_name);
  expect(names).toHaveLength(6);
  await expect(database.transaction(tx => authorityStore.lockCurrentInTransaction(tx, tenantId, projectId, runId, "node-default"))).rejects.toMatchObject({ code: "factory_release_disabled" });
  expect(() => new FactoryReleaseAuthorityStore(database, "foreign-tenant", grants, lifecycle, journal, artifacts)).toThrow(FactoryReleaseAuthorityError);
});

test("only a human session can publish exact package and validator trust", async () => {
  await expect(authorityStore.publishTrust(apiAdmin, { projectId, expectedRevision: 0, packageLock, validatorTrustDigest }, "trust-api")).rejects.toMatchObject({ code: "factory_release_authority_human_required" });
  await expect(authorityStore.publishTrust(service, { projectId, expectedRevision: 0, packageLock, validatorTrustDigest }, "trust-service")).rejects.toMatchObject({ code: "factory_release_authority_human_required" });
  await expect(authorityStore.publishTrust(admin, { projectId, expectedRevision: 0, packageLock: { ...packageLock, version: "latest" }, validatorTrustDigest }, "trust-floating")).rejects.toMatchObject({ code: "factory_release_authority_invalid" });
  const trusted = await authorityStore.publishTrust(admin, { projectId, expectedRevision: 0, packageLock, validatorTrustDigest }, "trust-v1");
  expect(trusted).toMatchObject({ revision: 1, state: "active", packageLock, validatorTrustDigest, approvalGrantRevision: 1 });
  expect(await authorityStore.publishTrust(admin, { projectId, expectedRevision: 0, packageLock, validatorTrustDigest }, "trust-v1")).toEqual(trusted);
  await expect(authorityStore.publishTrust(admin, { projectId, expectedRevision: 0, packageLock, validatorTrustDigest }, "trust-stale")).rejects.toMatchObject({ code: "factory_release_trust_conflict" });
});

test("enablement is explicit, epoch fenced, and first-write races have one winner", async () => {
  const outcomes = await Promise.allSettled([
    authorityStore.setReleaseEnabled(admin, projectId, true, 0, "enable-a"),
    authorityStore.setReleaseEnabled(admin, projectId, true, 0, "enable-b"),
  ]);
  expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(item => item.status === "rejected")).toHaveLength(1);
  await expect(authorityStore.setReleaseEnabled(admin, projectId, true, 1, "enable-no-change")).rejects.toMatchObject({ code: "factory_release_control_conflict" });
});

test("terminal completion binds exact durable request, settled evidence, measured usage, and output bytes", async () => {
  const unresolved = await admit(10, "node-unresolved");
  const operation = { operationId: `${runId}:node-unresolved:10:0`, operationIndex: 0, kind: "model" as const, requestDigest: "c".repeat(64) };
  await journal.prepare(unresolved, operation);
  await expect(commitCandidate(unresolved, "unresolved", null)).rejects.toThrow("settled journal evidence");
  expect(rows(await database.execute(sql`SELECT attempt_id FROM factory_execution_terminals WHERE attempt_id=${unresolved.attemptId}`))).toHaveLength(0);

  const measured = await admit(11, "node-measured");
  const measuredOperation = { ...operation, operationId: `${runId}:node-measured:11:0` };
  await journal.prepare(measured, measuredOperation); await journal.dispatch(measured, measuredOperation.operationId);
  const operationUsage = { kind: "measured" as const, inputTokens: 1, outputTokens: 2, computeMs: 3, costMicros: "4" };
  const checkpoint = { artifactId: "checkpoint-evidence", digest: `sha256:${"e".repeat(64)}`, encodedBytes: 1, journalCursor: 0 };
  await journal.settle(measured, measuredOperation.operationId, "completed", { resultDigest: "f".repeat(64), result: { done: true }, usage: operationUsage, workspaceCheckpoint: checkpoint });
  const operationResult: FactoryRunnerOperationResult = { ...measuredOperation, state: "completed", resultDigest: "f".repeat(64), usage: operationUsage, workspaceCheckpoint: checkpoint };
  await expect(commitCandidate(measured, "measured", null, (result, output) => ({ ...completedResult(output, [operationResult]), usage: { ...operationUsage, costMicros: "5" } }))).rejects.toThrow("measured usage");
  const committed = await database.transaction(async transaction => {
    const bytes = outputBytes("measured");
    const output = await artifacts.stageCandidateOutputInTransaction(transaction, scope, measured.nodeInstanceId, measured.candidateGeneration, bytes);
    return authorityStore.completeCurrentCandidateInTransaction(transaction, { authority: measured, result: completedResult(output, [operationResult], operationUsage), expectedCurrentGeneration: null });
  });
  expect(committed).toMatchObject({ candidateGeneration: 11, candidateDigest: `sha256:${raw(outputBytes("measured"))}`, pointerRevision: 1 });
});

test("candidate slots separate nodes and generations and deny a foreign-node terminal", async () => {
  const first = await admit(0, "node-a");
  const secondNode = await admit(0, "node-b");
  const firstResult = await commitCandidate(first, "node-a-zero", null);
  const secondResult = await commitCandidate(secondNode, "node-b-zero", null);
  expect(firstResult.candidateDigest).not.toBe(secondResult.candidateDigest);
  const next = await admit(1, "node-a");
  expect(await commitCandidate(next, "node-a-one", 0)).toMatchObject({ candidateGeneration: 1, pointerRevision: 2 });
  expect(await commitCandidate(next, "node-a-one", 0)).toMatchObject({ candidateGeneration: 1, pointerRevision: 2 });

  const foreign = await admit(2, "node-foreign");
  await expect(database.transaction(async transaction => {
    const output = await artifacts.stageCandidateOutputInTransaction(transaction, scope, "different-node", 2, outputBytes("foreign-slot"));
    return authorityStore.completeCurrentCandidateInTransaction(transaction, { authority: foreign, result: completedResult(output), expectedCurrentGeneration: null });
  })).rejects.toThrow("terminal output is unavailable");
  const artifactSlots = rows<{ candidate_node_instance_id: string; candidate_generation: number | string }>(await database.execute(sql`SELECT candidate_node_instance_id,candidate_generation FROM factory_artifacts WHERE kind='candidate_output' AND candidate_node_instance_id IN ('node-a','node-b') ORDER BY candidate_node_instance_id,candidate_generation`));
  expect(artifactSlots.map(row => [row.candidate_node_instance_id, Number(row.candidate_generation)])).toEqual([["node-a", 0], ["node-a", 1], ["node-b", 0]]);
});

test("candidate pointer CAS and lifecycle cancellation serialize with terminal completion", async () => {
  const lower = await admit(20, "node-race");
  const upper = await admit(21, "node-race");
  const outcomes = await Promise.allSettled([commitCandidate(lower, "race-lower", null), commitCandidate(upper, "race-upper", null)]);
  expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(item => item.status === "rejected")).toHaveLength(1);
  expect(rows(await database.execute(sql`SELECT candidate_generation FROM factory_release_current_candidates WHERE node_instance_id='node-race'`))).toHaveLength(1);

  const cancelled = await admit(30, "node-cancelled");
  lifecycleCancellationEpoch = 1;
  await expect(commitCandidate(cancelled, "cancelled", null)).rejects.toMatchObject({ code: "factory_release_authority_stale" });
  lifecycleCancellationEpoch = 0;
  expect(rows(await database.execute(sql`SELECT attempt_id FROM factory_execution_terminals WHERE attempt_id=${cancelled.attemptId}`))).toHaveLength(0);
});

test("candidate audit failure rolls back terminal, history, pointer, and artifact rows", async () => {
  const admission = await admit(31, "node-audit-fault");
  await database.execute(sql`CREATE FUNCTION reject_candidate_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='factory.release.candidate.current' THEN RAISE EXCEPTION 'candidate audit unavailable'; END IF; RETURN NEW; END $$`);
  await database.execute(sql`CREATE TRIGGER reject_candidate_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_candidate_audit()`);
  await expect(commitCandidate(admission, "candidate-audit", null)).rejects.toThrow();
  await database.execute(sql`DROP TRIGGER reject_candidate_audit ON audit_log`); await database.execute(sql`DROP FUNCTION reject_candidate_audit()`);
  expect(rows(await database.execute(sql`SELECT attempt_id FROM factory_execution_terminals WHERE attempt_id=${admission.attemptId}`))).toHaveLength(0);
  expect(rows(await database.execute(sql`SELECT attempt_id FROM factory_release_candidate_history WHERE attempt_id=${admission.attemptId}`))).toHaveLength(0);
  expect(rows(await database.execute(sql`SELECT object_id FROM factory_artifacts WHERE candidate_node_instance_id='node-audit-fault'`))).toHaveLength(0);
});

test("current lookup verifies live lifecycle, control, trust grant, and sealed terminal history", async () => {
  const current = await database.transaction(tx => authorityStore.lockCurrentInTransaction(tx, tenantId, projectId, runId, "node-a"));
  expect(current).toMatchObject({ nodeInstanceId: "node-a", candidateGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, releaseEnableEpoch: 1, status: "running", validatorTrustDigest });
  await expect(database.transaction(tx => authorityStore.lockCurrentInTransaction(tx, tenantId, projectId, runId, "node-bogus"))).rejects.toMatchObject({ code: "factory_release_authority_stale" });
  const attemptId = rows<{ attempt_id: string }>(await database.execute(sql`SELECT attempt_id FROM factory_release_current_candidates WHERE node_instance_id='node-a'`))[0]!.attempt_id;
  const original = rows<{ output_artifact_id: string }>(await database.execute(sql`SELECT output_artifact_id FROM factory_execution_terminals WHERE attempt_id=${attemptId}`))[0]!.output_artifact_id;
  const replacement = rows<{ object_id: string }>(await database.execute(sql`SELECT object_id FROM factory_artifacts WHERE candidate_node_instance_id='node-b'`))[0]!.object_id;
  await database.execute(sql`UPDATE factory_execution_terminals SET output_artifact_id=${replacement} WHERE attempt_id=${attemptId}`);
  await expect(database.transaction(tx => authorityStore.lockCurrentInTransaction(tx, tenantId, projectId, runId, "node-a"))).rejects.toMatchObject({ code: "factory_release_candidate_corrupt" });
  await database.execute(sql`UPDATE factory_execution_terminals SET output_artifact_id=${original} WHERE attempt_id=${attemptId}`);
  lifecycleCancellationEpoch = 1;
  await expect(database.transaction(tx => authorityStore.lockCurrentInTransaction(tx, tenantId, projectId, runId, "node-a"))).rejects.toMatchObject({ code: "factory_release_authority_stale" });
  lifecycleCancellationEpoch = 0;
});

test("pinned material comes from the exact accepted decision and evidence set", async () => {
  const current = await database.transaction(tx => authorityStore.lockCurrentInTransaction(tx, tenantId, projectId, runId, "node-a"));
  const contractDigest = `sha256:${"c".repeat(64)}`;
  const evidenceDigest = `sha256:${"e".repeat(64)}`;
  await database.execute(sql`INSERT INTO factory_acceptance_contracts(tenant_id,project_id,contract_id,revision,contract_digest,validator_lock_digest,mandatory_claims,claim_groups,approved_by,approval_grant_revision,protected_snapshot_digest) VALUES (${tenantId},${projectId},'release-authority-contract',1,${contractDigest},${validatorTrustDigest},'[]','[]',${admin.id},1,${`sha256:${"9".repeat(64)}`})`);
  await database.execute(sql`INSERT INTO factory_acceptance_decisions(tenant_id,project_id,decision_id,contract_id,contract_revision,contract_digest,contract_snapshot_digest,candidate_digest,evidence_set_digest,decision_digest,run_id,node_instance_id,candidate_generation,execution_epoch,cancellation_epoch) VALUES (${tenantId},${projectId},'release-authority-decision','release-authority-contract',1,${contractDigest},${`sha256:${"9".repeat(64)}`},${current.candidateDigest},${`sha256:${digestObject([evidenceDigest])}`},${`sha256:${"7".repeat(64)}`},${runId},'node-a',1,1,0)`);
  await database.execute(sql`INSERT INTO factory_acceptance_evidence(tenant_id,project_id,evidence_id,run_id,node_instance_id,candidate_generation,candidate_digest,validator_id,validator_lock_digest,issuer_grant_revision,artifact_id,artifact_digest,artifact_bytes,environment_digest,configuration_digest,runner_digest,claims,issued_at_ms,expires_at_ms,evidence_digest) VALUES (${tenantId},${projectId},'release-authority-evidence',${runId},'node-a',1,${current.candidateDigest},'validator-a',${validatorTrustDigest},1,'evidence-artifact',${`sha256:${"6".repeat(64)}`},12,${`sha256:${"5".repeat(64)}`},${`sha256:${"4".repeat(64)}`},${`sha256:${"3".repeat(64)}`},'[]',${now - 1},${deadlineAtMs},${evidenceDigest})`);
  const accepted: FactoryAcceptedRelease = { projectId, runId, nodeInstanceId: "node-a", candidateGeneration: 1, decisionId: "release-authority-decision", candidateDigest: current.candidateDigest, contractDigest, executionEpoch: 1, cancellationEpoch: 0, approvalDecision: {} };
  const material = await database.transaction(tx => authorityStore.readPinnedInTransaction(tx, tenantId, accepted));
  expect(material).toMatchObject({ decisionId: accepted.decisionId, validatorTrustDigest, evidence: [{ evidenceId: "release-authority-evidence", evidenceDigest }] });
  await database.execute(sql`UPDATE factory_acceptance_evidence SET evidence_digest=${`sha256:${"1".repeat(64)}`} WHERE evidence_id='release-authority-evidence'`);
  await expect(database.transaction(tx => authorityStore.readPinnedInTransaction(tx, tenantId, accepted))).rejects.toMatchObject({ code: "factory_release_material_stale" });
  await database.execute(sql`UPDATE factory_acceptance_evidence SET evidence_digest=${evidenceDigest} WHERE evidence_id='release-authority-evidence'`);
  await expect(database.transaction(tx => authorityStore.readPinnedInTransaction(tx, tenantId, { ...accepted, nodeInstanceId: "node-b" }))).rejects.toMatchObject({ code: "factory_release_material_stale" });
});

test("audit faults roll back trust and candidate facts, and revocation disables prior candidates", async () => {
  await database.execute(sql`CREATE FUNCTION reject_release_authority_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='factory.release.trust.published' THEN RAISE EXCEPTION 'authority audit unavailable'; END IF; RETURN NEW; END $$`);
  await database.execute(sql`CREATE TRIGGER reject_release_authority_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_release_authority_audit()`);
  await expect(authorityStore.publishTrust(admin, { projectId, expectedRevision: 1, packageLock: { ...packageLock, version: "1.2.4" }, validatorTrustDigest }, "trust-audit-fault")).rejects.toThrow();
  await database.execute(sql`DROP TRIGGER reject_release_authority_audit ON audit_log`); await database.execute(sql`DROP FUNCTION reject_release_authority_audit()`);
  expect(rows(await database.execute(sql`SELECT revision FROM factory_release_trust_revisions WHERE revision=2`))).toHaveLength(0);
  const revoked = await authorityStore.revokeTrust(admin, projectId, 1, "trust-revoke");
  expect(revoked).toMatchObject({ revision: 2, state: "revoked" });
  await expect(database.transaction(tx => authorityStore.lockCurrentInTransaction(tx, tenantId, projectId, runId, "node-a"))).rejects.toMatchObject({ code: "factory_release_trust_inactive" });
  await expect(authorityStore.revokeTrust(admin, projectId, 1, "trust-revoke-stale")).rejects.toMatchObject({ code: "factory_release_trust_conflict" });
});

test("candidate output references reject malformed, oversized, and cross-slot use", async () => {
  await expect(database.transaction(tx => artifacts.stageCandidateOutputInTransaction(tx, scope, "node-invalid", -1, outputBytes("bad")))).rejects.toBeInstanceOf(FactoryArtifactError);
  await expect(database.transaction(tx => artifacts.stageCandidateOutputInTransaction(tx, scope, "node-large", 0, new Uint8Array(16 * 1024 * 1024 + 1)))).rejects.toMatchObject({ code: "factory_artifact_size_invalid" });
  await expect(artifacts.load(scope, { objectId: "missing", digest: `sha256:${"0".repeat(64)}`, encodedBytes: 16 * 1024 * 1024 + 1 }, ["candidate_output"])).rejects.toMatchObject({ code: "factory_artifact_reference_invalid" });
});
}
