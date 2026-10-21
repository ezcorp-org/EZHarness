import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { FACTORY_REPOSITORY_TREE_SCHEMA_VERSION, type FactoryRunnerRequest, type JsonValue } from "@ezcorp/factory-sdk";
import { FactoryGuestMaterialError, readFactoryGuestRepository } from "@ezcorp/factory-sdk/guest-materials";
import { referenceCodeGitRepository } from "../../__tests__/helpers/git-repository-fixture";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { FileBlobStore } from "../../extensions/v4/blobs";
import { FactoryArtifacts } from "../artifacts";
import { FactoryAttemptMaterials } from "../artifact-materials";
import { FactoryExecutionJournal } from "../executions";
import { factoryGitTreeId } from "../git-objects";
import { referenceCodeLaunchRepository } from "../reference-code/fixtures";
import { referenceCodeFilesFromWire } from "../reference-code/snapshot";
import { factoryRunnerRequestAuthority } from "./attempt-authority";
import { createFactoryGuestMaterialBroker, createFactoryGuestMaterialServices } from "./guest-material-broker";
import { createFactoryGuestRepositoryReadBroker, factoryGuestRepositoryUnconfigured, type FactoryRepositorySource } from "./guest-repository-read";

/**
 * The repository-read broker operation against a real git repository and a real material store
 * (W4H-28 P2). The source is a local repository over `file://`, which the host fetches exactly as it
 * would a remote: one commit, no ambient configuration, the token (when declared) by reference only.
 */

const TENANT = "tenant-repository";
const directories: string[] = [];
const closing: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closing.splice(0).map(close => close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

/** A fixture repository whose directory this suite removes. */
async function repository(extra: Record<string, string> = {}) {
  const made = await referenceCodeGitRepository(extra);
  directories.push(made.root);
  return made;
}

async function setup(sources: (root: string) => readonly FactoryRepositorySource[]) {
  const { db, pglite } = await setupTestDb();
  closing.push(() => pglite.close());
  const projectId = `repository-project-${randomUUID()}`;
  const runId = `repository-run-${randomUUID()}`;
  await db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${projectId}, 'Repository', ${`/tmp/${projectId}`})`);
  await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${TENANT}, 6) ON CONFLICT (singleton) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, execution_epoch=EXCLUDED.execution_epoch`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${TENANT}, ${projectId})`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${TENANT}, ${projectId}, ${runId}, ${`sha256:${"a".repeat(64)}`}, 'test', 6, 'request', '{}')`);
  const root = await mkdtemp(join(tmpdir(), "repository-read-"));
  directories.push(root);
  const blobs = new FileBlobStore(join(root, "blobs"));
  const artifacts = new FactoryArtifacts(db, blobs, TENANT);
  const journal = new FactoryExecutionJournal(db, async () => {});
  const attemptId = `repository-attempt-${randomUUID()}`;
  const request = {
    schemaVersion: "factory.runner.request.v1",
    authority: { attemptId, tenantId: TENANT, projectId, runId, nodeInstanceId: "snapshot-repository", candidateGeneration: 0, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 6, cancellationEpoch: 0, deadlineAtMs: Date.now() + 600_000, nextOperationIndex: 0 },
    runner: { package: "@example/runner", manifestName: "runner", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, export: "run" },
    input: { kind: "inline", value: {} }, grants: [], resources: {}, tools: [], broker: { attemptToken: "t", audience: "a" },
  } as unknown as FactoryRunnerRequest;
  const authority = factoryRunnerRequestAuthority(request);
  await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status)
    VALUES (${attemptId},${TENANT},${projectId},${runId},'snapshot-repository',0,1,1,1,6,0,${authority.deadlineAt},${authority.requestDigest},'{}'::jsonb,'admitted')`);
  const source = await repository();
  const tokens: string[] = [];
  const repositories = createFactoryGuestRepositoryReadBroker({
    sources: sources(source.root), cacheRoot: join(root, "cache"),
    materials: current => new FactoryAttemptMaterials({ database: db, artifacts, blobs, journal, authority: current }),
    readToken: async path => { tokens.push(path); return "fixture-token"; },
  });
  const materials = createFactoryGuestMaterialBroker({ services: createFactoryGuestMaterialServices({ database: db, artifacts, blobs, journal }) });
  // One reverse channel, as the guest-broker route answers it: repository reads to the repository broker, the rest to the material broker.
  const call = async (payload: JsonValue) => ((payload as { schemaVersion?: string }).schemaVersion === "factory.guest-repository-read.v1" ? repositories.frame(authority, payload) : materials.invoke(request, payload));
  return { source, call, repositories, authority, operationId: `${runId}:snapshot-repository:0:0`, tokens };
}

test("a guest reads one commit of a declared source: the complete tree, sealed in its own attempt, token by reference", async () => {
  const fixture = await setup(root => [{ name: "launch", url: `file://${root}`, tokenPath: "/run/secrets/launch.token" }]);
  const read = await readFactoryGuestRepository(fixture.call, { operationId: fixture.operationId, operationIndex: 0, source: "launch", commitSha: fixture.source.base });
  const tree = JSON.parse(new TextDecoder().decode(read.content)) as { schemaVersion: string; commitSha: string; treeSha: string; committedAtSeconds: number; files: { path: string; mode: "100644"; contentBase64: string }[] };
  expect(tree.schemaVersion).toBe(FACTORY_REPOSITORY_TREE_SCHEMA_VERSION);
  expect(tree.commitSha).toBe(fixture.source.base);
  expect(tree.committedAtSeconds).toBe(1_790_000_000);
  const files = referenceCodeFilesFromWire(tree.files);
  expect(files.map(file => file.path)).toEqual(referenceCodeLaunchRepository().map(file => file.path));
  expect(tree.treeSha).toBe(factoryGitTreeId(files));
  // The token was read by reference for this source, and only for it.
  expect(fixture.tokens).toEqual(["/run/secrets/launch.token"]);
  // A repeated read of the same commit answers the same sealed handle without a second material.
  const again = await fixture.repositories.frame(fixture.authority, { schemaVersion: "factory.guest-repository-read.v1", operationId: fixture.operationId, operationIndex: 0, source: "launch", commitSha: fixture.source.base });
  const first = await fixture.repositories.frame(fixture.authority, { schemaVersion: "factory.guest-repository-read.v1", operationId: fixture.operationId, operationIndex: 0, source: "launch", commitSha: fixture.source.base });
  expect(again).toEqual(first);
  expect(again).toMatchObject({ status: "read" });
}, 120_000);

