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
import { type FactoryPackagePreparationError, FactoryPackagePreparations, FactoryPackageTrusts, FactoryV4PackageCatalog } from "./package-preparation";
import { productExtensionRunner } from "../extensions/runner-rehydration";
import { getReadiness, resetReadiness } from "../readiness";
import { FactoryRecords } from "./records";

const tenantId = "podman-package-tenant";
const projectId = "podman-package-project";
const admin: FactoryPrincipal = { kind: "user", id: "podman-package-admin", authentication: "session" };

function record(build: Awaited<ReturnType<Runner["build"]>>, sourceDigest: string): ReleaseRecord {
  if (build.state !== "succeeded" || !build.artifactDigest || !build.manifest) throw new Error("initial v4 build failed");
  const input = { installationId: "podman-package-installation", workspaceId: "workspace", workspaceRevision: 1, sourceDigest, artifactDigest: build.artifactDigest, imageDigest: build.imageDigest, manifest: build.manifest, evidence: build.evidence, runnerProfile: "rootless-podman-v4", policyDigest: digestObject({ runner: "v4" }) };
  return { ...input, id: "podman-package-release", releaseDigest: digestObject(input), createdAt: "2030-01-01T00:00:00.000Z" };
}

test("a fresh real Podman runner store is restored from the product's blob copy, never rebuilt, and the preparation keeps a durable receipt (W4H-32)", async () => {
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
    // The lifecycle keeps the product's own copy of every release artifact beside its source.
    expect(await putFiles(blobs, await publisher.collectArtifacts(initial.artifactDigest!), "artifact")).toBe(initial.artifactDigest!);
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
    let builds = 0;
    const build = consumer.build.bind(consumer);
    consumer.build = async input => { builds++; return build(input); };
    // A runner nothing wraps: its fresh store's artifact_missing is refused by name, never rebuilt (C10 amendment W4H-32).
    const unwrapped = new FactoryPackagePreparations(db, tenantId, grants, trusts, new FactoryV4PackageCatalog(repository, blobs), consumer, buildLimits);
    await unwrapped.bind(admin, { projectId, reference, installationId: release.installationId, releaseId: release.id }, "podman-bind");
    await trusts.publish(admin, { projectId, reference, expectedRevision: 0 }, "podman-trust");
    const refusal = await unwrapped.prepare(projectId, reference).catch((error: unknown) => error) as FactoryPackagePreparationError;
    expect(refusal).toMatchObject({ code: "factory_package_artifact_unavailable" });
    expect(JSON.parse(refusal.detail!)).toMatchObject({ code: "artifact_missing", errorCode: "ENOENT" });
    // The product's runner restores the artifact from the blob copy and the preparation completes without a build.
    resetReadiness();
    const product = productExtensionRunner(blobs, db, consumer);
    const preparations = new FactoryPackagePreparations(db, tenantId, grants, trusts, new FactoryV4PackageCatalog(repository, blobs), product, buildLimits);
    const receipt = await preparations.prepare(projectId, reference);
    expect(builds).toBe(0);
    expect(getReadiness().warnings).toEqual([{ code: "runner_artifact_rehydrated", artifactDigest: release.artifactDigest, count: 1 }]);
    expect(receipt).toMatchObject({ reference, artifactDigest: release.artifactDigest, sourceDigest, releaseDigest: release.releaseDigest, trustRevision: 1 });
    expect(filesDigest(await consumer.collectArtifacts(receipt.artifactDigest))).toBe(receipt.artifactDigest);
    const context = { workerId: "prepared-package-worker", invocationId: "prepared-package-invocation", releaseId: receipt.artifactDigest, principalId: tenantId, scopeId: projectId, token: "local-test", deadline: Date.now() + 30_000 };
    const worker = await consumer.start({ workerId: context.workerId, artifactDigest: receipt.artifactDigest, context, limits: executionLimits }, async () => { throw new Error("unexpected host call"); });
    try { expect(await worker.request("extension/invoke", { name: reference.export, input: { prepared: true }, context })).toEqual({ prepared: true }); }
    finally { await worker.close(); }
    const restarted = new FactoryPackagePreparations(db, tenantId, grants, trusts, new FactoryV4PackageCatalog(repository, blobs), product, buildLimits);
    expect(await restarted.prepare(projectId, reference)).toEqual(receipt);
    expect(builds).toBe(0);
  } finally {
    await consumer?.close();
    await publisher?.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
