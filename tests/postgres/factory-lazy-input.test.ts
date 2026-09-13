import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import { setupFactoryPostgres } from "../../tests/postgres/helpers/factory-test-database";
import { createFactoryOrdinaryStorage } from "../../tests/postgres/helpers/factory-storage";
import { digestObject } from "../../src/extensions/v4/blobs";
import { FactoryArtifactAccess } from "../../src/factory/artifact-access";
import { FactoryArtifacts } from "../../src/factory/artifacts";
import { FactoryGrants, type FactoryPrincipal } from "../../src/factory/grants";
import { FACTORY_LAZY_INPUT_PAGE_BYTES, FactoryLazyInputReader } from "../../src/factory/lazy-input";

const tenantId = "lazy-tenant";
const sourceProjectId = "lazy-source";
const targetProjectId = "lazy-target";
const sourceRunId = "lazy-source-run";
const targetRunId = "lazy-target-run";
const actor: FactoryPrincipal = { kind: "user", id: "lazy-owner", authentication: "session" };
const definitionDigest = `sha256:${"a".repeat(64)}`;
let fixture: Awaited<ReturnType<typeof setupFactoryPostgres>>;
const closes: Array<() => Promise<void>> = [];
let artifacts: FactoryArtifacts;
let access: FactoryArtifactAccess;
let reader: FactoryLazyInputReader;
let artifact: { artifactId: string; digest: string; encodedBytes: number };

async function insertRun(projectId: string, runId: string, input: unknown, principal = actor): Promise<void> {
  const request = { projectId, runId, definitionDigest, interpreterBuild: "lazy-test", executionEpoch: 1, input, principalId: principal.id, principalKind: principal.kind };
  await fixture.db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${tenantId}, ${projectId}, ${runId}, ${definitionDigest}, 'lazy-test', 1, ${digestObject(request)}, ${canonicalJson(request)})`);
}

beforeAll(async () => {
  fixture = await setupFactoryPostgres(); closes.push(fixture.close);
  await fixture.db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${tenantId}, 1)`);
  await fixture.db.execute(sql`INSERT INTO users(id, email, password_hash, name, role) VALUES (${actor.id}, 'lazy@example.test', 'not-a-login', 'Lazy owner', 'admin')`);
  for (const projectId of [sourceProjectId, targetProjectId]) {
    await fixture.db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${projectId}, ${projectId}, ${`/${projectId}`})`);
    await fixture.db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${tenantId}, ${projectId})`);
    await fixture.db.execute(sql`INSERT INTO project_members(id, project_id, user_id, role) VALUES (${`lazy-member-${projectId}`}, ${projectId}, ${actor.id}, 'owner')`);
  }
  await fixture.db.execute(sql`INSERT INTO factory_grants(tenant_id, project_id, principal_kind, principal_id, action, issuer_id, revision) VALUES (${tenantId}, ${sourceProjectId}, 'user', ${actor.id}, 'factory.operate', ${actor.id}, 1), (${tenantId}, ${targetProjectId}, 'user', ${actor.id}, 'factory.run', ${actor.id}, 1)`);
  await insertRun(sourceProjectId, sourceRunId, {});
  const storage = await createFactoryOrdinaryStorage(`ordinary/factory-lazy-input/${randomUUID()}`); closes.push(async () => storage.close());
  artifacts = new FactoryArtifacts(fixture.db, storage.blobs, tenantId);
  const collection = Array.from({ length: 96 }, (_value, index) => `${index}:${"x".repeat(1_024)}`);
  const stored = await artifacts.stage({ tenantId, projectId: sourceProjectId, logicalRunId: sourceRunId, interpreterId: "lazy-source" }, "candidate_output", new TextEncoder().encode(canonicalJson(collection)), { interpreterScoped: false, candidateNodeInstanceId: "lazy-node", candidateGeneration: 1 });
  artifact = { artifactId: stored.objectId, digest: stored.digest, encodedBytes: stored.encodedBytes };
  const parameters = { data: { kind: "artifact", artifact } };
  await insertRun(targetProjectId, targetRunId, {});
  await fixture.db.execute(sql`INSERT INTO factory_drafts(tenant_id, project_id, factory_id, revision, source_digest, source_json, required_resources_json, requirements_complete, validation_diagnostic_count) VALUES (${tenantId}, ${targetProjectId}, 'lazy-factory', 1, ${definitionDigest}, '{}', '[]', TRUE, 0)`);
  await fixture.db.execute(sql`INSERT INTO factory_versions(tenant_id, project_id, factory_id, version, draft_revision, definition_digest, compiled_blob_digest, compiled_bytes, lock_json) VALUES (${tenantId}, ${targetProjectId}, 'lazy-factory', 'v1', 1, ${definitionDigest}, ${"b".repeat(64)}, 1, '{}')`);
  await fixture.db.execute(sql`INSERT INTO factory_run_lifecycle(tenant_id, project_id, run_id, factory_id, factory_version, definition_digest, grant_revision, status, deadline_ms, parameters_json, parameters_digest) VALUES (${tenantId}, ${targetProjectId}, ${targetRunId}, 'lazy-factory', 'v1', ${definitionDigest}, 1, 'running', ${Date.now() + 60_000}, ${canonicalJson(parameters)}, ${digestObject(parameters)})`);
  const grants = new FactoryGrants(fixture.db, tenantId);
  access = new FactoryArtifactAccess(fixture.db, tenantId, grants, artifacts);
  reader = new FactoryLazyInputReader(fixture.db, tenantId, artifacts, access, grants);
  await access.grant(actor, { sourceProjectId, sourceRunId, targetProjectId, artifact, mediaType: "application/json" }, "lazy-share");
});
afterAll(async () => { await Promise.all(closes.splice(0).map(close => close())); });

