import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";
import { createKernelState, referenceCodeV1, type FactoryDefinition, type FactoryDurableInput, type FactoryRunStartBody, type JsonValue } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import type { BlobStore } from "../../extensions/v4/types";
import { createFactoryApplication, type FactoryApplication } from "../../factory/application";
import { FactoryRecords } from "../../factory/records";
import { FactoryArtifactAccess } from "../../factory/artifact-access";
import { FactoryLazyInputReader } from "../../factory/lazy-input";

export function factoryRunInputsConformance(create: () => Promise<{ db: TransactionalDb; blobs: BlobStore; close(): Promise<void> }>): void {
  let fixture: Awaited<ReturnType<typeof create>>;
  let application: FactoryApplication;
  let body: FactoryRunStartBody;
  let sequence = 0;
  const tenantId = "run-inputs-tenant";
  const projectId = "run-inputs-project";
  const principal = { kind: "user", id: "run-inputs-owner", authentication: "session" } as const;
  const key = { projectId, factoryId: "run-inputs-factory" };
  const source: FactoryDefinition = {
    ...structuredClone(referenceCodeV1), id: key.factoryId,
    inputPorts: {
      payload: { type: "object", properties: { required: { type: "string", const: "verified" }, padding: { type: "string" } }, required: ["required", "padding"], additionalProperties: false },
      label: { type: "string", const: "inline label" },
    },
    outputPorts: {}, graph: { nodes: [], outputs: {} },
  };
  const stage = (content: string, sourceProjectId = projectId, runId = "input-source") => fixture.db.transaction(transaction => application.artifacts.stageCandidateOutputInTransaction(transaction, { tenantId, projectId: sourceProjectId, logicalRunId: runId, interpreterId: "root" }, `source-node-${++sequence}`, 0, new TextEncoder().encode(content)));
  const withArtifact = (artifact: Extract<FactoryRunStartBody["parameters"][string], { kind: "artifact" }>["artifact"]): FactoryRunStartBody => ({ ...body, parameters: { ...body.parameters, payload: { kind: "artifact", artifact } } });
  const runFacts = async () => rows(await fixture.db.execute(sql`SELECT run_id FROM factory_run_lifecycle WHERE tenant_id=${tenantId} AND project_id=${projectId} ORDER BY run_id`));
  beforeAll(async () => {
    fixture = await create();
    await new FactoryRecords(fixture.db, tenantId).bindInstallation();
    await fixture.db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId}, 'Input project', '/tmp/run-inputs')`);
    await fixture.db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${principal.id}, 'run-inputs@example.test', 'not-a-login', 'Input owner', 'admin')`);
    await fixture.db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('run-inputs-member', ${projectId}, ${principal.id}, 'owner')`);
    application = createFactoryApplication({ database: fixture.db, tenantId, blobs: fixture.blobs, availableResourceClasses: [], runOptions: { interpreterBuild: "inputs-build", interpreterCompatibility: source.interpreterCompatibility, limits: { maxCostMicros: "100", maxTokens: 100, maxComputeMs: 100 } } });
    await fixture.db.transaction(transaction => application.grants.initializeProjectInTransaction(transaction, projectId, principal.id));
    await application.definitions.save(principal, key, 0, "input-definition-save", source);
    const version = await application.definitions.publish(principal, key, 1, "input-definition-publish");
    await new FactoryRecords(fixture.db, tenantId).createRun({ projectId, runId: "input-source", definitionDigest: version.definitionDigest, interpreterBuild: "inputs-build", executionEpoch: 1, input: {}, principalId: principal.id, principalKind: "user" }, async () => {});
    const artifact = await stage(canonicalJson({ required: "verified", padding: "x".repeat(70_000) }));
    body = { factoryVersion: version.version, definitionDigest: version.definitionDigest, grantRevision: 1, parameters: { payload: { kind: "artifact", artifact }, label: { kind: "inline", value: "inline label" } } };
  });
  afterAll(async () => { await fixture?.close(); });

  test("the application validates required artifact bytes and starts a bounded durable workflow", async () => {
    const result = await application.runs.start(principal, key, body, 0, "input-start");
    const delivery = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_command_outbox WHERE tenant_id=${tenantId} AND project_id=${projectId} AND logical_run_id=${result.run.runId}`))[0]!;
    const workflow = JSON.parse(delivery.payload).command.body as { input: JsonValue; durableInput: FactoryDurableInput; startedAtMs: number };
    expect(workflow.input).toEqual({ label: "inline label" });
    expect(workflow.durableInput).toEqual({ schemaVersion: "factory.lazy-input.v1", parameters: body.parameters });
    expect(new TextEncoder().encode(delivery.payload).byteLength).toBeLessThan(64 * 1024);
    const { compiled } = await application.definitions.readVersion(principal, key, body.factoryVersion);
    expect(() => createKernelState(compiled, result.run.runId, workflow.input, workflow.startedAtMs, workflow.durableInput)).not.toThrow();
    expect((await application.runs.start(principal, key, body, 0, "input-start")).run.runId).toBe(result.run.runId);
  });

  test("actual artifact schema and exact inline ports are checked before any run is admitted", async () => {
    const before = await runFacts();
    const invalid = await stage(canonicalJson({ required: "forged", padding: "x".repeat(70_000) }));
    for (const [label, input] of [
      ["artifact-schema", withArtifact(invalid)],
      ["inline-schema", { ...body, parameters: { ...body.parameters, label: { kind: "inline", value: "wrong label" } } }],
      ["missing-port", { ...body, parameters: { payload: body.parameters.payload! } }],
      ["unknown-port", { ...body, parameters: { ...body.parameters, extra: { kind: "inline", value: true } } }],
    ] as const) await expect(application.runs.start(principal, key, input, 0, label)).rejects.toMatchObject({ code: "factory_input_invalid" });
    expect(await runFacts()).toEqual(before);
  });

  test("noncanonical, duplicate-key and non-JSON artifact bytes cannot enter workflow history", async () => {
    const before = await runFacts();
    for (const content of ['{"required":"verified", "padding":"x"}', '{"padding":"x","required":"forged","required":"verified"}', 'not JSON', '{"padding":"x","required":"verified","unsafe":9007199254740992}']) {
      const artifact = await stage(content);
      await expect(application.runs.start(principal, key, withArtifact(artifact), 0, `bad-json-${++sequence}`)).rejects.toMatchObject({ code: "factory_input_invalid" });
    }
    expect(await runFacts()).toEqual(before);
  });

  test("cross-project input needs an exact live grant at admission and at later lazy reads", async () => {
    const sourceProjectId = "shared-input-project";
    const sourceRunId = "shared-input-run";
    await fixture.db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${sourceProjectId}, 'Shared input project', '/tmp/shared-run-inputs')`);
    await fixture.db.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES ('shared-inputs-member', ${sourceProjectId}, ${principal.id}, 'owner')`);
    await fixture.db.transaction(transaction => application.grants.initializeProjectInTransaction(transaction, sourceProjectId, principal.id));
    await new FactoryRecords(fixture.db, tenantId).createRun({ projectId: sourceProjectId, runId: sourceRunId, definitionDigest: body.definitionDigest, interpreterBuild: "inputs-build", executionEpoch: 1, input: {}, principalId: principal.id, principalKind: "user" }, async () => {});
    const artifact = await stage(canonicalJson({ required: "verified", padding: "shared" }), sourceProjectId, sourceRunId);
    const access = new FactoryArtifactAccess(fixture.db, tenantId, application.grants, application.artifacts);
    await expect(application.runs.start(principal, key, withArtifact(artifact), 0, "share-denied")).rejects.toMatchObject({ code: "factory_input_invalid" });
    await access.grant(principal, { sourceProjectId, sourceRunId, targetProjectId: projectId, artifact, mediaType: "application/json" }, "share-input");
    const result = await application.runs.start(principal, key, withArtifact(artifact), 0, "share-allowed");
    const reader = new FactoryLazyInputReader(fixture.db, tenantId, application.artifacts, access, application.grants);
    const request = { projectId, runId: result.run.runId, name: "payload", artifact, path: ["required"], maxBytes: 100 };
    expect((await reader.readValue(request)).value).toBe("verified");
    await access.revoke(principal, { sourceProjectId, targetProjectId: projectId, artifact }, "share-revoked");
    await expect(application.runs.start(principal, key, withArtifact(artifact), 0, "share-after-revoke")).rejects.toMatchObject({ code: "factory_input_invalid" });
    await expect(reader.readValue(request)).rejects.toMatchObject({ code: "factory_lazy_input_unavailable" });
  });

  test("a changed host storage binding or caller artifact digest cannot start a run", async () => {
    const artifact = await stage(canonicalJson({ required: "verified", padding: "pinned" }));
    const before = await runFacts();
    await expect(application.runs.start(principal, key, withArtifact({ ...artifact, digest: `sha256:${"0".repeat(64)}` }), 0, "changed-artifact-digest")).rejects.toMatchObject({ code: "factory_input_invalid" });
    const original = rows<{ blob_digest: string }>(await fixture.db.execute(sql`SELECT blob_digest FROM factory_artifacts WHERE tenant_id=${tenantId} AND project_id=${projectId} AND object_id=${artifact.artifactId}`))[0]!;
    await fixture.db.execute(sql`UPDATE factory_artifacts SET blob_digest=${"0".repeat(64)} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND object_id=${artifact.artifactId}`);
    try { await expect(application.runs.start(principal, key, withArtifact(artifact), 0, "changed-storage-binding")).rejects.toMatchObject({ code: "factory_input_invalid" }); }
    finally { await fixture.db.execute(sql`UPDATE factory_artifacts SET blob_digest=${original.blob_digest} WHERE tenant_id=${tenantId} AND project_id=${projectId} AND object_id=${artifact.artifactId}`); }
    expect(await runFacts()).toEqual(before);
    expect((await application.runs.start(principal, key, withArtifact(artifact), 0, "restored-storage-binding")).run.status).toBe("queued");
  });
}
