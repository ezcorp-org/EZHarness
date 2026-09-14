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
import { FactoryCandidatePointerAgreement, FactoryGitPublicationMembers, FactoryPublicationProvenance, factoryGitPublicationProvenance, factoryGitPublicationSet } from "../../factory/release-publication-set";
import type { FactoryReleaseMaterial } from "../../factory/releases";
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
const packageLock: RunnerReference = { package: "@ezcorp/release-runner", manifestName: "release-runner", version: "1.2.3", digest: `sha256:${"b".repeat(64)}`, export: "run" };

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
  await expect(authorityStore.publishTrust(admin, { projectId, expectedRevision: 0, packageLock: { ...packageLock, manifestName: "Release-Runner" }, validatorTrustDigest }, "trust-bad-manifest")).rejects.toMatchObject({ code: "factory_release_authority_invalid" });
  await expect(authorityStore.publishTrust(admin, { projectId, expectedRevision: 0, packageLock: { ...packageLock, manifestName: packageLock.package }, validatorTrustDigest }, "trust-scoped-manifest")).rejects.toMatchObject({ code: "factory_release_authority_invalid" });
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

test("trust and release control mutations reject a tampered current seal", async () => {
  const trust = rows<{ protected_digest: string }>(await database.execute(sql`SELECT protected_digest FROM factory_release_trust_revisions WHERE tenant_id=${tenantId} AND project_id=${projectId} AND revision=1`))[0]!;
  await database.execute(sql`UPDATE factory_release_trust_revisions SET protected_digest=${`sha256:${"0".repeat(64)}`} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND revision=1`);
  await expect(authorityStore.publishTrust(admin, { projectId, expectedRevision: 1, packageLock: { ...packageLock, version: "1.2.4" }, validatorTrustDigest }, "trust-over-tamper")).rejects.toMatchObject({ code: "factory_release_trust_corrupt" });
  await database.execute(sql`UPDATE factory_release_trust_revisions SET protected_digest=${trust.protected_digest} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND revision=1`);

  const control = rows<{ protected_digest: string }>(await database.execute(sql`SELECT protected_digest FROM factory_release_controls WHERE tenant_id=${tenantId} AND project_id=${projectId}`))[0]!;
  await database.execute(sql`UPDATE factory_release_controls SET protected_digest=${`sha256:${"0".repeat(64)}`} WHERE tenant_id=${tenantId} AND project_id=${projectId}`);
  await expect(authorityStore.setReleaseEnabled(admin, projectId, false, 1, "control-over-tamper")).rejects.toMatchObject({ code: "factory_release_control_corrupt" });
  await database.execute(sql`UPDATE factory_release_controls SET protected_digest=${control.protected_digest} WHERE tenant_id=${tenantId} AND project_id=${projectId}`);
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
  await expect(journal.prepare(measured, { ...measuredOperation, operationId: `${runId}:node-measured:11:1`, operationIndex: 1 })).rejects.toThrow("stale, cancelled, or expired");
  await expect(journal.dispatch(measured, measuredOperation.operationId)).rejects.toThrow("stale, cancelled, or expired");
});

