import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { canonicalJson, type ReleaseRecord, type ResourceLimits, type Runner, type WorkspaceFiles } from "@ezcorp/extension-contract";
import type { RunnerReference } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows } from "../../db/queries/extension-releases";
import { DatabaseLifecycleRepository } from "../../db/queries/extension-releases";
import { digestObject } from "../../extensions/v4/blobs";
import type { BlobStore } from "../../extensions/v4/types";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryPackagePreparationError, FactoryPackagePreparations, FactoryPackageTrusts, FactoryV4PackageCatalog, factoryPackageDispatchDisposition } from "../../factory/package-preparation";
import { FactoryRecords } from "../../factory/records";

export interface FactoryPackagePreparationFixture { readonly db: TransactionalDb; readonly blobs: BlobStore; close(): Promise<void>; }

const tenantId = "package-tenant";
const projectId = "package-project";
const admin: FactoryPrincipal = { kind: "user", id: "package-admin", authentication: "session" };
const reference: RunnerReference = { package: "package-runner", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, export: "echo" };
const secondReference: RunnerReference = { ...reference, model: "model-b", configurationDigest: `sha256:${"c".repeat(64)}` };
const limits: ResourceLimits = { memoryBytes: 64 * 1024 * 1024, cpuMillis: 1000, pids: 16, tmpBytes: 1024 * 1024, outputBytes: 1024 * 1024, timeoutMs: 10_000 };

function digestReference(value: RunnerReference): string { return `sha256:${digestObject(value)}`; }

function release(sourceDigest: string, artifactDigest: string): ReleaseRecord {
  const manifest = { schemaVersion: 4 as const, name: reference.package, version: reference.version, author: { name: "Package test" }, description: "Factory package", permissions: {}, tools: [{ name: reference.export, description: "Echo", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] };
  const input = { installationId: "package-installation", workspaceId: "workspace", workspaceRevision: 1, sourceDigest, artifactDigest, imageDigest: "podman-image@sha256:test", manifest, evidence: { protocolVersion: 4 as const, validatorVersion: "runner-v4", discoveryDigest: digestObject(manifest), tests: [{ name: "unit", passed: true }] }, runnerProfile: "podman-v4", policyDigest: digestObject({ policy: "v4" }) };
  return { ...input, id: "package-release", releaseDigest: digestObject(input), createdAt: "2030-01-01T00:00:00.000Z" };
}

export function factoryPackagePreparationConformance(create: () => Promise<FactoryPackagePreparationFixture>): void {
let fixture: FactoryPackagePreparationFixture;
beforeEach(async () => { fixture = await create(); });
afterEach(async () => { await fixture?.close(); });
async function packageContext(installationProject = projectId) {
  const database = fixture.db;
  const records = new FactoryRecords(database, tenantId);
  await records.bindInstallation();
  await database.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Package project','/tmp/package')`);
  await database.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${admin.id},'package@example.test','x','Package','admin')`);
  await database.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('package-member',${projectId},${admin.id},'owner')`);
  await records.bindProject(projectId);
  const grants = new FactoryGrants(database, tenantId);
  await grants.set(admin, { projectId, principal: admin, action: "factory.trust", expectedRevision: 0, expiresAtMs: null });
  const blobs = fixture.blobs;
  const source: WorkspaceFiles = { "extension.ts": "export {};" };
  const artifacts: WorkspaceFiles = { "extension.ts": "export {};", ".runner/recipe.json": "{}" };
  const sourceDigest = await blobs.put(new TextEncoder().encode(canonicalJson(source)));
  const artifactDigest = digestObject(artifacts);
  const repo = new DatabaseLifecycleRepository(database);
  const current = release(sourceDigest, artifactDigest);
  await repo.create({ installation: { id: "package-installation", ownerId: admin.id, scope: `project:${installationProject}`, generation: 1, activeReleaseId: current.id, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 1 }, workspaces: {}, revisions: {}, operations: {}, releases: { [current.id]: current }, approvals: {} });
  const fenced: Array<{ state: string; trustRevision: number; reference: RunnerReference }> = [];
  // A case can make the stop path fail to prove the state change is atomic with it.
  const fence = { fail: false };
  const trusts = new FactoryPackageTrusts(database, tenantId, grants, {
    async fenceAttempts(_transaction, input) {
      fenced.push({ state: input.state, trustRevision: input.trustRevision, reference: input.reference });
      if (fence.fail) throw new Error("stop path crashed mid-fence");
      return ["fenced-attempt"];
    },
  });
  return {
    database, grants, source, artifacts, sourceDigest, artifactDigest, repo, current, trusts, fenced, fence,
    preparations(runner: Pick<Runner, "build" | "collectArtifacts">) {
      return new FactoryPackagePreparations(database, tenantId, grants, trusts, new FactoryV4PackageCatalog(repo, blobs), runner, limits);
    },
  };
}
async function trustedPackage() {
  const context = await packageContext();
  const runner: Pick<Runner, "build" | "collectArtifacts"> = {
    async build() { throw new Error("cached package must not rebuild"); },
    async collectArtifacts() { return structuredClone(context.artifacts); },
  };
  const preparations = context.preparations(runner);
  await preparations.bind(admin, { projectId, reference, installationId: context.current.installationId, releaseId: context.current.id }, "bind-package");
  await context.trusts.publish(admin, { projectId, reference, expectedRevision: 0 }, "trust-package");
  return { ...context, runner, prepared: preparations };
}

