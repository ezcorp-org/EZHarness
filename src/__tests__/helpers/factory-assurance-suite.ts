import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryRecords } from "../../factory/records";
import { FactoryAssurance, FactoryAssuranceError, type FactoryCandidateKey, type FactoryCurrentCandidateResolver, type FactoryReleaseFenceReader, type FactoryTrustedEvidence, type FactoryTrustedValidatorGateway } from "../../factory/assurance";

interface Fixture { readonly db: TransactionalDb; close(): Promise<void> }
export function factoryAssuranceConformance(createFixture: () => Promise<Fixture>): void {

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const now = Date.UTC(2030, 0, 1);
const tenantId = "assurance-tenant", projectId = "assurance-project";
const admin: FactoryPrincipal = { kind: "user", id: "assurance-admin", authentication: "session" };
const candidate: FactoryCandidateKey = { projectId, runId: "assurance-run", nodeInstanceId: "candidate", candidateGeneration: 1 };
let fixture: Fixture;
let grants: FactoryGrants;
let trusted: FactoryTrustedEvidence;
let fenceStatus: "running" | "cancelling" = "running";
class Gateway implements FactoryTrustedValidatorGateway, FactoryCurrentCandidateResolver {
  async resolveValidatorInTransaction(_transaction: MigrationDb, tenant: string, key: FactoryCandidateKey, validatorId: string): Promise<FactoryTrustedEvidence> {
    if (tenant !== tenantId || key.projectId !== trusted.projectId || key.runId !== trusted.runId || key.nodeInstanceId !== trusted.nodeInstanceId || key.candidateGeneration !== trusted.candidateGeneration || validatorId !== trusted.validatorId) throw new Error("configured validator did not authorize this exact candidate");
    return structuredClone(trusted);
  }
  async resolveCurrentEvidenceInTransaction(_transaction: MigrationDb, tenant: string, key: FactoryCandidateKey, validatorIds: readonly string[]): Promise<readonly FactoryTrustedEvidence[]> {
    if (tenant !== tenantId || key.projectId !== trusted.projectId || key.runId !== trusted.runId || key.nodeInstanceId !== trusted.nodeInstanceId || key.candidateGeneration !== trusted.candidateGeneration || validatorIds.length !== 1 || validatorIds[0] !== trusted.validatorId) throw new Error("current candidate journal does not match");
    return [structuredClone(trusted)];
  }
}
class ReleaseFenceReader implements FactoryReleaseFenceReader {
  async readCurrentInTransaction(_transaction: MigrationDb, tenant: string, currentProjectId: string, runId: string) {
    if (tenant !== tenantId || currentProjectId !== projectId || ![candidate.runId, "assurance-run-2"].includes(runId)) throw new Error("trusted release fence was not found");
    return { runId, executionEpoch: 1, cancellationEpoch: fenceStatus === "running" ? 0 : 1, status: fenceStatus, deadlineMs: now + 1_000 };
  }
}
let assurance: FactoryAssurance;

beforeAll(async () => {
  fixture = await createFixture();
  const records = new FactoryRecords(fixture.db, tenantId); await records.bindInstallation();
  await fixture.db.execute(sql`INSERT INTO projects (id, name, path) VALUES (${projectId}, 'Assurance', '/tmp/assurance')`); await records.bindProject(projectId);
  await fixture.db.execute(sql`INSERT INTO users (id, email, password_hash, name, role) VALUES (${admin.id}, 'admin@example.test', 'x', 'admin', 'admin')`);
  await fixture.db.execute(sql`INSERT INTO users (id, email, password_hash, name, role) VALUES ('tampered-approval-authority', 'tampered@example.test', 'x', 'tampered', 'member')`);
  await fixture.db.execute(sql`INSERT INTO project_members (id, project_id, user_id, role) VALUES ('assurance-member', ${projectId}, ${admin.id}, 'owner')`);
  await records.createRun({ projectId, runId: candidate.runId, definitionDigest: digest("d"), interpreterBuild: "factory-v1", executionEpoch: 1, input: {}, principalId: admin.id }, async () => {});
  grants = new FactoryGrants(fixture.db, tenantId, () => now);
  await grants.set(admin, { projectId, principal: admin, action: "factory.trust", expectedRevision: 0, expiresAtMs: null });
  await grants.set(admin, { projectId, principal: admin, action: "factory.approve", expectedRevision: 0, expiresAtMs: null });
  await grants.set(admin, { projectId, principal: admin, action: "factory.release", expectedRevision: 0, expiresAtMs: null });
  trusted = { ...candidate, validatorId: "protected-validator", validatorLockDigest: digest("b"), issuerGrantRevision: 1, candidateDigest: digest("c"), artifact: { artifactId: "host-issued-artifact", digest: digest("a"), encodedBytes: 42 }, environmentDigest: digest("e"), configurationDigest: digest("f"), runnerDigest: digest("c"), claims: [{ id: "tests", passed: true, decisive: true }, { id: "review", passed: true, decisive: true }], issuedAtMs: now - 1, expiresAtMs: now + 1000 };
  assurance = new FactoryAssurance(fixture.db, tenantId, grants, new Gateway(), new ReleaseFenceReader(), new Gateway(), () => now);
});
afterAll(async () => { await fixture?.close(); });

async function contract() { await assurance.approveContract(admin, { projectId, contractId: "contract", revision: 1, contractDigest: digest("d"), validatorLockDigest: trusted.validatorLockDigest, mandatoryClaims: [{ id: "tests", validatorId: trusted.validatorId, freshnessMs: 100 }, { id: "review", validatorId: trusted.validatorId, freshnessMs: 100 }], claimGroups: [{ id: "all", claimIds: ["tests", "review"], minimumPasses: 2, requireAllDecisive: true }] }); }

async function rejectAudit(work: () => Promise<void>): Promise<void> {
  await fixture.db.execute(sql`CREATE FUNCTION reject_factory_assurance_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'factory assurance audit unavailable'; END $$`);
  await fixture.db.execute(sql`CREATE TRIGGER reject_factory_assurance_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_factory_assurance_audit()`);
  try { await work(); }
  finally {
    await fixture.db.execute(sql`DROP TRIGGER reject_factory_assurance_audit ON audit_log`);
    await fixture.db.execute(sql`DROP FUNCTION reject_factory_assurance_audit()`);
  }
}

test("configured validator evidence binds exact candidate and human-trusted contract", async () => {
  await contract();
  const id = await assurance.captureEvidence({ ...candidate, validatorId: trusted.validatorId });
  expect(id).toBeTruthy();
  const accepted = await assurance.accept({ ...candidate, contractId: "contract", revision: 1 });
  expect(accepted).toMatchObject({ candidateDigest: trusted.candidateDigest, contractDigest: digest("d") });
  await expect(assurance.captureEvidence({ ...candidate, validatorId: "caller-selected-validator" })).rejects.toThrow("configured validator");
});

test("fresh mandatory claims and exact approval context are consumed once", async () => {
  const decision = await assurance.accept({ ...candidate, contractId: "contract", revision: 1 });
  const request = { projectId, operationId: "release-operation", decisionId: decision.decisionId, destinationDigest: digest("e"), expectedGeneration: 4, expiresAtMs: now + 500 };
  const approval = await assurance.requestApproval(admin, request);
  await expect(assurance.decideApproval(admin, projectId, approval.approvalId, "a".repeat(64), true)).rejects.toMatchObject({ code: "factory_assurance_stale" });
  await assurance.decideApproval(admin, projectId, approval.approvalId, approval.contextDigest, true);
  const consumption = { ...request, approvalId: approval.approvalId, requester: admin, runId: candidate.runId };
  const result = await Promise.allSettled([fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, consumption)), fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, consumption))]);
  expect(result.filter(item => item.status === "fulfilled")).toHaveLength(1); expect(result.filter(item => item.status === "rejected")).toHaveLength(1);
  await expect(fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, { ...request, approvalId: approval.approvalId, requester: admin, runId: candidate.runId }))).rejects.toBeInstanceOf(FactoryAssuranceError);
  expect(rows<{ action: string }>(await fixture.db.execute(sql`SELECT action FROM audit_log WHERE target IN (${request.operationId}, ${approval.approvalId}) ORDER BY action`)).map(row => row.action)).toEqual(["factory.assurance.approval.consumed", "factory.assurance.approval.decided", "factory.assurance.approval.requested"]);
});

