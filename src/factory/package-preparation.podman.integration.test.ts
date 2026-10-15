import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { PodmanRunner, buildLimits, executionLimits, filesDigest } from "@ezcorp/extension-runner";
import type { ReleaseRecord, Runner } from "@ezcorp/extension-contract";
import type { RunnerReference } from "@ezcorp/factory-sdk";
import { provision, source } from "../../packages/@ezcorp/extension-runner/tests/helpers";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { digestObject, FileBlobStore, putFiles } from "../extensions/v4/blobs";
import { FactoryGrants, type FactoryPrincipal } from "./grants";
import { FactoryPackagePreparations, FactoryPackageTrusts, FactoryV4PackageCatalog } from "./package-preparation";
import { FactoryRecords } from "./records";

const tenantId = "podman-package-tenant";
const projectId = "podman-package-project";
const admin: FactoryPrincipal = { kind: "user", id: "podman-package-admin", authentication: "session" };

function record(build: Awaited<ReturnType<Runner["build"]>>, sourceDigest: string): ReleaseRecord {
  if (build.state !== "succeeded" || !build.artifactDigest || !build.manifest) throw new Error("initial v4 build failed");
  const input = { installationId: "podman-package-installation", workspaceId: "workspace", workspaceRevision: 1, sourceDigest, artifactDigest: build.artifactDigest, imageDigest: build.imageDigest, manifest: build.manifest, evidence: build.evidence, runnerProfile: "rootless-podman-v4", policyDigest: digestObject({ runner: "v4" }) };
  return { ...input, id: "podman-package-release", releaseDigest: digestObject(input), createdAt: "2030-01-01T00:00:00.000Z" };
}

test("rebuilds the exact immutable v4 source into a fresh real Podman runner and retains a durable receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-package-preparation-"));
  const publisherRoot = join(root, "publisher-runner");
  const consumerRoot = join(root, "consumer-runner");
  const blobRoot = join(root, "release-blobs");
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  let publisher: PodmanRunner | undefined;
  let consumer: PodmanRunner | undefined;
  try {
    await database.waitReady;
    const db = drizzle(database, { schema });
    await migrate(db);
    const files = source("async(input)=>input");
    publisher = new PodmanRunner({ root: publisherRoot, ...await provision() });
    const initial = await publisher.build({ operationId: "published-v4-package", sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
    expect(initial.state).toBe("succeeded");
    expect(initial.diagnostics).toEqual([]);
    const blobs = new FileBlobStore(blobRoot);
    const sourceDigest = await putFiles(blobs, files, "workspace");
    const release = record(initial, sourceDigest);
    const reference: RunnerReference = { package: `@ezcorp/${release.manifest.name}`, manifestName: release.manifest.name, version: release.manifest.version, digest: `sha256:${release.artifactDigest}`, export: "echo" };
    const records = new FactoryRecords(db, tenantId);
    await records.bindInstallation();
    await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Podman package','/tmp/podman-package')`);
    await db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${admin.id},'podman-package@example.test','x','Podman package','admin')`);
    await db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('podman-package-member',${projectId},${admin.id},'owner')`);
    await records.bindProject(projectId);
    const grants = new FactoryGrants(db, tenantId);
    await grants.set(admin, { projectId, principal: admin, action: "factory.trust", expectedRevision: 0, expiresAtMs: null });
    const repository = new DatabaseLifecycleRepository(db);
    await repository.create({ installation: { id: release.installationId, ownerId: admin.id, scope: `project:${projectId}`, generation: 1, activeReleaseId: release.id, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 1 }, workspaces: {}, revisions: {}, operations: {}, releases: { [release.id]: release }, approvals: {} });
    const trusts = new FactoryPackageTrusts(db, tenantId, grants);
    consumer = new PodmanRunner({ root: consumerRoot, ...await provision() });
    const preparations = new FactoryPackagePreparations(db, tenantId, grants, trusts, new FactoryV4PackageCatalog(repository, blobs), consumer, buildLimits);
    await preparations.bind(admin, { projectId, reference, installationId: release.installationId, releaseId: release.id }, "podman-bind");
    await trusts.publish(admin, { projectId, reference, expectedRevision: 0 }, "podman-trust");
    const receipt = await preparations.prepare(projectId, reference);
    expect(receipt).toMatchObject({ reference, artifactDigest: release.artifactDigest, sourceDigest, releaseDigest: release.releaseDigest, trustRevision: 1 });
    expect(filesDigest(await consumer.collectArtifacts(receipt.artifactDigest))).toBe(receipt.artifactDigest);
    const context = { workerId: "prepared-package-worker", invocationId: "prepared-package-invocation", releaseId: receipt.artifactDigest, principalId: tenantId, scopeId: projectId, token: "local-test", deadline: Date.now() + 30_000 };
    const worker = await consumer.start({ workerId: context.workerId, artifactDigest: receipt.artifactDigest, context, limits: executionLimits }, async () => { throw new Error("unexpected host call"); });
    try { expect(await worker.request("extension/invoke", { name: reference.export, input: { prepared: true }, context })).toEqual({ prepared: true }); }
    finally { await worker.close(); }
    const restarted = new FactoryPackagePreparations(db, tenantId, grants, trusts, new FactoryV4PackageCatalog(repository, blobs), consumer, buildLimits);
    expect(await restarted.prepare(projectId, reference)).toEqual(receipt);
  } finally {
    await consumer?.close();
    await publisher?.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