test("historical terminal reader verifies every stored binding and preserves its immutable result", async () => {
  const admission = await admit(17, "node-terminal-reader");
  const read = () => database.transaction(tx => journal.readCompletedTerminalInTransaction(tx, admission, artifacts));
  await expect(read()).rejects.toThrow("receipt is unavailable");
  await commitCandidate(admission, "terminal-reader", null);
  const receipt = await read();
  expect(receipt.terminal).toMatchObject({ attemptId: admission.attemptId, tenantId, projectId, runId, nodeInstanceId: admission.nodeInstanceId, candidateGeneration: 17 });
  expect(receipt.result.status).toBe("completed");
  expect(receipt.createdAtMs).toBeGreaterThan(0);
  expect(await read()).toEqual(receipt);
  await expect(database.transaction(tx => journal.readCompletedTerminalInTransaction(tx, { ...admission, projectId: "foreign-project" }, artifacts))).rejects.toThrow("receipt is unavailable");
  const original = rows<Record<string, unknown>>(await database.execute(sql`SELECT * FROM factory_execution_terminals WHERE attempt_id=${admission.attemptId}`))[0]!;
  for (const [column, value] of [["node_instance_id", "wrong-node"], ["output_bytes", 1], ["result_json", "{}"], ["terminal_fact_digest", `sha256:${"f".repeat(64)}`], ["request_digest", "e".repeat(64)]] as const) {
    await database.execute(sql`UPDATE factory_execution_terminals SET ${sql.identifier(column)}=${value} WHERE attempt_id=${admission.attemptId}`);
    try { await expect(read()).rejects.toThrow(); }
    finally { await database.execute(sql`UPDATE factory_execution_terminals SET ${sql.identifier(column)}=${original[column]} WHERE attempt_id=${admission.attemptId}`); }
  }
  expect(await read()).toEqual(receipt);
});