test("sealed contract facts reject tampering before acceptance and after approval", async () => {
  await assurance.approveContract(admin, { projectId, contractId: "sealed-before-accept", revision: 1, contractDigest: digest("f"), validatorLockDigest: trusted.validatorLockDigest, mandatoryClaims: [{ id: "tests", validatorId: trusted.validatorId, freshnessMs: 100 }, { id: "review", validatorId: trusted.validatorId, freshnessMs: 100 }], claimGroups: [{ id: "required", claimIds: ["tests", "review"], minimumPasses: 2, requireAllDecisive: true }] });
  await fixture.db.execute(sql`UPDATE factory_acceptance_contracts SET mandatory_claims=${JSON.stringify([{ id: "tests", validatorId: trusted.validatorId, freshnessMs: 100 }])} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND contract_id='sealed-before-accept'`);
  expect(rows(await fixture.db.execute(sql`SELECT contract_digest FROM factory_acceptance_contracts WHERE tenant_id=${tenantId} AND project_id=${projectId} AND contract_id='sealed-before-accept'`))).toEqual([{ contract_digest: digest("f") }]);
  await expect(assurance.accept({ ...candidate, contractId: "sealed-before-accept", revision: 1 })).rejects.toMatchObject({ code: "factory_assurance_corrupt" });

  await assurance.approveContract(admin, { projectId, contractId: "sealed-after-approval", revision: 1, contractDigest: digest("e"), validatorLockDigest: trusted.validatorLockDigest, mandatoryClaims: [{ id: "tests", validatorId: trusted.validatorId, freshnessMs: 100 }, { id: "review", validatorId: trusted.validatorId, freshnessMs: 100 }], claimGroups: [{ id: "required", claimIds: ["tests", "review"], minimumPasses: 2, requireAllDecisive: true }] });
  const decision = await assurance.accept({ ...candidate, contractId: "sealed-after-approval", revision: 1 });
  const request = { projectId, operationId: "sealed-after-approval-release", decisionId: decision.decisionId, destinationDigest: digest("a"), expectedGeneration: 4, expiresAtMs: now + 500 };
  const approval = await assurance.requestApproval(admin, request); await assurance.decideApproval(admin, projectId, approval.approvalId, approval.contextDigest, true);
  await fixture.db.execute(sql`UPDATE factory_acceptance_contracts SET approved_by='tampered-approval-authority' WHERE tenant_id=${tenantId} AND project_id=${projectId} AND contract_id='sealed-after-approval'`);
  expect(rows(await fixture.db.execute(sql`SELECT contract_digest FROM factory_acceptance_contracts WHERE tenant_id=${tenantId} AND project_id=${projectId} AND contract_id='sealed-after-approval'`))).toEqual([{ contract_digest: digest("e") }]);
  await expect(fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, { ...request, approvalId: approval.approvalId, requester: admin, runId: candidate.runId }))).rejects.toMatchObject({ code: "factory_assurance_corrupt" });
  expect(rows(await fixture.db.execute(sql`SELECT status FROM factory_release_approvals WHERE tenant_id=${tenantId} AND project_id=${projectId} AND approval_id=${approval.approvalId}`))).toEqual([{ status: "approved" }]);
});

