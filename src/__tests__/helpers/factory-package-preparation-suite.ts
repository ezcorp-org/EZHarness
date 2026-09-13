import { afterEach, beforeEach, expect, test } from "bun:test";
import { canonicalJson, type ReleaseRecord, type ResourceLimits, type Runner, type WorkspaceFiles } from "@ezcorp/extension-contract";
import type { RunnerReference } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../../db/migrations/types";
import { DatabaseLifecycleRepository } from "../../db/queries/extension-releases";
import { digestObject } from "../../extensions/v4/blobs";
import type { BlobStore } from "../../extensions/v4/types";
import { FactoryArtifacts } from "../../factory/artifacts";
import { FactoryExecutionJournal } from "../../factory/executions";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryPackagePreparationError, FactoryPackagePreparations, FactoryV4PackageCatalog, factoryPackageDispatchDisposition } from "../../factory/package-preparation";
import { FactoryRecords } from "../../factory/records";
import { FactoryReleaseAuthorityStore, type FactoryReleaseRunLifecycle } from "../../factory/release-authority";

export interface FactoryPackagePreparationFixture { readonly db: TransactionalDb; readonly blobs: BlobStore; close(): Promise<void>; }

const tenantId = "package-tenant";
const projectId = "package-project";
const admin: FactoryPrincipal = { kind: "user", id: "package-admin", authentication: "session" };
const reference: RunnerReference = { package: "package-runner", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, export: "echo" };
const limits: ResourceLimits = { memoryBytes: 64 * 1024 * 1024, cpuMillis: 1000, pids: 16, tmpBytes: 1024 * 1024, outputBytes: 1024 * 1024, timeoutMs: 10_000 };

class PackageLifecycle implements FactoryReleaseRunLifecycle {
  readonly tenantId = tenantId;
  async authorizeRunInTransaction(): Promise<never> { throw new Error("package preparation does not authorize a run"); }
}

function release(sourceDigest: string, artifactDigest: string): ReleaseRecord {
  const manifest = { schemaVersion: 4 as const, name: reference.package, version: reference.version, author: { name: "Package test" }, description: "Factory package", permissions: {}, tools: [{ name: reference.export, description: "Echo", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] };
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
  const journal = new FactoryExecutionJournal(database, async () => {});
  const authority = new FactoryReleaseAuthorityStore(database, tenantId, grants, new PackageLifecycle(), journal, new FactoryArtifacts(database, blobs, tenantId));
  await authority.publishTrust(admin, { projectId, expectedRevision: 0, packageLock: reference, validatorTrustDigest: `sha256:${"b".repeat(64)}` }, "publish-trust");
  let hydrated = false;
  let builds = 0;
  const runner: Pick<Runner, "build" | "collectArtifacts"> = {
    async build(input) {
      builds++;
      expect(input.files).toEqual(source);
      expect(input.sourceDigest).toBe(sourceDigest);
      hydrated = true;
      return { operationId: input.operationId, state: "succeeded", sourceDigest, artifactDigest, imageDigest: current.imageDigest, manifest: current.manifest, diagnostics: [], evidence: current.evidence };
    },
    async collectArtifacts(digest) { if (!hydrated || digest !== artifactDigest) throw new Error("artifact absent"); return structuredClone(artifacts); },
  };
  const preparations = new FactoryPackagePreparations(database, tenantId, grants, authority, new FactoryV4PackageCatalog(repo, blobs), runner, limits);
  const binding = await preparations.bind(admin, { projectId, reference, installationId: current.installationId, releaseId: current.id }, "bind-package");
  expect(binding).toMatchObject({ projectId, reference, releaseDigest: current.releaseDigest, sourceDigest, artifactDigest });
  const receipt = await preparations.prepare(projectId, reference);
  expect(receipt).toMatchObject({ projectId, reference, trustRevision: 1, artifactDigest, releaseDigest: current.releaseDigest });
  expect(builds).toBe(1);
  await expect(preparations.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference } as never)).resolves.toEqual(receipt);
  expect(preparations.assertLocal({ authority: { tenantId, projectId }, runner: reference } as never)).toEqual(receipt);

  await authority.revokeTrust(admin, projectId, 1, "revoke-trust");
  await expect(preparations.assertDispatchReady({ authority: { tenantId, projectId }, runner: reference } as never)).rejects.toMatchObject({ code: "factory_package_revoked" });
  await expect(preparations.prepare(projectId, reference)).rejects.toMatchObject({ code: "factory_package_revoked" });
  expect(factoryPackageDispatchDisposition(new FactoryPackagePreparationError("factory_package_not_prepared"))).toBe("retry");
  expect(factoryPackageDispatchDisposition(new FactoryPackagePreparationError("factory_package_revoked"))).toBe("deny");

  await authority.publishTrust(admin, { projectId, expectedRevision: 2, packageLock: reference, validatorTrustDigest: `sha256:${"b".repeat(64)}` }, "restore-trust");
  const recovered = await preparations.prepare(projectId, reference);
  expect(recovered).toMatchObject({ trustRevision: 3, artifactDigest });
  const restarted = new FactoryPackagePreparations(database, tenantId, grants, authority, new FactoryV4PackageCatalog(repo, blobs), runner, limits);
  expect(await restarted.prepare(projectId, reference)).toEqual(recovered);
  expect(restarted.assertLocal({ authority: { tenantId, projectId }, runner: reference } as never)).toEqual(recovered);
  expect(builds).toBe(1);
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
  const authority = new FactoryReleaseAuthorityStore(database, tenantId, grants, new PackageLifecycle(), new FactoryExecutionJournal(database, async () => {}), new FactoryArtifacts(database, blobs, tenantId));
  await authority.publishTrust(admin, { projectId, expectedRevision: 0, packageLock: reference, validatorTrustDigest: `sha256:${"b".repeat(64)}` }, "publish-trust");
  let builds = 0;
  const runner: Pick<Runner, "build" | "collectArtifacts"> = { async build() { builds++; throw new Error("must not build"); }, async collectArtifacts() { throw new Error("artifact absent"); } };
  const preparations = new FactoryPackagePreparations(database, tenantId, grants, authority, new FactoryV4PackageCatalog(repo, blobs), runner, limits);
  await preparations.bind(admin, { projectId, reference, installationId: current.installationId, releaseId: current.id }, "bind-package");
  await database.execute(sql`UPDATE factory_runner_package_bindings SET protected_digest=${`sha256:${"0".repeat(64)}`} WHERE tenant_id=${tenantId} AND project_id=${projectId}`);
  await expect(preparations.prepare(projectId, reference)).rejects.toMatchObject({ code: "factory_package_binding_corrupt" });
  expect(builds).toBe(0);
});

}