test("an undeclared source, an unknown commit, an unreachable source and a malformed frame are refused by name", async () => {
  const fixture = await setup(root => [{ name: "launch", url: `file://${root}` }, { name: "gone", url: "file:///nonexistent/repository" }]);
  const refusal = async (source: string, commitSha: string) => {
    const failure = await readFactoryGuestRepository(fixture.call, { operationId: fixture.operationId, operationIndex: 0, source, commitSha }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FactoryGuestMaterialError);
    return (failure as FactoryGuestMaterialError).code;
  };
  expect(await refusal("elsewhere", fixture.source.base)).toBe("repository_source_unknown");
  expect(await refusal("launch", "0".repeat(40))).toBe("repository_commit_unknown");
  expect(await refusal("gone", fixture.source.base)).toBe("repository_unavailable");
  expect(fixture.tokens).toEqual([]);
  expect(await fixture.repositories.frame(fixture.authority, { schemaVersion: "factory.guest-repository-read.v1", operationId: fixture.operationId, operationIndex: 0, source: "launch", commitSha: "main" })).toMatchObject({ status: "refused", refusal: { code: "invalid_request" } });
  expect(await fixture.repositories.frame(fixture.authority, null)).toMatchObject({ status: "refused", operationId: "unknown", refusal: { code: "invalid_request" } });
  expect(factoryGuestRepositoryUnconfigured({ operationId: "op:0" })).toMatchObject({ status: "refused", operationId: "op:0", refusal: { code: "repository_source_unknown" } });
  expect(factoryGuestRepositoryUnconfigured(7)).toMatchObject({ operationId: "unknown" });
}, 120_000);

test("an expired attempt reads nothing, and a tree above the guest's read bound is refused before it is sealed", async () => {
  const large = await setup(root => [{ name: "launch", url: `file://${root}` }]);
  const cache = async () => { const made = await mkdtemp(join(tmpdir(), "repository-cache-")); directories.push(made); return made; };
  const expired = createFactoryGuestRepositoryReadBroker({
    sources: [{ name: "launch", url: `file://${large.source.root}` }], cacheRoot: await cache(),
    materials: () => { throw new Error("never sealed"); }, readToken: async () => "", now: () => Date.now() + 3_600_000,
  });
  expect(await expired.frame(large.authority, { schemaVersion: "factory.guest-repository-read.v1", operationId: large.operationId, operationIndex: 0, source: "launch", commitSha: large.source.base })).toMatchObject({ status: "refused", refusal: { code: "deadline_expired" } });

  const big = await repository({ "big.txt": "x".repeat(600 * 1024) });
  const bigSource = createFactoryGuestRepositoryReadBroker({
    sources: [{ name: "big", url: `file://${big.root}` }], cacheRoot: await cache(),
    materials: () => { throw new Error("never sealed"); }, readToken: async () => "",
  });
  expect(await bigSource.frame(large.authority, { schemaVersion: "factory.guest-repository-read.v1", operationId: large.operationId, operationIndex: 0, source: "big", commitSha: big.base })).toMatchObject({ status: "refused", refusal: { code: "repository_too_large" } });
}, 120_000);