function value(path: readonly (string | number)[] = [], maxBytes = FACTORY_LAZY_INPUT_PAGE_BYTES) { return { projectId: targetProjectId, runId: targetRunId, name: "data", artifact, path, maxBytes }; }

test("lazy input pages a shared >64KiB immutable JSON collection without returning the collection", async () => {
  expect(artifact.encodedBytes).toBeGreaterThan(64 * 1024);
  const first = await reader.readPage({ ...value(), cursor: 0, maxItems: 8 });
  expect(first).toMatchObject({ artifact, mediaType: "application/json" });
  expect(first.items).toHaveLength(8);
  expect(first.nextCursor).toBe(8);
  expect(new TextEncoder().encode(canonicalJson(first.items)).byteLength).toBeLessThanOrEqual(FACTORY_LAZY_INPUT_PAGE_BYTES);
  const second = await reader.readPage({ ...value(), cursor: first.nextCursor!, maxItems: 8 });
  expect(second.items[0]).toBe(`8:${"x".repeat(1_024)}`);
  expect(await reader.readValue(value([3]))).toMatchObject({ value: `3:${"x".repeat(1_024)}` });
  await expect(reader.readValue(value())).rejects.toMatchObject({ code: "factory_lazy_input_page_required" });
});

test("lazy input requires the exact durable parameter reference and live source-target authority", async () => {
  await expect(reader.readPage({ ...value(), artifact: { ...artifact, digest: `sha256:${"0".repeat(64)}` }, cursor: 0, maxItems: 1 })).rejects.toMatchObject({ code: "factory_lazy_input_unavailable" });
  await expect(reader.readPage({ ...value(), cursor: 97, maxItems: 1 })).rejects.toMatchObject({ code: "factory_lazy_input_unavailable" });
  await expect(reader.readPage({ ...value(Array.from({ length: 17 }, () => "nested")), cursor: 0, maxItems: 1 })).rejects.toMatchObject({ code: "factory_lazy_input_unavailable" });
  await expect(reader.readPage({ ...value(), cursor: 0, maxItems: 1, maxBytes: 0 })).rejects.toMatchObject({ code: "factory_lazy_input_unavailable" });
  await fixture.db.execute(sql`UPDATE factory_run_lifecycle SET parameters_digest=${`sha256:${"0".repeat(64)}`} WHERE tenant_id=${tenantId} AND project_id=${targetProjectId} AND run_id=${targetRunId}`);
  await expect(reader.readPage({ ...value(), cursor: 0, maxItems: 1 })).rejects.toMatchObject({ code: "factory_lazy_input_unavailable" });
  const parameters = { data: { kind: "artifact", artifact } };
  await fixture.db.execute(sql`UPDATE factory_run_lifecycle SET parameters_digest=${digestObject(parameters)} WHERE tenant_id=${tenantId} AND project_id=${targetProjectId} AND run_id=${targetRunId}`);
  await fixture.db.execute(sql`UPDATE factory_grants SET revoked_at=NOW() WHERE tenant_id=${tenantId} AND project_id=${targetProjectId} AND principal_kind='user' AND principal_id=${actor.id} AND action='factory.run'`);
  await expect(reader.readPage({ ...value(), cursor: 0, maxItems: 1 })).rejects.toMatchObject({ code: "factory_lazy_input_unavailable" });
  await fixture.db.execute(sql`UPDATE factory_grants SET revoked_at=NULL WHERE tenant_id=${tenantId} AND project_id=${targetProjectId} AND principal_kind='user' AND principal_id=${actor.id} AND action='factory.run'`);
  await access.revoke(actor, { sourceProjectId, targetProjectId, artifact }, "lazy-revoke");
  await expect(reader.readPage({ ...value(), cursor: 0, maxItems: 1 })).rejects.toMatchObject({ code: "factory_lazy_input_unavailable" });
});

test("lazy input reads an exact same-project parameter artifact from S3", async () => {
  const localCollection = Array.from({ length: 96 }, (_value, index) => `local-${index}:${"y".repeat(1_024)}`);
  const stored = await artifacts.stage(
    { tenantId, projectId: targetProjectId, logicalRunId: targetRunId, interpreterId: "lazy-target" },
    "candidate_output",
    new TextEncoder().encode(canonicalJson(localCollection)),
    { interpreterScoped: false, candidateNodeInstanceId: "lazy-local-node", candidateGeneration: 2 },
  );
  const localArtifact = { artifactId: stored.objectId, digest: stored.digest, encodedBytes: stored.encodedBytes };
  const parameters = { data: { kind: "artifact", artifact: localArtifact } };
  await fixture.db.execute(sql`UPDATE factory_run_lifecycle SET parameters_json=${canonicalJson(parameters)}, parameters_digest=${digestObject(parameters)} WHERE tenant_id=${tenantId} AND project_id=${targetProjectId} AND run_id=${targetRunId}`);

  const page = await reader.readPage({
    projectId: targetProjectId,
    runId: targetRunId,
    name: "data",
    artifact: localArtifact,
    path: [],
    maxBytes: FACTORY_LAZY_INPUT_PAGE_BYTES,
    cursor: 0,
    maxItems: 4,
  });
  expect(page).toMatchObject({ artifact: localArtifact, mediaType: "application/json", items: [localCollection[0], localCollection[1], localCollection[2], localCollection[3]], nextCursor: 4 });
});