test("acceptance rechecks the current protected gateway evidence and every mandatory claim", async () => {
  const currentCandidate = { ...candidate, candidateGeneration: 41 };
  const original = trusted;
  trusted = { ...trusted, ...currentCandidate };
  await assurance.captureEvidence({ ...currentCandidate, validatorId: trusted.validatorId });
  await assurance.approveContract(admin, { projectId, contractId: "current-candidate", revision: 1, contractDigest: digest("a"), validatorLockDigest: trusted.validatorLockDigest, mandatoryClaims: [{ id: "tests", validatorId: trusted.validatorId, freshnessMs: 100 }, { id: "review", validatorId: trusted.validatorId, freshnessMs: 100 }], claimGroups: [{ id: "subset", claimIds: ["tests"], minimumPasses: 1, requireAllDecisive: true }] });
  trusted = { ...trusted, environmentDigest: digest("d") };
  await expect(assurance.accept({ ...currentCandidate, contractId: "current-candidate", revision: 1 })).rejects.toMatchObject({ code: "factory_assurance_stale" });
  const mandatoryCandidate = { ...candidate, candidateGeneration: 42 };
  trusted = { ...original, ...mandatoryCandidate, claims: [{ id: "tests", passed: true, decisive: true }, { id: "review", passed: false, decisive: true }] };
  await assurance.captureEvidence({ ...mandatoryCandidate, validatorId: trusted.validatorId });
  await assurance.approveContract(admin, { projectId, contractId: "mandatory-not-alternative", revision: 1, contractDigest: digest("b"), validatorLockDigest: trusted.validatorLockDigest, mandatoryClaims: [{ id: "tests", validatorId: trusted.validatorId, freshnessMs: 100 }, { id: "review", validatorId: trusted.validatorId, freshnessMs: 100 }], claimGroups: [{ id: "subset", claimIds: ["tests"], minimumPasses: 1, requireAllDecisive: true }] });
  await expect(assurance.accept({ ...mandatoryCandidate, contractId: "mandatory-not-alternative", revision: 1 })).rejects.toMatchObject({ code: "factory_assurance_claim_failed" });
  trusted = original;
});

