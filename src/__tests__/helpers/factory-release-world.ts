import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { FactoryAssurance, type FactoryCandidateKey, type FactoryCurrentCandidateResolver, type FactoryReleaseFenceReader, type FactoryTrustedEvidence, type FactoryTrustedValidatorGateway } from "../../factory/assurance";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryRecords } from "../../factory/records";
import { factoryRequestedReleaseProfile, FactoryReleases, type FactoryArchiveObject, type FactoryDestinationReservationReader, type FactoryProviderReceipt, type FactoryReleaseArchive, type FactoryReleaseAuthority, type FactoryReleaseAuthorityReader, type FactoryReleaseClaim, type FactoryReleaseMaterialReader, type FactoryReleaseOperation, type FactoryReleaseProvider, type FactoryReleaseRequest, type FactorySenderFence } from "../../factory/releases";
import { unboundFactoryValidatorBinders } from "./factory-validator-binders";
import { openFactoryEffectClaimsForTest } from "./factory-effect-claims";

/**
 * A real `FactoryReleases` store over a real database, for the recovery suites.
 *
 * Every product row a release writes is written by the production store: the
 * contract, the evidence, the acceptance decision, the operation, the archive
 * references, the claim, and the settled receipt. Only the collaborators a
 * test must steer are doubles — the validator gateway, the lifecycle fence,
 * the destination reservation, the sender fence, and the provider — and the
 * provider remembers every receipt it issued, the way a real destination does,
 * so a restore can reconcile against it after the product database forgot.
 */

export const digest = (letter: string) => `sha256:${letter.repeat(64)}`;

export interface FactoryReleaseWorldOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  readonly projectId: string;
  readonly admin: FactoryPrincipal;
  readonly archive: FactoryReleaseArchive;
  readonly now: () => number;
}

/** A provider with durable memory of what it published, independent of any product database. */
export class FactoryRememberingProvider implements FactoryReleaseProvider {
  readonly receipts = new Map<string, FactoryProviderReceipt>();
  calls = 0;
  async publish(claim: FactoryReleaseClaim): Promise<FactoryProviderReceipt> {
    this.calls += 1;
    const receipt: FactoryProviderReceipt = { provider: claim.destination.provider, account: claim.destination.account, object: claim.destination.object, requestDigest: claim.requestDigest, operationId: claim.operationId, dispatchGeneration: claim.dispatchGeneration, providerReceiptId: `receipt-${claim.operationId}`, version: `v${claim.dispatchGeneration}`, effectDigest: digest("f") };
    this.receipts.set(claim.operationId, receipt);
    return receipt;
  }
  async verifyReceipt(operation: FactoryReleaseOperation, receipt: FactoryProviderReceipt): Promise<boolean> {
    return canonicalJson(this.receipts.get(operation.operationId) ?? null) === canonicalJson(receipt);
  }
  async proveNoEffect(operation: FactoryReleaseOperation): Promise<boolean> { return !this.receipts.has(operation.operationId); }
}

/** One accepted run: its decision and the two ways to drive a release of it. */
export interface FactoryReleaseRun {
  readonly runId: string;
  readonly decisionId: string;
  /** Prepares, approves, claims, and dispatches one real release; returns the settled operation. */
  release(suffix: string): Promise<FactoryReleaseOperation>;
  /** Prepares and claims, leaving the operation executing with its dispatch in flight. */
  claimOnly(suffix: string): Promise<FactoryReleaseClaim>;
}

export interface FactoryReleaseWorld {
  readonly releases: FactoryReleases;
  readonly provider: FactoryRememberingProvider;
  readonly grants: FactoryGrants;
  /** Creates the run at the installation's current epoch and accepts one candidate through real assurance. */
  acceptRun(runId: string): Promise<FactoryReleaseRun>;
}