test("package trust cannot bind an installation from another project", async () => {
  const context = await packageContext("another-project");
  const preparations = context.preparations({ async build() { throw new Error("unexpected build"); }, async collectArtifacts() { throw new Error("unexpected artifact read"); } });
  await expect(preparations.bind(admin, { projectId, reference, installationId: context.current.installationId, releaseId: context.current.id }, "bind-foreign-project")).rejects.toMatchObject({ code: "factory_package_release_unavailable" });
});

test("concurrent preparation workers commit and return the same receipt", async () => {
  const { prepared, runner, artifacts, database } = await trustedPackage();
  let calls = 0;
  let release!: () => void;
  const bothHydrating = new Promise<void>(resolve => { release = resolve; });
  runner.collectArtifacts = async () => {
    if (++calls === 2) release();
    await bothHydrating;
    return structuredClone(artifacts);
  };
  const [first, second] = await Promise.all([prepared.prepare(projectId, reference), prepared.prepare(projectId, reference)]);
  expect(first).toEqual(second);
  expect(releaseRows(await database.execute(sql`SELECT receipt_digest FROM factory_runner_preparation_receipts WHERE tenant_id=${tenantId} AND project_id=${projectId}`))).toHaveLength(1);
});

test("a prepared receipt is revalidated against the current release evidence before reuse", async () => {
  const { prepared, current, database } = await trustedPackage();
  await prepared.prepare(projectId, reference);
  const damaged = { ...current, evidence: { ...current.evidence, tests: [{ name: "unit", passed: false }] } };
  await database.execute(sql`UPDATE extension_release_records SET payload=${JSON.stringify(damaged)} WHERE installation_id=${current.installationId} AND kind='releases' AND id=${current.id}`);
  await expect(prepared.prepare(projectId, reference)).rejects.toMatchObject({ code: "factory_package_not_prepared" });
  await expect(prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).rejects.toMatchObject({ code: "factory_package_not_prepared" });
});
test("prepares an exact active v4 release outside the factory transaction and fences dispatch on revocation", async () => {
  const context = await packageContext();
  const { database, source, artifacts, sourceDigest, artifactDigest, current, trusts } = context;
  let hydrated = false;
  let builds = 0;
  const operationIds: string[] = [];
  let crashAfterIntent = true;
  const runner: Pick<Runner, "build" | "collectArtifacts"> = {
    async build(input) {
      builds++;
      operationIds.push(input.operationId);
      expect(input.files).toEqual(source);
      expect(input.sourceDigest).toBe(sourceDigest);
      if (crashAfterIntent) { crashAfterIntent = false; throw new Error("simulated preparation worker crash"); }
      hydrated = true;
      return { operationId: input.operationId, state: "succeeded", sourceDigest, artifactDigest, imageDigest: current.imageDigest, manifest: current.manifest, diagnostics: [], evidence: current.evidence };
    },
    async collectArtifacts(digest) { if (!hydrated || digest !== artifactDigest) throw new Error("artifact absent"); return structuredClone(artifacts); },
  };
  const preparations = context.preparations(runner);
  const binding = await preparations.bind(admin, { projectId, reference, installationId: current.installationId, releaseId: current.id }, "bind-package");
  await trusts.publish(admin, { projectId, reference, expectedRevision: 0 }, "trust-package");
  expect(binding).toMatchObject({ projectId, reference, releaseDigest: current.releaseDigest, sourceDigest, artifactDigest });
  await expect(preparations.prepare(projectId, reference)).rejects.toThrow("simulated preparation worker crash");
  const pending = releaseRows<Record<string, string>>(await database.execute(sql`SELECT state,build_identity,release_digest,source_digest,artifact_digest,image_digest,manifest_digest,evidence_digest FROM factory_runner_preparation_intents WHERE tenant_id=${tenantId} AND project_id=${projectId} AND export_name=${reference.export}`))[0]!;
  expect(pending.state).toBe("prepared");
  expect(pending.release_digest).toBe(current.releaseDigest);
  expect(pending.source_digest).toBe(sourceDigest);
  expect(pending.artifact_digest).toBe(artifactDigest);
  const restartedAfterCrash = context.preparations(runner);
  const receipt = await restartedAfterCrash.prepare(projectId, reference);
  expect(receipt).toMatchObject({ projectId, reference, trustRevision: 1, artifactDigest, releaseDigest: current.releaseDigest });
  expect(builds).toBe(2);
  expect(new Set(operationIds)).toEqual(new Set([pending.build_identity]));
  await expect(preparations.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).resolves.toEqual(receipt);

  await preparations.bind(admin, { projectId, reference: secondReference, installationId: current.installationId, releaseId: current.id }, "bind-second-package");
  await trusts.publish(admin, { projectId, reference: secondReference, expectedRevision: 0 }, "trust-second-package");
  const [readyA, readyB] = await Promise.all([preparations.prepare(projectId, reference), preparations.prepare(projectId, secondReference)]);
  expect(readyA.receiptDigest).toBe(receipt.receiptDigest);
  expect(readyB.reference).toEqual(secondReference);

  await trusts.revoke(admin, { projectId, reference, expectedRevision: 1 }, "revoke-trust");
  await expect(preparations.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).rejects.toMatchObject({ code: "factory_package_revoked" });
  await expect(preparations.assertDispatchReady({ authority: { tenantId, projectId }, runner: secondReference })).resolves.toEqual(readyB);
  await expect(preparations.prepare(projectId, reference)).rejects.toMatchObject({ code: "factory_package_revoked" });
  // An old sealed revision cannot become current again through a damaged pointer.
  const referenceDigest = `sha256:${digestObject(reference)}`;
  await database.execute(sql`UPDATE factory_runner_package_trust_current SET revision=1 WHERE tenant_id=${tenantId} AND project_id=${projectId} AND reference_digest=${referenceDigest}`);
  await expect(preparations.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).rejects.toMatchObject({ code: "factory_package_trust_corrupt" });
  await database.execute(sql`UPDATE factory_runner_package_trust_current SET revision=2 WHERE tenant_id=${tenantId} AND project_id=${projectId} AND reference_digest=${referenceDigest}`);
  expect(factoryPackageDispatchDisposition(new FactoryPackagePreparationError("factory_package_not_prepared"))).toBe("retry");
  expect(factoryPackageDispatchDisposition(new FactoryPackagePreparationError("factory_package_revoked"))).toBe("deny");

  // Revocation is terminal for this pinned tuple. Nothing republishes it, and
  // the replacement is a different pinned definition with its own trust chain.
  await expect(trusts.publish(admin, { projectId, reference, expectedRevision: 2 }, "restore-trust")).rejects.toMatchObject({ code: "factory_package_trust_conflict" });
  await expect(trusts.quarantine(admin, { projectId, reference, expectedRevision: 2 }, "soften-revocation")).rejects.toMatchObject({ code: "factory_package_trust_conflict" });
  await expect(preparations.prepare(projectId, reference)).rejects.toMatchObject({ code: "factory_package_revoked" });

  const replacement: RunnerReference = { ...reference, digest: `sha256:${"d".repeat(64)}` };
  await preparations.bind(admin, { projectId, reference: replacement, installationId: current.installationId, releaseId: current.id }, "bind-replacement");
  await trusts.publish(admin, { projectId, reference: replacement, expectedRevision: 0 }, "trust-replacement");
  const recovered = await preparations.prepare(projectId, replacement);
  expect(recovered).toMatchObject({ trustRevision: 1, artifactDigest, reference: replacement });
  const restarted = context.preparations(runner);
  expect(await restarted.prepare(projectId, replacement)).toEqual(recovered);
  expect(builds).toBe(2);
  // The revoked tuple stays revoked while its replacement dispatches.
  await expect(preparations.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).rejects.toMatchObject({ code: "factory_package_revoked" });
  await expect(preparations.assertDispatchReady({ authority: { tenantId, projectId }, runner: replacement })).resolves.toEqual(recovered);
});