test("each approval audit fault rolls back its product fact", async () => {
  const decision = await assurance.accept({ ...candidate, contractId: "contract", revision: 1 });
  const request = (operationId: string) => ({ projectId, operationId, decisionId: decision.decisionId, destinationDigest: digest("b"), expectedGeneration: 4, expiresAtMs: now + 500 });
  const requestFault = request("audit-request-fault");
  await expect(rejectAudit(async () => { await assurance.requestApproval(admin, requestFault); })).rejects.toThrow();
  expect(rows(await fixture.db.execute(sql`SELECT approval_id FROM factory_release_approvals WHERE operation_id=${requestFault.operationId}`))).toHaveLength(0);

  const decisionFault = request("audit-decision-fault"); const pending = await assurance.requestApproval(admin, decisionFault);
  await expect(rejectAudit(async () => { await assurance.decideApproval(admin, projectId, pending.approvalId, pending.contextDigest, true); })).rejects.toThrow();
  expect(rows(await fixture.db.execute(sql`SELECT status FROM factory_release_approvals WHERE approval_id=${pending.approvalId}`))).toEqual([{ status: "pending" }]);

  const consumeFault = request("audit-consume-fault"); const approved = await assurance.requestApproval(admin, consumeFault); await assurance.decideApproval(admin, projectId, approved.approvalId, approved.contextDigest, true);
  await expect(rejectAudit(async () => { await fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, { ...consumeFault, approvalId: approved.approvalId, requester: admin, runId: candidate.runId })); })).rejects.toThrow();
  expect(rows(await fixture.db.execute(sql`SELECT status, consumed_at FROM factory_release_approvals WHERE approval_id=${approved.approvalId}`))).toEqual([{ status: "approved", consumed_at: null }]);
});

test("a human approval can authorize a bounded service release without forging a user audit actor", async () => {
  const service: FactoryPrincipal = { kind: "service", id: "assurance-release-service", authentication: "service" };
  await fixture.db.execute(sql`INSERT INTO service_accounts (id, name, created_by_user_id, project_id, max_tokens_per_day, expires_at) VALUES (${service.id}, 'Assurance release service', ${admin.id}, ${projectId}, 100, ${new Date(now + 500)})`);
  await grants.set(admin, { projectId, principal: service, action: "factory.release", expectedRevision: 0, expiresAtMs: now + 500 });
  await expect(grants.authorize(service, projectId, "factory.approve")).rejects.toMatchObject({ code: "factory_human_required" });
  const decision = await assurance.accept({ ...candidate, contractId: "contract", revision: 1 });
  const request = { projectId, operationId: "service-release-operation", decisionId: decision.decisionId, destinationDigest: digest("f"), expectedGeneration: 4, expiresAtMs: now + 500 };
  const approval = await assurance.requestApproval(admin, request); await assurance.decideApproval(admin, projectId, approval.approvalId, approval.contextDigest, true);
  await fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, { ...request, approvalId: approval.approvalId, requester: service, runId: candidate.runId }));
  const audit = rows<{ user_id: string | null; metadata: string | { principalKind: string; principalId: string } }>(await fixture.db.execute(sql`SELECT user_id, metadata FROM audit_log WHERE id=${`factory-assurance-approval-consumed:${approval.approvalId}`}`)).map(row => ({ ...row, metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata }));
  expect(audit).toMatchObject([{ user_id: null, metadata: { principalKind: "service", principalId: service.id } }]);
});

