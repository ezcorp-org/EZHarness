import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
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
    if (tenant !== tenantId || currentProjectId !== projectId || runId !== candidate.runId) throw new Error("trusted release fence was not found");
    return { runId, executionEpoch: 1, cancellationEpoch: fenceStatus === "running" ? 0 : 1, status: fenceStatus, deadlineMs: now + 1_000 };
  }
}
let assurance: FactoryAssurance;

beforeAll(async () => {
  fixture = await createFixture();
  const records = new FactoryRecords(fixture.db, tenantId); await records.bindInstallation();
  await fixture.db.execute(sql`INSERT INTO projects (id, name, path) VALUES (${projectId}, 'Assurance', '/tmp/assurance')`); await records.bindProject(projectId);
  await fixture.db.execute(sql`INSERT INTO users (id, email, password_hash, name, role) VALUES (${admin.id}, 'admin@example.test', 'x', 'admin', 'admin')`);
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
  const approval = await assurance.requestApproval(admin, request); await assurance.decideApproval(admin, projectId, approval.approvalId, true);
  const consumption = { ...request, approvalId: approval.approvalId, requester: admin, runId: candidate.runId };
  const result = await Promise.allSettled([fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, consumption)), fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, consumption))]);
  expect(result.filter(item => item.status === "fulfilled")).toHaveLength(1); expect(result.filter(item => item.status === "rejected")).toHaveLength(1);
  await expect(fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, { ...request, approvalId: approval.approvalId, requester: admin, runId: candidate.runId }))).rejects.toBeInstanceOf(FactoryAssuranceError);
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
  await assurance.decideApproval(admin, projectId, approval.approvalId, true);
  const environmentDigest = trusted.environmentDigest;
  trusted = { ...trusted, environmentDigest: digest("b") };
  await expect(fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, { ...request, approvalId: approval.approvalId, requester: admin, runId: candidate.runId }))).rejects.toMatchObject({ code: "factory_assurance_stale" });
  trusted = { ...trusted, environmentDigest };
  await expect(fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, { ...request, approvalId: approval.approvalId, requester: admin, runId: "other-run" }))).rejects.toThrow("trusted release fence");
});

test("cancellation and revoked trust deny a release claim inside its transaction", async () => {
  const decision = await assurance.accept({ ...candidate, contractId: "contract", revision: 1 });
  const request = { projectId, operationId: "fenced-release-operation", decisionId: decision.decisionId, destinationDigest: digest("f"), expectedGeneration: 4, expiresAtMs: now + 500 };
  const approval = await assurance.requestApproval(admin, request);
  await assurance.decideApproval(admin, projectId, approval.approvalId, true);
  fenceStatus = "cancelling";
  await expect(fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, { ...request, approvalId: approval.approvalId, requester: admin, runId: candidate.runId }))).rejects.toMatchObject({ code: "factory_assurance_stale" });
  fenceStatus = "running";
  await grants.revoke(admin, { projectId, principal: admin, action: "factory.trust", expectedRevision: 1 });
  await expect(fixture.db.transaction(tx => assurance.consumeApprovalInTransaction(tx, { ...request, approvalId: approval.approvalId, requester: admin, runId: candidate.runId }))).rejects.toThrow("factory_forbidden");
});

}