test("rejects tampered binding metadata before a runner build", async () => {
  const context = await packageContext();
  const { database, current } = context;
  let builds = 0;
  const runner: Pick<Runner, "build" | "collectArtifacts"> = { async build() { builds++; throw new Error("must not build"); }, async collectArtifacts() { throw new Error("artifact absent"); } };
  const preparations = context.preparations(runner);
  await preparations.bind(admin, { projectId, reference, installationId: current.installationId, releaseId: current.id }, "bind-package");
  await database.execute(sql`UPDATE factory_runner_package_bindings SET protected_digest=${`sha256:${"0".repeat(64)}`} WHERE tenant_id=${tenantId} AND project_id=${projectId}`);
  await expect(preparations.prepare(projectId, reference)).rejects.toMatchObject({ code: "factory_package_binding_corrupt" });
  expect(builds).toBe(0);
});

test("a rolled-back preparation cannot expose readiness and recovers from its durable intent", async () => {
  const { database, runner, prepared, preparations } = await trustedPackage();
  const transaction = database.transaction.bind(database);
  const rollback = spyOn(database, "transaction").mockImplementation(async <Result>(work: (tx: MigrationDb) => Promise<Result>): Promise<Result> => transaction(async tx => {
    const result = await work(tx);
    const receipts = releaseRows(await tx.execute(sql`SELECT receipt_digest FROM factory_runner_preparation_receipts WHERE tenant_id=${tenantId} AND project_id=${projectId}`));
    if (receipts.length) throw new Error("simulated receipt commit failure");
    return result;
  }));
  try {
    await expect(prepared.prepare(projectId, reference)).rejects.toThrow("simulated receipt commit failure");
  } finally { rollback.mockRestore(); }
  const request = { authority: { tenantId, projectId }, runner: reference };
  await expect(prepared.assertDispatchReady(request)).rejects.toMatchObject({ code: "factory_package_not_prepared" });
  expect(releaseRows(await database.execute(sql`SELECT state FROM factory_runner_preparation_intents WHERE tenant_id=${tenantId} AND project_id=${projectId}`))).toEqual([{ state: "prepared" }]);
  expect(releaseRows(await database.execute(sql`SELECT receipt_digest FROM factory_runner_preparation_receipts WHERE tenant_id=${tenantId} AND project_id=${projectId}`))).toEqual([]);
  const recovered = await preparations(runner).prepare(projectId, reference);
  await expect(prepared.assertDispatchReady(request)).resolves.toEqual(recovered);
});