test("a corrupt decision row cannot be presented for human consent", async () => {
  await assurance.approveContract(admin, { projectId, contractId: "sealed-decision", revision: 1, contractDigest: digest("c"), validatorLockDigest: trusted.validatorLockDigest, mandatoryClaims: [{ id: "tests", validatorId: trusted.validatorId, freshnessMs: 100 }, { id: "review", validatorId: trusted.validatorId, freshnessMs: 100 }], claimGroups: [{ id: "required", claimIds: ["tests", "review"], minimumPasses: 2, requireAllDecisive: true }] });
  const decision = await assurance.accept({ ...candidate, contractId: "sealed-decision", revision: 1 });
  await fixture.db.execute(sql`UPDATE factory_acceptance_decisions SET candidate_digest=${digest("a")} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND decision_id=${decision.decisionId}`);
  await expect(assurance.requestApproval(admin, { projectId, operationId: "corrupt-decision-consent", decisionId: decision.decisionId, destinationDigest: digest("f"), expectedGeneration: 4, expiresAtMs: now + 500 })).rejects.toMatchObject({ code: "factory_assurance_corrupt" });
});

test("forged validator provenance, stale evidence, and corrupt validator locks fail closed", async () => {
  const forged = new FactoryAssurance(fixture.db, tenantId, grants, { async resolveValidatorInTransaction() { return { ...trusted, validatorId: "forged-validator" }; } }, new ReleaseFenceReader(), new Gateway(), () => now);
  await expect(forged.captureEvidence({ ...candidate, validatorId: trusted.validatorId })).rejects.toMatchObject({ code: "factory_assurance_trust" });
  await fixture.db.execute(sql`UPDATE factory_acceptance_evidence SET validator_lock_digest=${digest("f")} WHERE tenant_id=${tenantId} AND project_id=${projectId}`);
  await expect(assurance.accept({ ...candidate, contractId: "contract", revision: 1 })).rejects.toMatchObject({ code: "factory_assurance_evidence_stale" });
  await fixture.db.execute(sql`UPDATE factory_acceptance_evidence SET validator_lock_digest=${trusted.validatorLockDigest} WHERE tenant_id=${tenantId} AND project_id=${projectId}`);
  await fixture.db.execute(sql`UPDATE factory_acceptance_evidence SET claims=${JSON.stringify([{ id: "tests", passed: false, decisive: true }, { id: "review", passed: true, decisive: true }])} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND candidate_generation=1`);
  await expect(assurance.accept({ ...candidate, contractId: "contract", revision: 1 })).rejects.toMatchObject({ code: "factory_assurance_evidence_stale" });
  await fixture.db.execute(sql`UPDATE factory_acceptance_evidence SET claims=${JSON.stringify(trusted.claims)} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND candidate_generation=1`);
  const stale = { ...candidate, candidateGeneration: 2 };
  trusted = { ...trusted, ...stale, issuedAtMs: now - 101, expiresAtMs: now + 1000 };
  await assurance.captureEvidence({ ...stale, validatorId: trusted.validatorId });
  await expect(assurance.accept({ ...stale, contractId: "contract", revision: 1 })).rejects.toMatchObject({ code: "factory_assurance_claim_failed" });
  trusted = { ...trusted, ...candidate, issuedAtMs: now - 1 };
});

test("two protected validators retain separate evidence rows", async () => {
  const multiCandidate = { ...candidate, candidateGeneration: 3 };
  const first = { ...trusted, ...multiCandidate, claims: [{ id: "first", passed: true, decisive: true }] };
  const second = { ...trusted, ...multiCandidate, validatorId: "second-validator", claims: [{ id: "second", passed: true, decisive: true }] };
  const gateway: FactoryTrustedValidatorGateway & FactoryCurrentCandidateResolver = {
    async resolveValidatorInTransaction(_transaction, _tenant, _key, validatorId) { if (validatorId === first.validatorId) return first; if (validatorId === second.validatorId) return second; throw new Error("unknown validator"); },
    async resolveCurrentEvidenceInTransaction() { return [first, second]; },
  };
  const multi = new FactoryAssurance(fixture.db, tenantId, grants, gateway, new ReleaseFenceReader(), gateway, () => now);
  await multi.approveContract(admin, { projectId, contractId: "multi", revision: 1, contractDigest: digest("f"), validatorLockDigest: trusted.validatorLockDigest, mandatoryClaims: [{ id: "first", validatorId: first.validatorId, freshnessMs: 100 }, { id: "second", validatorId: second.validatorId, freshnessMs: 100 }], claimGroups: [{ id: "both", claimIds: ["first", "second"], minimumPasses: 2, requireAllDecisive: true }] });
  await multi.captureEvidence({ ...multiCandidate, validatorId: first.validatorId });
  await multi.captureEvidence({ ...multiCandidate, validatorId: second.validatorId });
  await expect(multi.accept({ ...multiCandidate, contractId: "multi", revision: 1 })).resolves.toMatchObject({ candidateGeneration: 3 });
});

