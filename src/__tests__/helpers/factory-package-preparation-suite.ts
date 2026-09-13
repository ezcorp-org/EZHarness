import { afterEach, beforeEach, expect, test } from "bun:test";
import { canonicalJson, type ReleaseRecord, type ResourceLimits, type Runner, type WorkspaceFiles } from "@ezcorp/extension-contract";
import type { RunnerReference } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../../db/migrations/types";
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
const secondReference: RunnerReference = { ...reference, export: "echo-second" };
const limits: ResourceLimits = { memoryBytes: 64 * 1024 * 1024, cpuMillis: 1000, pids: 16, tmpBytes: 1024 * 1024, outputBytes: 1024 * 1024, timeoutMs: 10_000 };

function release(sourceDigest: string, artifactDigest: string): ReleaseRecord {
  const manifest = { schemaVersion: 4 as const, name: reference.package, version: reference.version, author: { name: "Package test" }, description: "Factory package", permissions: {}, tools: [{ name: reference.export, description: "Echo", inputSchema: { type: "object" }, outputSchema: { type: "object" } }, { name: secondReference.export, description: "Second echo", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] };
  const input = { installationId: "package-installation", workspaceId: "workspace", workspaceRevision: 1, sourceDigest, artifactDigest, imageDigest: "podman-image@sha256:test", manifest, evidence: { protocolVersion: 4 as const, validatorVersion: "runner-v4", discoveryDigest: digestObject(manifest), tests: [{ name: "unit", passed: true }] }, runnerProfile: "podman-v4", policyDigest: digestObject({ policy: "v4" }) };
  return { ...input, id: "package-release", releaseDigest: digestObject(input), createdAt: "2030-01-01T00:00:00.000Z" };
}

export function factoryPackagePreparationConformance(create: () => Promise<FactoryPackagePreparationFixture>): void {
let fixture: FactoryPackagePreparationFixture;
beforeEach(async () => { fixture = await create(); });
afterEach(async () => { await fixture?.close(); });
test("prepares an exact active v4 release outside the factory transaction and fences dispatch on revocation", async () => {
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
  await repo.create({ installation: { id: "package-installation", ownerId: admin.id, scope: `project:${projectId}`, generation: 1, activeReleaseId: current.id, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 1 }, workspaces: {}, revisions: {}, operations: {}, releases: { [current.id]: current }, approvals: {} });
  const trusts = new FactoryPackageTrusts(database, tenantId, grants);
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
  const preparations = new FactoryPackagePreparations(database, tenantId, grants, trusts, new FactoryV4PackageCatalog(repo, blobs), runner, limits);
  const binding = await preparations.bind(admin, { projectId, reference, installationId: current.installationId, releaseId: current.id }, "bind-package");
  await trusts.publish(admin, { projectId, reference, expectedRevision: 0 }, "trust-package");
  expect(binding).toMatchObject({ projectId, reference, releaseDigest: current.releaseDigest, sourceDigest, artifactDigest });
  await expect(preparations.prepare(projectId, reference)).rejects.toThrow("simulated preparation worker crash");
  const pending = releaseRows<Record<string, string>>(await database.execute(sql`SELECT state,build_identity,release_digest,source_digest,artifact_digest,image_digest,manifest_digest,evidence_digest FROM factory_runner_preparation_intents WHERE tenant_id=${tenantId} AND project_id=${projectId} AND export_name=${reference.export}`))[0]!;
  expect(pending.state).toBe("prepared");
  expect(pending.release_digest).toBe(current.releaseDigest);
  expect(pending.source_digest).toBe(sourceDigest);
  expect(pending.artifact_digest).toBe(artifactDigest);
  const restartedAfterCrash = new FactoryPackagePreparations(database, tenantId, grants, trusts, new FactoryV4PackageCatalog(repo, blobs), runner, limits);
  const receipt = await restartedAfterCrash.prepare(projectId, reference);
  expect(receipt).toMatchObject({ projectId, reference, trustRevision: 1, artifactDigest, releaseDigest: current.releaseDigest });
  expect(builds).toBe(2);
  expect(new Set(operationIds)).toEqual(new Set([pending.build_identity]));
  await expect(preparations.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference } as never)).resolves.toEqual(receipt);

  await preparations.bind(admin, { projectId, reference: secondReference, installationId: current.installationId, releaseId: current.id }, "bind-second-package");
  await trusts.publish(admin, { projectId, reference: secondReference, expectedRevision: 0 }, "trust-second-package");
  const [readyA, readyB] = await Promise.all([preparations.prepare(projectId, reference), preparations.prepare(projectId, secondReference)]);
  expect(readyA.receiptDigest).toBe(receipt.receiptDigest);
  expect(readyB.reference).toEqual(secondReference);

  await trusts.revoke(admin, { projectId, reference, expectedRevision: 1 }, "revoke-trust");
  await expect(preparations.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference } as never)).rejects.toMatchObject({ code: "factory_package_revoked" });
  await expect(preparations.assertDispatchReady({ authority: { tenantId, projectId }, runner: secondReference } as never)).resolves.toEqual(readyB);
  await expect(preparations.prepare(projectId, reference)).rejects.toMatchObject({ code: "factory_package_revoked" });
  expect(factoryPackageDispatchDisposition(new FactoryPackagePreparationError("factory_package_not_prepared"))).toBe("retry");
  expect(factoryPackageDispatchDisposition(new FactoryPackagePreparationError("factory_package_revoked"))).toBe("deny");

  await trusts.publish(admin, { projectId, reference, expectedRevision: 2 }, "restore-trust");
  const recovered = await preparations.prepare(projectId, reference);
  expect(recovered).toMatchObject({ trustRevision: 3, artifactDigest });
  const restarted = new FactoryPackagePreparations(database, tenantId, grants, trusts, new FactoryV4PackageCatalog(repo, blobs), runner, limits);
  expect(await restarted.prepare(projectId, reference)).toEqual(recovered);
  expect(builds).toBe(2);
});

test("rejects tampered binding metadata before a runner build", async () => {
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
  const artifacts: WorkspaceFiles = { "extension.ts": "export {};" };
  const sourceDigest = await blobs.put(new TextEncoder().encode(canonicalJson(source)));
  const current = release(sourceDigest, digestObject(artifacts));
  const repo = new DatabaseLifecycleRepository(database);
  await repo.create({ installation: { id: "package-installation", ownerId: admin.id, scope: `project:${projectId}`, generation: 1, activeReleaseId: current.id, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 1 }, workspaces: {}, revisions: {}, operations: {}, releases: { [current.id]: current }, approvals: {} });
  const trusts = new FactoryPackageTrusts(database, tenantId, grants);
  let builds = 0;
  const runner: Pick<Runner, "build" | "collectArtifacts"> = { async build() { builds++; throw new Error("must not build"); }, async collectArtifacts() { throw new Error("artifact absent"); } };
  const preparations = new FactoryPackagePreparations(database, tenantId, grants, trusts, new FactoryV4PackageCatalog(repo, blobs), runner, limits);
  await preparations.bind(admin, { projectId, reference, installationId: current.installationId, releaseId: current.id }, "bind-package");
  await database.execute(sql`UPDATE factory_runner_package_bindings SET protected_digest=${`sha256:${"0".repeat(64)}`} WHERE tenant_id=${tenantId} AND project_id=${projectId}`);
  await expect(preparations.prepare(projectId, reference)).rejects.toMatchObject({ code: "factory_package_binding_corrupt" });
  expect(builds).toBe(0);
});

}