test.each(["trust", "grant", "admin"] as const)("rechecks %s authority after external hydration and before readiness commits", async revoked => {
  const { database, grants, trusts, runner, prepared } = await trustedPackage();
  const collect = runner.collectArtifacts.bind(runner);
  runner.collectArtifacts = async digest => {
    if (revoked === "trust") await trusts.revoke(admin, { projectId, reference, expectedRevision: 1 }, "revoke-during-prepare");
    else if (revoked === "grant") await grants.revoke(admin, { projectId, principal: admin, action: "factory.trust", expectedRevision: 1 });
    else await database.execute(sql`UPDATE users SET role='user' WHERE id=${admin.id}`);
    return collect(digest);
  };
  await expect(prepared.prepare(projectId, reference)).rejects.toThrow();
  expect(releaseRows(await database.execute(sql`SELECT receipt_digest FROM factory_runner_preparation_receipts WHERE tenant_id=${tenantId} AND project_id=${projectId}`))).toEqual([]);
  await expect(prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).rejects.toThrow();
});

test.each(["model", "configurationDigest"] as const)("keeps %s package identity separate at binding, preparation, and revocation", async field => {
  const { current, trusts, prepared } = await trustedPackage();
  const otherReference: RunnerReference = { ...reference, [field]: field === "model" ? "another-model" : `sha256:${"d".repeat(64)}` };
  await prepared.bind(admin, { projectId, reference: otherReference, installationId: current.installationId, releaseId: current.id }, `bind-${field}`);
  await trusts.publish(admin, { projectId, reference: otherReference, expectedRevision: 0 }, `trust-${field}`);
  const first = await prepared.prepare(projectId, reference);
  const second = await prepared.prepare(projectId, otherReference);
  expect(second.reference).toEqual(otherReference);
  expect(second.receiptDigest).not.toBe(first.receiptDigest);
  await trusts.revoke(admin, { projectId, reference, expectedRevision: 1 }, `revoke-${field}`);
  await expect(prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).rejects.toMatchObject({ code: "factory_package_revoked" });
  await expect(prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: otherReference })).resolves.toEqual(second);
});