test("expired or failed evidence never becomes an acceptance decision", async () => {
  trusted = { ...trusted, claims: [{ id: "tests", passed: false, decisive: true }, { id: "review", passed: true, decisive: true }] };
  await expect(assurance.captureEvidence({ ...candidate, validatorId: trusted.validatorId })).rejects.toThrow("factory_assurance_conflict");
  trusted = { ...trusted, claims: [{ id: "tests", passed: true, decisive: true }, { id: "review", passed: true, decisive: true }] };
  expect(() => new FactoryAssurance(fixture.db, "other-tenant", grants, new Gateway(), new ReleaseFenceReader(), new Gateway(), () => now)).toThrow(FactoryAssuranceError);
});

test("duplicate claim identifiers and another run cannot mint release authority", async () => {
  await expect(assurance.approveContract(admin, { projectId, contractId: "duplicate", revision: 1, contractDigest: digest("a"), validatorLockDigest: trusted.validatorLockDigest, mandatoryClaims: [{ id: "same", validatorId: trusted.validatorId, freshnessMs: 1 }, { id: "same", validatorId: trusted.validatorId, freshnessMs: 1 }], claimGroups: [] })).rejects.toMatchObject({ code: "factory_assurance_invalid" });
  const decision = await assurance.accept({ ...candidate, contractId: "contract", revision: 1 });
  const request = { projectId, operationId: "foreign-run-operation", decisionId: decision.decisionId, destinationDigest: digest("a"), expectedGeneration: 4, expiresAtMs: now + 500 };
  const approval = await assurance.requestApproval(admin, request);
  await assurance.decideApproval(admin, projectId, approval.approvalId, approval.contextDigest, true);
  const environmentDigest = trusted.environmentDigest;
  trusted = { ...trusted, environmentDigest: digest("b") };
  await expect(fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, { ...request, approvalId: approval.approvalId, requester: admin, runId: candidate.runId }))).rejects.toMatchObject({ code: "factory_assurance_stale" });
  trusted = { ...trusted, environmentDigest };
  await expect(fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, { ...request, approvalId: approval.approvalId, requester: admin, runId: "other-run" }))).rejects.toThrow("trusted release fence");
});

test("same content in a distinct run receives a separate acceptance and approval scope", async () => {
  const second = { ...candidate, runId: "assurance-run-2" };
  const records = new FactoryRecords(fixture.db, tenantId);
  await records.createRun({ projectId, runId: second.runId, definitionDigest: digest("d"), interpreterBuild: "factory-v1", executionEpoch: 1, input: {}, principalId: admin.id }, async () => {});
  const original = trusted;
  trusted = { ...trusted, ...second };
  await assurance.captureEvidence({ ...second, validatorId: trusted.validatorId });
  const decision = await assurance.accept({ ...second, contractId: "contract", revision: 1 });
  expect(decision.runId).toBe(second.runId);
  const approval = await assurance.requestApproval(admin, { projectId, operationId: "second-run-release", decisionId: decision.decisionId, destinationDigest: digest("a"), expectedGeneration: 4, expiresAtMs: now + 500 });
  expect(approval.approvalId).toBeTruthy();
  trusted = original;
});

test("cancellation and revoked trust deny a release claim inside its transaction", async () => {
  const decision = await assurance.accept({ ...candidate, contractId: "contract", revision: 1 });
  const request = { projectId, operationId: "fenced-release-operation", decisionId: decision.decisionId, destinationDigest: digest("f"), expectedGeneration: 4, expiresAtMs: now + 500 };
  const approval = await assurance.requestApproval(admin, request);
  await assurance.decideApproval(admin, projectId, approval.approvalId, approval.contextDigest, true);
  fenceStatus = "cancelling";
  await expect(fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, { ...request, approvalId: approval.approvalId, requester: admin, runId: candidate.runId }))).rejects.toMatchObject({ code: "factory_assurance_stale" });
  fenceStatus = "running";
  await grants.revoke(admin, { projectId, principal: admin, action: "factory.trust", expectedRevision: 1 });
  await expect(fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, { ...request, approvalId: approval.approvalId, requester: admin, runId: candidate.runId }))).rejects.toThrow("factory_forbidden");
});

}