/** Binds the installation, project, admin, and grants once. */
export async function createFactoryReleaseWorld(options: FactoryReleaseWorldOptions): Promise<FactoryReleaseWorld> {
  const { database, tenantId, projectId, admin, now } = options;
  let sequence = 0;
  const key = (kind: string) => `${tenantId}-${kind}-${++sequence}`;
  const records = new FactoryRecords(database, tenantId);
  await records.bindInstallation();
  await openFactoryEffectClaimsForTest(database, tenantId);
  await database.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Release',${`/tmp/${projectId}`}) ON CONFLICT (id) DO NOTHING`);
  await records.bindProject(projectId);
  await database.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${admin.id},${`${admin.id}@example.test`},'x','Recovery admin','admin') ON CONFLICT (id) DO NOTHING`);
  await database.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES (${`${tenantId}-${admin.id}-member`},${projectId},${admin.id},'owner') ON CONFLICT (id) DO NOTHING`);
  const grants = new FactoryGrants(database, tenantId, now);
  for (const action of ["factory.trust", "factory.approve", "factory.release", "factory.operate"] as const) await grants.set(admin, { projectId, principal: admin, action, expectedRevision: 0, expiresAtMs: null });

  const runs = new Map<string, { trusted: FactoryTrustedEvidence; executionEpoch: number }>();
  const current = (runId: string) => {
    const run = runs.get(runId);
    if (!run) throw new Error(`unknown release world run ${runId}`);
    return run;
  };
  const candidate = (runId: string): FactoryCandidateKey => ({ projectId, runId, nodeInstanceId: "release-node", candidateGeneration: 1 });
  const gateway: FactoryTrustedValidatorGateway & FactoryCurrentCandidateResolver = {
    async assertContractInTransaction() {},
    bindAttemptInTransaction: unboundFactoryValidatorBinders.bindAttemptInTransaction,
    bindTaskAttemptInTransaction: unboundFactoryValidatorBinders.bindTaskAttemptInTransaction,
    async resolveValidatorInTransaction(_transaction: MigrationDb, _tenant: string, candidateKey: FactoryCandidateKey) { return structuredClone(current(candidateKey.runId).trusted); },
    async resolveCurrentEvidenceInTransaction(_transaction: MigrationDb, _tenant: string, candidateKey: FactoryCandidateKey) { return [structuredClone(current(candidateKey.runId).trusted)]; },
  };
  const fence: FactoryReleaseFenceReader = { async readCurrentInTransaction(_transaction: MigrationDb, _tenant: string, _project: string, runId: string) { return { runId, executionEpoch: current(runId).executionEpoch, cancellationEpoch: 0, status: "running" as const, deadlineMs: now() + 10_000_000 }; } };
  const authority: FactoryReleaseAuthorityReader = {
    async lockCurrentInTransaction(_transaction: MigrationDb, _tenant: string, _project: string, runId: string): Promise<FactoryReleaseAuthority> {
      const run = current(runId);
      return { ...candidate(runId), candidateDigest: run.trusted.candidateDigest, executionEpoch: run.executionEpoch, cancellationEpoch: 0, releaseEnableEpoch: 1, deadlineMs: now() + 10_000_000, status: "running", packageTrustDigest: digest("a"), validatorTrustDigest: digest("b") } as FactoryReleaseAuthority;
    },
  };
  const destinations: FactoryDestinationReservationReader = { async reserveInTransaction() { return { currentVersion: null }; } };
  const sender: FactorySenderFence = { async proveStopped() { return false; } };
  const assurance = new FactoryAssurance(database, tenantId, grants, gateway, fence, gateway, now);
  const decisions = new Map<string, string>();
  const materials: FactoryReleaseMaterialReader = {
    async readPinnedInTransaction(_transaction: MigrationDb, _tenant: string, accepted: { readonly runId: string }) {
      const run = current(accepted.runId);
      return { decisionId: decisions.get(accepted.runId)!, evidence: [{ artifact: run.trusted.artifact, candidateDigest: run.trusted.candidateDigest }], packageTrustDigest: digest("a"), validatorTrustDigest: digest("b") };
    },
  };
  const releases = new FactoryReleases(database, tenantId, grants, assurance, materials, authority, destinations, options.archive, sender, now);
  const provider = new FactoryRememberingProvider();

  return Object.freeze({
    releases, provider, grants,
    async acceptRun(runId: string): Promise<FactoryReleaseRun> {
      const epoch = Number((await database.execute(sql`SELECT execution_epoch FROM factory_installation WHERE tenant_id = ${tenantId}`) as unknown as { rows: { execution_epoch: number }[] }).rows?.[0]?.execution_epoch ?? 1);
      await records.createRun({ projectId, runId, definitionDigest: digest("d"), interpreterBuild: "v1", executionEpoch: epoch, input: {}, principalId: admin.id }, async () => {});
      runs.set(runId, { executionEpoch: epoch, trusted: { ...candidate(runId), validatorId: "validator", validatorLockDigest: digest("c"), issuerGrantRevision: 1, candidateDigest: digest("c"), artifact: { artifactId: "artifact", digest: digest("a"), encodedBytes: 10 }, environmentDigest: digest("e"), configurationDigest: digest("d"), runnerDigest: digest("e"), claims: [{ id: "passed", verdict: "PASS" as const, decisive: true }], issuedAtMs: now() - 1, expiresAtMs: now() + 10_000_000 } });
      const contractId = `contract-${runId}`;
      await assurance.approveContract(admin, { projectId, contractId, revision: 1, contractDigest: digest("f"), validatorLockDigest: digest("c"), mandatoryClaims: [{ id: "passed", validatorId: "validator", freshnessMs: 10_000_000 }], claimGroups: [{ id: "all", claimIds: ["passed"], minimumPasses: 1, requireAllDecisive: true }] }, key("contract"));
      await assurance.captureEvidence({ ...candidate(runId), validatorId: "validator" });
      const decisionId = (await assurance.accept({ ...candidate(runId), contractId, revision: 1 })).decisionId;
      decisions.set(runId, decisionId);
      const request = (suffix: string): FactoryReleaseRequest => ({ ...candidate(runId), decisionId, candidateDigest: digest("c"), action: "publish", destination: { provider: "fixture", account: "account-a", object: `releases/${runId}/${suffix}` }, request: { body: suffix }, estimatedSpendMicros: 5, deadlineMs: now() + 5_000_000 });
      const claimOnly = async (suffix: string): Promise<FactoryReleaseClaim> => {
        const input = request(suffix);
        const preparation = await releases.resolvePreparation({
          projectId, runId, nodeInstanceId: input.nodeInstanceId, candidateGeneration: input.candidateGeneration, decisionId, candidateDigest: input.candidateDigest,
          acceptedManifest: { candidate: input.candidateDigest }, requestedDestination: { ...input.destination }, deadlineMs: input.deadlineMs,
        }, factoryRequestedReleaseProfile(input, now), new AbortController().signal);
        const prepared = await releases.prepare(admin, preparation, key("prepare"));
        const approval = await assurance.requestApproval(admin, { projectId, operationId: prepared.operationId, decisionId, destinationDigest: prepared.destinationDigest, expectedGeneration: prepared.dispatchGeneration + 1, expiresAtMs: now() + 1_000_000 }, key("approval"));
        await assurance.decideApproval(admin, projectId, approval.approvalId, approval.contextDigest, true, key("decision"));
        return releases.claim(admin, projectId, prepared.operationId, { kind: "approval", approvalId: approval.approvalId });
      };
      return Object.freeze({ runId, decisionId, claimOnly, async release(suffix: string) { return releases.dispatch(await claimOnly(suffix), provider); } });
    },
  });
}

/** An in-memory immutable release archive with the real archive's content addressing. */
export class FactoryMemoryReleaseArchive implements FactoryReleaseArchive {
  readonly objects = new Map<string, Uint8Array>();
  async writeImmutable(tenant: string, operationId: string, name: "intent" | "material" | "receipt" | "reconciliation", bytes: Uint8Array): Promise<FactoryArchiveObject> {
    const raw = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const objectKey = `${tenant}/${operationId}/${name}/${raw}`;
    this.objects.set(objectKey, bytes.slice());
    return { key: objectKey, digest: `sha256:${raw}`, versionId: "archive-v1" };
  }
  async read(reference: FactoryArchiveObject): Promise<Uint8Array> {
    const value = this.objects.get(reference.key);
    if (!value) throw new Error("archive missing");
    return value.slice();
  }
}