test.each(["trust", "intent", "receipt"] as const)("rejects a damaged %s seal through the preparation or dispatch path", async target => {
  const { database, runner, prepared } = await trustedPackage();
  const damaged = `sha256:${"0".repeat(64)}`;
  if (target === "trust") {
    await database.execute(sql`UPDATE factory_runner_package_trust_revisions SET protected_digest=${damaged} WHERE tenant_id=${tenantId} AND project_id=${projectId}`);
    await expect(prepared.prepare(projectId, reference)).rejects.toMatchObject({ code: "factory_package_trust_corrupt" });
  } else if (target === "intent") {
    const collect = runner.collectArtifacts.bind(runner);
    runner.collectArtifacts = async digest => {
      await database.execute(sql`UPDATE factory_runner_preparation_intents SET intent_digest=${damaged} WHERE tenant_id=${tenantId} AND project_id=${projectId}`);
      return collect(digest);
    };
    await expect(prepared.prepare(projectId, reference)).rejects.toMatchObject({ code: "factory_package_intent_corrupt" });
  } else {
    await prepared.prepare(projectId, reference);
    await database.execute(sql`UPDATE factory_runner_preparation_receipts SET receipt_digest=${damaged} WHERE tenant_id=${tenantId} AND project_id=${projectId}`);
    await expect(prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).rejects.toMatchObject({ code: "factory_package_receipt_corrupt" });
  }
});

