import { afterAll, beforeAll, expect, test } from "bun:test";
import { canonicalJson } from "@ezcorp/extension-contract";
import { createKernelState, referenceCodeV1, type FactoryDefinition } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { digestObject, FileBlobStore } from "../extensions/v4/blobs";
import { FactoryArtifactAccess } from "./artifact-access";
import { FactoryArtifacts } from "./artifacts";
import { FactoryDefinitionArtifacts } from "./definition-artifacts";
import { FactoryDefinitions } from "./definitions";
import { FactoryRunLifecycle } from "./run-lifecycle";
import { FactoryGrants, type FactoryPrincipal } from "./grants";
import { FACTORY_LAZY_INPUT_PAGE_BYTES, FactoryLazyInputReader } from "./lazy-input";

const tenantId = "lazy-tenant";
const sourceProjectId = "lazy-source";
const targetProjectId = "lazy-target";
const sourceRunId = "lazy-source-run";
const targetRunId = "lazy-target-run";
const actor: FactoryPrincipal = { kind: "user", id: "lazy-owner", authentication: "session" };
const definitionDigest = `sha256:${"a".repeat(64)}`;
let fixture: Awaited<ReturnType<typeof setupTestDb>>;
let artifacts: FactoryArtifacts;
let access: FactoryArtifactAccess;
let reader: FactoryLazyInputReader;
let artifact: { artifactId: string; digest: string; encodedBytes: number };
const directories: string[] = [];

async function insertRun(projectId: string, runId: string, input: unknown, principal = actor): Promise<void> {
  const request = { projectId, runId, definitionDigest, interpreterBuild: "lazy-test", executionEpoch: 1, input, principalId: principal.id, principalKind: principal.kind };
  await fixture.db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${tenantId}, ${projectId}, ${runId}, ${definitionDigest}, 'lazy-test', 1, ${digestObject(request)}, ${canonicalJson(request)})`);
}

beforeAll(async () => {
  fixture = await setupTestDb();
  await fixture.db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${tenantId}, 1)`);
  await fixture.db.execute(sql`INSERT INTO users(id, email, password_hash, name, role) VALUES (${actor.id}, 'lazy@example.test', 'not-a-login', 'Lazy owner', 'admin')`);
  for (const projectId of [sourceProjectId, targetProjectId]) {
    await fixture.db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${projectId}, ${projectId}, ${`/${projectId}`})`);
    await fixture.db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${tenantId}, ${projectId})`);
    await fixture.db.execute(sql`INSERT INTO project_members(id, project_id, user_id, role) VALUES (${`lazy-member-${projectId}`}, ${projectId}, ${actor.id}, 'owner')`);
  }
  await fixture.db.execute(sql`INSERT INTO factory_grants(tenant_id, project_id, principal_kind, principal_id, action, issuer_id, revision) VALUES (${tenantId}, ${sourceProjectId}, 'user', ${actor.id}, 'factory.operate', ${actor.id}, 1), (${tenantId}, ${targetProjectId}, 'user', ${actor.id}, 'factory.run', ${actor.id}, 1)`);
  await insertRun(sourceProjectId, sourceRunId, {});
  const root = await mkdtemp(join(tmpdir(), "factory-lazy-input-")); directories.push(root);
  artifacts = new FactoryArtifacts(fixture.db, new FileBlobStore(root), tenantId);
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
afterAll(async () => { await fixture?.pglite.close(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

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


test("published lifecycle preserves a required large artifact as durable workflow input", async () => {
  const bytes = new TextEncoder().encode(canonicalJson({ required: "authoritative", padding: "x".repeat(70_000) }));
  const stored = await artifacts.stage({ tenantId, projectId: sourceProjectId, logicalRunId: sourceRunId, interpreterId: "durable-source" }, "candidate_output", bytes, { interpreterScoped: false, candidateNodeInstanceId: "durable-node", candidateGeneration: 1 });
  const durableArtifact = { artifactId: stored.objectId, digest: stored.digest, encodedBytes: stored.encodedBytes };
  const source: FactoryDefinition = {
    ...structuredClone(referenceCodeV1),
    id: "durable-required-artifact",
    version: "1",
    inputPorts: { payload: { type: "object", properties: { required: { type: "string", const: "authoritative" } }, required: ["required"] } },
    outputPorts: {},
    graph: { nodes: [], outputs: {} },
  };
  const grants = new FactoryGrants(fixture.db, tenantId, () => 1_000);
  const definitions = new FactoryDefinitions(fixture.db, tenantId, grants, new FileBlobStore(directories[0]!));
  const key = { projectId: targetProjectId, factoryId: source.id };
  await definitions.save(actor, key, 0, "durable-definition-save", source);
  const version = await definitions.publish(actor, key, 1, "durable-definition-publish");
  const lifecycle = new FactoryRunLifecycle(fixture.db, tenantId, {
    definitions, grants, interpreterBuild: "durable-build", interpreterCompatibility: source.interpreterCompatibility,
    limits: { maxCostMicros: "100", maxTokens: 100, maxComputeMs: 100 },
    stageDefinitionInTransaction: (transaction, compiled, identity) => new FactoryDefinitionArtifacts(artifacts).stageDefinitionInTransaction(transaction, compiled, identity),
    resolveParameters: async () => ({ kind: "factory.run-resolved-parameters", input: {} }),
  }, () => 1_000);
  const body = { factoryVersion: version.version, definitionDigest: version.definitionDigest, grantRevision: 1, parameters: { payload: { kind: "artifact" as const, artifact: durableArtifact } } };
  const started = await lifecycle.start(actor, key, body, 0, "durable-start");
  const outbox = (await fixture.db.execute(sql`SELECT payload FROM factory_command_outbox WHERE tenant_id=${tenantId} AND project_id=${targetProjectId} AND logical_run_id=${started.run.runId}`)).rows[0] as { payload: string };
  const workflow = JSON.parse(outbox.payload).command.body as { input: import("@ezcorp/factory-sdk").JsonValue; durableInput: unknown; startedAtMs: number };
  expect(workflow.input).toEqual({});
  expect(workflow.durableInput).toEqual({ schemaVersion: "factory.lazy-input.v1", parameters: body.parameters });
  const { compiled } = await definitions.readVersion(actor, key, version.version);
  expect(() => createKernelState(compiled, started.run.runId, workflow.input, workflow.startedAtMs, workflow.durableInput as never)).not.toThrow();
});