test("the publication scope derives one attempt id from the accepted protected receipt", async () => {
  const admission = await admit(0, "node-publication");
  const committed = await commitCandidate(admission, "publication", null);
  const verified = await database.transaction(tx => authorityStore.readVerifiedCandidateInTransaction(tx, tenantId, { projectId, runId, nodeInstanceId: "node-publication", candidateGeneration: 0 }));
  // The candidate pointer holds the attempt the provenance wrote, not anything a caller passed.
  expect(verified).toMatchObject({ attemptId: admission.attemptId, candidateGeneration: 0, candidateDigest: committed.candidateDigest });
  expect(verified.artifact).toMatchObject({ digest: committed.candidateDigest });
  const candidateArtifactId = verified.artifact.artifactId;
  expect(Object.isFrozen(verified)).toBe(true);
  await expect(database.transaction(tx => authorityStore.readVerifiedCandidateInTransaction(tx, "foreign-tenant", { projectId, runId, nodeInstanceId: "node-publication", candidateGeneration: 0 }))).rejects.toMatchObject({ code: "factory_release_authority_scope" });
  await expect(database.transaction(tx => authorityStore.readVerifiedCandidateInTransaction(tx, tenantId, { projectId, runId, nodeInstanceId: "node-publication", candidateGeneration: 1 }))).rejects.toMatchObject({ code: "factory_release_authority_stale" });
  await expect(database.transaction(tx => authorityStore.readVerifiedCandidateInTransaction(tx, tenantId, { projectId, runId, nodeInstanceId: "node-never-committed", candidateGeneration: 0 }))).rejects.toMatchObject({ code: "factory_release_authority_stale" });

  // The shared resolver, with the git member half and the candidate pointer as the agreement check.
  const scopes = factoryGitPublicationProvenance({ database, tenantId, authority: authorityStore });
  const material: FactoryReleaseMaterial = { decisionId: "decision-publication", evidence: [{ note: "one evidence reference" }], packageTrustDigest: `sha256:${"a".repeat(64)}`, validatorTrustDigest };
  const operationId = `factory-release:${"b".repeat(64)}`;
  await expect(scopes.sourcesFor(tenantId, operationId, material)).rejects.toMatchObject({ code: "factory_publication_provenance_missing" });
  await expect(scopes.sourcesFor("foreign-tenant", operationId, material)).rejects.toMatchObject({ code: "factory_publication_provenance_untrusted" });
  expect(() => factoryGitPublicationProvenance({ database, tenantId, scanLimit: 0 })).toThrow("factory_publication_provenance_invalid");
  expect(() => factoryGitPublicationProvenance({ database, tenantId, scanLimit: 513 })).toThrow("factory_publication_provenance_invalid");

  // One release operation row, identical to what `prepare` writes, without the release store. The
  // contract and decision rows exist only to satisfy the operation's foreign keys.
  const contractDigest = `sha256:${"c".repeat(64)}`;
  await database.execute(sql`INSERT INTO factory_acceptance_contracts (tenant_id,project_id,contract_id,revision,contract_digest,validator_lock_digest,mandatory_claims,claim_groups,approved_by,approval_grant_revision) VALUES (${tenantId},${projectId},'contract-publication',1,${contractDigest},${validatorTrustDigest},'[]','[]',${admin.id},1)`);
  await database.execute(sql`INSERT INTO factory_acceptance_decisions (tenant_id,project_id,decision_id,contract_id,contract_revision,contract_digest,candidate_digest,evidence_set_digest,decision_digest,run_id,node_instance_id,candidate_generation,execution_epoch,cancellation_epoch) VALUES (${tenantId},${projectId},'decision-publication','contract-publication',1,${contractDigest},${committed.candidateDigest},${`sha256:${"7".repeat(64)}`},${`sha256:${"8".repeat(64)}`},${runId},'node-publication',0,1,${lifecycleCancellationEpoch})`);
  await database.execute(sql`INSERT INTO factory_release_operations (tenant_id,project_id,operation_id,run_id,node_instance_id,candidate_generation,candidate_digest,decision_id,contract_digest,execution_epoch,cancellation_epoch,release_enable_epoch,action,destination_provider,destination_account,destination_object,destination_digest,canonical_request,request_digest,material_json,material_digest,estimated_spend_micros,deadline_ms,state) VALUES (${tenantId},${projectId},${operationId},${runId},'node-publication',0,${committed.candidateDigest},'decision-publication',${contractDigest},1,${lifecycleCancellationEpoch},1,'publish','github','ezcorp-org/repository','pull-request',${`sha256:${"d".repeat(64)}`},'{}',${`sha256:${"e".repeat(64)}`},'{}',${`sha256:${"f".repeat(64)}`},0,${deadlineAtMs},'pending')`);

  // With no accepted protected receipt the attempt has no derivation at all, so publication stays
  // pending rather than archiving against a guessed scope.
  await expect(scopes.sourcesFor(tenantId, operationId, material)).rejects.toMatchObject({ code: "factory_publication_provenance_missing" });

  const taskCommandId = `task-${admission.attemptId}`;
  const acceptanceCommandId = "acceptance-decision-publication";
  const receipt = {
    schemaVersion: "factory.protected-command-receipt.v1", kind: "request-acceptance", outcome: "accepted",
    reference: { ...scope, commandId: acceptanceCommandId },
    source: { nodeInstanceId: "node-publication", candidateGeneration: 0, attempt: { commandId: taskCommandId, stopped: true, uncertain: false } },
    decision: { decisionId: "decision-publication", nodeInstanceId: "node-publication", candidateGeneration: 0, candidateDigest: committed.candidateDigest },
  };
  // A transition command needs the audit batch its source sequence names.
  await database.execute(sql`INSERT INTO factory_audit_batches(tenant_id,project_id,run_id,interpreter_id,source_sequence,sequence,digest,payload) VALUES (${tenantId},${projectId},${runId},${scope.interpreterId},1,1,${contractDigest},'{}') ON CONFLICT DO NOTHING`);
  const writeReceipt = async (commandId: string, body: unknown) => {
    await database.execute(sql`INSERT INTO factory_transition_commands(tenant_id,project_id,run_id,interpreter_id,command_id,source_sequence,command_digest) VALUES (${tenantId},${projectId},${runId},${scope.interpreterId},${commandId},1,${contractDigest}) ON CONFLICT DO NOTHING`);
    await database.execute(sql`INSERT INTO factory_protected_command_effects(tenant_id,project_id,run_id,interpreter_id,command_id,kind,command_digest,receipt_json,receipt_digest,decision) VALUES (${tenantId},${projectId},${runId},${scope.interpreterId},${commandId},'request-acceptance',${contractDigest},${JSON.stringify(body)},${`sha256:${"5".repeat(64)}`},'accepted')`);
  };
  // The task command the receipt's source names must exist before a completion can reference it.
  await database.execute(sql`INSERT INTO factory_transition_commands(tenant_id,project_id,run_id,interpreter_id,command_id,source_sequence,command_digest) VALUES (${tenantId},${projectId},${runId},${scope.interpreterId},${taskCommandId},1,${contractDigest}) ON CONFLICT DO NOTHING`);
  await writeReceipt(acceptanceCommandId, receipt);

  // The receipt exists, but nothing turns its command into an attempt yet.
  await expect(scopes.sourcesFor(tenantId, operationId, material)).rejects.toMatchObject({ code: "factory_publication_provenance_missing" });
  await database.execute(sql`INSERT INTO factory_task_completions(tenant_id,project_id,run_id,interpreter_id,command_id,attempt_id,input_digest,authority_json,receipt_json,receipt_digest) VALUES (${tenantId},${projectId},${runId},${scope.interpreterId},${taskCommandId},${admission.attemptId},${contractDigest},'{}','{}',${`sha256:${"6".repeat(64)}`})`);

  // Still nothing to read: the candidate artifact is not a sealed material for that attempt.
  await expect(scopes.sourcesFor(tenantId, operationId, material)).rejects.toMatchObject({ code: "factory_publication_provenance_missing" });
  await database.execute(sql`INSERT INTO factory_artifact_materials (tenant_id,project_id,run_id,attempt_id,operation_id,object_name,version,media_type,digest,total_bytes,chunk_count,storage_version,sealed,object_id) VALUES (${tenantId},${projectId},${runId},${admission.attemptId},'material-operation-1','candidate',1,'application/octet-stream',${committed.candidateDigest},1,1,'v1',TRUE,${candidateArtifactId})`);

  const resolved = await scopes.sourcesFor(tenantId, operationId, material);
  expect(resolved.scope).toEqual({ tenantId, projectId, runId, attemptId: admission.attemptId, operationId: "material-operation-1" });
  expect(resolved.candidate).toEqual(verified.artifact);
  // The receipt and the candidate pointer are two independent derivations, and they agree.
  expect(await scopes.attemptFor({ tenantId, projectId, runId, nodeInstanceId: "node-publication", candidateGeneration: 0, candidateDigest: committed.candidateDigest, decisionId: "decision-publication" } as never)).toBe(admission.attemptId);

  // A sealed material another real attempt wrote is never reachable through this operation's scope.
  const other = await admit(0, "node-publication-other");
  await database.execute(sql`UPDATE factory_artifact_materials SET attempt_id=${other.attemptId} WHERE object_id=${candidateArtifactId}`);
  await expect(scopes.sourcesFor(tenantId, operationId, material)).rejects.toMatchObject({ code: "factory_publication_provenance_missing" });
  await database.execute(sql`UPDATE factory_artifact_materials SET attempt_id=${admission.attemptId} WHERE object_id=${candidateArtifactId}`);

  // An operation whose candidate digest no longer matches the receipt is refused.
  await database.execute(sql`UPDATE factory_release_operations SET candidate_digest=${`sha256:${"9".repeat(64)}`} WHERE operation_id=${operationId}`);
  await expect(scopes.sourcesFor(tenantId, operationId, material)).rejects.toMatchObject({ code: "factory_publication_provenance_untrusted" });
  await database.execute(sql`UPDATE factory_release_operations SET candidate_digest=${committed.candidateDigest} WHERE operation_id=${operationId}`);

  // The agreement check is a real second opinion. A reader that answers with another attempt makes
  // the two derivations disagree, and a disagreement is corruption rather than a choice.
  const disagreeing = new FactoryPublicationProvenance({
    database, tenantId, members: new FactoryGitPublicationMembers({ database, tenantId }),
    agreement: { async attemptForCandidate() { return other.attemptId; } },
  });
  await expect(disagreeing.sourcesFor(tenantId, operationId, material)).rejects.toMatchObject({ code: "factory_publication_provenance_untrusted" });

  // And the pointer itself is sealed, so moving it in the database is caught as corruption before
  // the agreement check can even be asked.
  await database.execute(sql`UPDATE factory_release_current_candidates SET attempt_id=${other.attemptId} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${runId} AND node_instance_id='node-publication'`);
  await expect(scopes.sourcesFor(tenantId, operationId, material)).rejects.toMatchObject({ code: "factory_release_candidate_corrupt" });
  await database.execute(sql`UPDATE factory_release_current_candidates SET attempt_id=${admission.attemptId} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND run_id=${runId} AND node_instance_id='node-publication'`);
  // A pointer whose digest no longer matches the operation is refused by the agreement reader.
  const agreement = new FactoryCandidatePointerAgreement({ database, tenantId, authority: authorityStore });
  await expect(agreement.attemptForCandidate({ projectId, runId, nodeInstanceId: "node-publication", candidateGeneration: 0, candidateDigest: `sha256:${"4".repeat(64)}`, decisionId: "decision-publication", canonicalRequest: "{}" })).rejects.toMatchObject({ code: "factory_publication_provenance_untrusted" });
  expect(() => new FactoryCandidatePointerAgreement({ database, tenantId: "foreign-tenant", authority: authorityStore })).toThrow("factory_release_scope");
  // Without the agreement reader the receipt alone is the derivation, and it still resolves.
  expect((await factoryGitPublicationProvenance({ database, tenantId }).sourcesFor(tenantId, operationId, material)).scope.attemptId).toBe(admission.attemptId);

  // The publication set is the seam the archive writer consumes, and it plans the same members.
  const controller = new AbortController(); controller.abort();
  await expect(factoryGitPublicationSet({ database, tenantId, authority: authorityStore }).plan(tenantId, operationId, material, controller.signal)).rejects.toBeInstanceOf(DOMException);
  const planned = await factoryGitPublicationSet({ database, tenantId, authority: authorityStore }).plan(tenantId, operationId, material);
  expect(planned.map(item => item.role)).toEqual(["candidate"]);
  expect(planned[0]).toMatchObject({ memberName: "candidate", scope: resolved.scope, artifact: verified.artifact });
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
  await database.execute(sql`UPDATE factory_release_trust_current SET revision=1 WHERE tenant_id=${tenantId} AND project_id=${projectId}`);
  await expect(database.transaction(tx => authorityStore.lockCurrentInTransaction(tx, tenantId, projectId, runId, "node-a"))).rejects.toMatchObject({ code: "factory_release_trust_corrupt" });
  await database.execute(sql`UPDATE factory_release_trust_current SET revision=2 WHERE tenant_id=${tenantId} AND project_id=${projectId}`);
  await expect(authorityStore.revokeTrust(admin, projectId, 1, "trust-revoke-stale")).rejects.toMatchObject({ code: "factory_release_trust_conflict" });
});

test("candidate output references reject malformed, oversized, and cross-slot use", async () => {
  await expect(database.transaction(tx => artifacts.stageCandidateOutputInTransaction(tx, scope, "node-invalid", -1, outputBytes("bad")))).rejects.toBeInstanceOf(FactoryArtifactError);
  await expect(database.transaction(tx => artifacts.stageCandidateOutputInTransaction(tx, scope, "node-large", 0, new Uint8Array(16 * 1024 * 1024 + 1)))).rejects.toMatchObject({ code: "factory_artifact_size_invalid" });
  await expect(artifacts.load(scope, { objectId: "missing", digest: `sha256:${"0".repeat(64)}`, encodedBytes: 16 * 1024 * 1024 + 1 }, ["candidate_output"])).rejects.toMatchObject({ code: "factory_artifact_reference_invalid" });
});
}