test("quarantine blocks dispatch, fences live attempts, and is lifted only by an explicit re-publish", async () => {
  const { trusts, runner, prepared, fenced, database } = await trustedPackage();
  const receipt = await prepared.prepare(projectId, reference);
  expect(await prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).toEqual(receipt);

  const quarantined = await trusts.quarantine(admin, { projectId, reference, expectedRevision: 1 }, "quarantine-package");
  expect(quarantined).toMatchObject({ revision: 2, state: "quarantined", installationGeneration: 1 });
  expect(fenced).toEqual([{ state: "quarantined", trustRevision: 2, reference }]);
  await expect(prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).rejects.toMatchObject({ code: "factory_package_quarantined" });
  await expect(prepared.prepare(projectId, reference)).rejects.toMatchObject({ code: "factory_package_quarantined" });
  expect(factoryPackageDispatchDisposition(new FactoryPackagePreparationError("factory_package_quarantined"))).toBe("deny");

  // Nothing lifts a quarantine but an explicit human re-publish at the next revision.
  await expect(trusts.quarantine(admin, { projectId, reference, expectedRevision: 2 }, "quarantine-again")).rejects.toMatchObject({ code: "factory_package_trust_conflict" });
  const restored = await trusts.publish(admin, { projectId, reference, expectedRevision: 2 }, "lift-quarantine");
  expect(restored).toMatchObject({ revision: 3, state: "active" });
  // A receipt is keyed to its trust revision, so the lifted package is prepared
  // again before it may dispatch: quarantine does not resurrect an old receipt.
  await expect(prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).rejects.toMatchObject({ code: "factory_package_not_prepared" });
  expect(await prepared.prepare(projectId, reference)).toMatchObject({ trustRevision: 3 });
  expect(await prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).toBeDefined();

  // Every earlier decision is preserved rather than overwritten.
  const history = releaseRows<{ revision: number | string; state: string }>(await database.execute(sql`SELECT revision,state FROM factory_runner_package_trust_revisions WHERE tenant_id=${tenantId} AND project_id=${projectId} AND reference_digest=${digestReference(reference)} ORDER BY revision`));
  expect(history.map(row => `${Number(row.revision)}:${row.state}`)).toEqual(["1:active", "2:quarantined", "3:active"]);
  void runner;
});

test("revocation fences live attempts and can follow a quarantine without a return to active first", async () => {
  const { trusts, prepared, fenced } = await trustedPackage();
  await prepared.prepare(projectId, reference);
  await trusts.quarantine(admin, { projectId, reference, expectedRevision: 1 }, "quarantine-before-revoke");
  const revoked = await trusts.revoke(admin, { projectId, reference, expectedRevision: 2 }, "revoke-after-quarantine");
  expect(revoked).toMatchObject({ revision: 3, state: "revoked" });
  expect(fenced.map(entry => entry.state)).toEqual(["quarantined", "revoked"]);
  await expect(prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).rejects.toMatchObject({ code: "factory_package_revoked" });
});

test("revocation is terminal for its pinned tuple and no transition leaves it", async () => {
  const { trusts, prepared, fenced, database } = await trustedPackage();
  await prepared.prepare(projectId, reference);
  await trusts.revoke(admin, { projectId, reference, expectedRevision: 1 }, "revoke-terminal");
  expect(fenced.map(entry => entry.state)).toEqual(["revoked"]);
  for (const transition of ["publish", "quarantine", "revoke"] as const) {
    await expect(trusts[transition](admin, { projectId, reference, expectedRevision: 2 }, `after-revoke-${transition}`)).rejects.toMatchObject({ code: "factory_package_trust_conflict" });
  }
  await expect(prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).rejects.toMatchObject({ code: "factory_package_revoked" });
  // Only two revisions exist: nothing reopened the revoked bytes.
  const history = releaseRows<{ revision: number | string; state: string }>(await database.execute(sql`SELECT revision,state FROM factory_runner_package_trust_revisions WHERE tenant_id=${tenantId} AND project_id=${projectId} AND reference_digest=${digestReference(reference)} ORDER BY revision`));
  expect(history.map(row => `${Number(row.revision)}:${row.state}`)).toEqual(["1:active", "2:revoked"]);
});

test("a stop path that crashes mid-fence leaves the package active rather than half-quarantined", async () => {
  const { trusts, prepared, fenced, fence, database } = await trustedPackage();
  const receipt = await prepared.prepare(projectId, reference);

  fence.fail = true;
  await expect(trusts.quarantine(admin, { projectId, reference, expectedRevision: 1 }, "quarantine-crash")).rejects.toThrow("stop path crashed mid-fence");
  // The fence ran inside the transaction, so its failure took the state with it:
  // no half-state where dispatch is blocked but no attempt was ever fenced.
  expect(fenced.map(entry => entry.state)).toEqual(["quarantined"]);
  const afterCrash = releaseRows<{ revision: number | string; state: string }>(await database.execute(sql`SELECT revision,state FROM factory_runner_package_trust_revisions WHERE tenant_id=${tenantId} AND project_id=${projectId} AND reference_digest=${digestReference(reference)} ORDER BY revision`));
  expect(afterCrash.map(row => `${Number(row.revision)}:${row.state}`)).toEqual(["1:active"]);
  expect(await prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).toEqual(receipt);

  // The retry, with the stop path healthy, commits both together.
  fence.fail = false;
  expect(await trusts.quarantine(admin, { projectId, reference, expectedRevision: 1 }, "quarantine-retry")).toMatchObject({ revision: 2, state: "quarantined" });
  await expect(prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).rejects.toMatchObject({ code: "factory_package_quarantined" });
});

test("a quarantine cannot be declared for a package that was never trusted or at the wrong revision", async () => {
  const { trusts } = await trustedPackage();
  // Revision 0 means "never trusted", which no blocking transition may follow.
  await expect(trusts.quarantine(admin, { projectId, reference, expectedRevision: 0 }, "quarantine-wrong-revision")).rejects.toMatchObject({ code: "factory_package_trust_invalid" });
  await expect(trusts.quarantine(admin, { projectId, reference, expectedRevision: 2 }, "quarantine-ahead")).rejects.toMatchObject({ code: "factory_package_trust_conflict" });
  await expect(trusts.quarantine(admin, { projectId, reference: secondReference, expectedRevision: 1 }, "quarantine-untrusted")).rejects.toMatchObject({ code: "factory_package_trust_conflict" });
  await expect(trusts.quarantine(admin, { projectId, reference, expectedRevision: -1 }, "quarantine-negative")).rejects.toMatchObject({ code: "factory_package_trust_invalid" });
});

test("a decision taken against an earlier v4 installation generation no longer authorizes dispatch", async () => {
  const { trusts, prepared, repo, database } = await trustedPackage();
  await prepared.prepare(projectId, reference);
  // The v4 lifecycle increments the installation generation on activation and on
  // disable. The trust decision is fenced to the generation it was taken against.
  await repo.transact("package-installation", state => { state.installation.generation += 1; });
  await expect(prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).rejects.toMatchObject({ code: "factory_package_fence_stale" });
  expect(factoryPackageDispatchDisposition(new FactoryPackagePreparationError("factory_package_fence_stale"))).toBe("deny");
  const refreshed = await trusts.publish(admin, { projectId, reference, expectedRevision: 1 }, "retrust-after-generation");
  expect(refreshed).toMatchObject({ revision: 2, state: "active", installationGeneration: 2 });
  expect(await prepared.prepare(projectId, reference)).toMatchObject({ trustRevision: 2 });
  await expect(prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).resolves.toBeDefined();
  void database;
});

test("a tampered trust state or generation is refused rather than trusted", async () => {
  const { prepared, database } = await trustedPackage();
  await prepared.prepare(projectId, reference);
  const where = sql`tenant_id=${tenantId} AND project_id=${projectId} AND reference_digest=${digestReference(reference)} AND revision=1`;
  await database.execute(sql`UPDATE factory_runner_package_trust_revisions SET state='quarantined' WHERE ${where}`);
  await expect(prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).rejects.toMatchObject({ code: "factory_package_trust_corrupt" });
  await database.execute(sql`UPDATE factory_runner_package_trust_revisions SET state='active', installation_generation=99 WHERE ${where}`);
  await expect(prepared.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference })).rejects.toMatchObject({ code: "factory_package_trust_corrupt" });
});
}
