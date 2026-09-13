import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { sql } from "drizzle-orm";
import { S3BlobStore, s3ObjectKey } from "../../src/extensions/v4/blobs";
import { artifactJson, FactoryArtifacts } from "../../src/factory/artifacts";
import { createFactoryArtifactActivities } from "../../src/factory/artifact-activities";
import { FactoryDefinitionArtifacts } from "../../src/factory/definition-artifacts";
import { FactoryInbox } from "../../src/factory/inbox";
import { FactoryTransitionArtifacts } from "../../src/factory/transition-artifacts";
import { persistTransition } from "../../packages/@ezcorp/factory-orchestrator/src/transition-pages";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())); });

async function fixture() {
  const database = await setupFactoryPostgres(); closes.push(database.close);
  const config = JSON.parse(await readFile("/run/user/1001/ezcorp-factory-storage.8yWJyCIQ/ordinary.json", "utf8")) as { identities: Array<{ name: string; credentials: Array<{ accessKey: string; secretKey: string }> }> };
  const credential = config.identities.find(identity => identity.name === "tenant-01")?.credentials[0];
  if (!credential) throw new Error("Local ordinary storage tenant identity is missing.");
  const credentials = { accessKeyId: credential.accessKey, secretAccessKey: credential.secretKey };
  const client = new S3Client({ endpoint: "http://127.0.0.1:18333", region: "us-east-1", forcePathStyle: true, credentials });
  const prefix = `ordinary/factory-artifacts/${randomUUID()}`;
  const blobs = new S3BlobStore({ endpoint: "http://127.0.0.1:18333", bucket: "tenant-01", prefix, credentials, client });
  const identity = { tenantId: "artifact-tenant", projectId: `artifact-${randomUUID()}`, logicalRunId: `run-${randomUUID()}`, interpreterId: "worker-a" };
  await database.db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${identity.projectId}, 'Artifact', '/tmp/artifact')`);
  await database.db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${identity.tenantId}, 1)`);
  await database.db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${identity.tenantId}, ${identity.projectId})`);
  await database.db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${identity.tenantId}, ${identity.projectId}, ${identity.logicalRunId}, ${`sha256:${"a".repeat(64)}`}, 'test', 1, 'request', '{}')`);
  return { database: database.db, client, blobs, identity, prefix };
}

test("PostgreSQL scoped S3 references retain original bytes and reject foreign and changed version records", async () => {
  const { database, client, blobs, identity, prefix } = await fixture();
  const artifacts = new FactoryArtifacts(database, blobs, "artifact-tenant");
  const content = new TextEncoder().encode("immutable artifact bytes");
  const reference = await artifacts.stage(identity, "execution_manifest", content, { definitionDigest: `sha256:${"a".repeat(64)}`, interpreterScoped: false });
  expect(await artifacts.load(identity, reference, ["execution_manifest"])).toMatchObject({ content });
  await expect(artifacts.load({ ...identity, projectId: "foreign" }, reference, ["execution_manifest"])).rejects.toMatchObject({ code: "factory_artifact_not_found" });
  const selected = await database.execute(sql`SELECT blob_digest, storage_version FROM factory_artifacts WHERE object_id=${reference.objectId}`) as unknown as { rows?: unknown[] } | unknown[];
  const row = (Array.isArray(selected) ? selected : selected.rows) as Array<{ blob_digest: string; storage_version: string }>;
  await client.send(new PutObjectCommand({ Bucket: "tenant-01", Key: s3ObjectKey(prefix, row[0]!.blob_digest), Body: new TextEncoder().encode("changed artifact bytes") }));
  expect((await artifacts.load(identity, reference, ["execution_manifest"])).content).toEqual(content);
  const changed = await blobs.version(row[0]!.blob_digest);
  expect(changed).not.toBe(row[0]!.storage_version);
  await database.execute(sql`UPDATE factory_artifacts SET storage_version=${changed} WHERE object_id=${reference.objectId}`);
  await expect(artifacts.load(identity, reference, ["execution_manifest"])).rejects.toMatchObject({ code: "artifact_corrupt" });
  client.destroy();
});

test("twelve concurrent PostgreSQL admissions converge and changed bytes fail", async () => {
  const { database, client, blobs, identity } = await fixture();
  const artifacts = new FactoryArtifacts(database, blobs, "artifact-tenant");
  const content = new TextEncoder().encode("concurrent immutable page");
  const options = { definitionDigest: `sha256:${"e".repeat(64)}`, pageIndex: 7, interpreterScoped: false };
  const references = await Promise.all(Array.from({ length: 12 }, () => artifacts.stage(identity, "definition_page", content, options)));
  expect(new Set(references.map(reference => reference.objectId)).size).toBe(1);
  await expect(artifacts.stage(identity, "definition_page", new TextEncoder().encode("changed page"), options)).rejects.toMatchObject({ code: "factory_artifact_conflict" });
  const rows = await database.execute(sql`SELECT object_id FROM factory_artifacts WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND run_id=${identity.logicalRunId} AND kind='definition_page' AND page_index=7`) as unknown as { rows?: unknown[] } | unknown[];
  expect(Array.isArray(rows) ? rows : rows.rows).toHaveLength(1);
  client.destroy();
});

test("PostgreSQL outer rollback leaves no staged reference or accepted factory fact", async () => {
  const { database, client, blobs, identity } = await fixture();
  const artifacts = new FactoryArtifacts(database, blobs, identity.tenantId);
  const pending = { ...identity, logicalRunId: `rolled-back-${randomUUID()}` };
  await expect(database.transaction(async transaction => {
    await transaction.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${pending.tenantId}, ${pending.projectId}, ${pending.logicalRunId}, ${`sha256:${"a".repeat(64)}`}, 'test', 1, 'request', '{}')`);
    await artifacts.stageInTransaction(transaction, pending, "execution_manifest", new TextEncoder().encode("pending"), { definitionDigest: `sha256:${"a".repeat(64)}`, interpreterScoped: false });
    throw new Error("force outer rollback");
  })).rejects.toThrow("force outer rollback");
  const references = await database.execute(sql`SELECT object_id FROM factory_artifacts WHERE tenant_id=${pending.tenantId} AND project_id=${pending.projectId} AND run_id=${pending.logicalRunId}`) as unknown as { rows?: unknown[] } | unknown[];
  const runs = await database.execute(sql`SELECT run_id FROM factory_runs WHERE tenant_id=${pending.tenantId} AND project_id=${pending.projectId} AND run_id=${pending.logicalRunId}`) as unknown as { rows?: unknown[] } | unknown[];
  const outbox = await database.execute(sql`SELECT id FROM factory_command_outbox WHERE tenant_id=${pending.tenantId} AND project_id=${pending.projectId} AND logical_run_id=${pending.logicalRunId}`) as unknown as { rows?: unknown[] } | unknown[];
  expect(Array.isArray(references) ? references : references.rows).toEqual([]);
  expect(Array.isArray(runs) ? runs : runs.rows).toEqual([]);
  expect(Array.isArray(outbox) ? outbox : outbox.rows).toEqual([]);
  client.destroy();
});

test("PostgreSQL and S3 commit paged Node transitions with exact inbox receipts", async () => {
  const { database, client, blobs, identity } = await fixture();
  const artifacts = new FactoryArtifacts(database, blobs, identity.tenantId);
  const definitions = new FactoryDefinitionArtifacts(artifacts);
  const transitions = new FactoryTransitionArtifacts(artifacts);
  const activity = createFactoryArtifactActivities(definitions, transitions);
  const inbox = new FactoryInbox(database, identity.tenantId);
  const event: Extract<KernelEvent, { kind: "cancel" }> = { id: "accepted-event", kind: "cancel", atMs: 1, reason: "x" };
  const delivery = await inbox.enqueue({ projectId: identity.projectId, runId: identity.logicalRunId, interpreterId: identity.interpreterId }, event);
  const command = delivery.command as { eventSequence: number; eventHash: string };
  await persistTransition(identity, 1, event, { padding: "x".repeat(40 * 1024) } as never, [], { sequence: command.eventSequence, eventId: event.id, eventHash: command.eventHash }, activity);
  const key = { projectId: identity.projectId, runId: identity.logicalRunId, interpreterId: identity.interpreterId };
  expect(await inbox.confirmApplied(key, { inboxSequence: command.eventSequence, eventId: event.id, eventHash: command.eventHash })).toBe(true);
  const rows = await database.execute(sql`SELECT kind, encoded_bytes FROM factory_artifacts WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND run_id=${identity.logicalRunId} ORDER BY kind`) as unknown as { rows?: Array<{ kind: string; encoded_bytes: number }> } | Array<{ kind: string; encoded_bytes: number }>;
  const references = (Array.isArray(rows) ? rows : rows.rows)!;
  expect(references.filter(reference => reference.kind === "transition_page")).toHaveLength(2);
  expect(references.find(reference => reference.kind === "transition_manifest")!.encoded_bytes).toBeLessThanOrEqual(32 * 1024);

  const missing: Extract<KernelEvent, { kind: "cancel" }> = { id: "never-enqueued", kind: "cancel", atMs: 2, reason: "x" };
  const content = artifactJson.text(artifactJson.canonical({ schemaVersion: "factory.transition.v1", ...identity, sourceSequence: 2, event: missing, nextState: {}, commands: [] }));
  const page = await transitions.stageTransitionPage({ ...identity, sourceSequence: 2, index: 0, content, encodedBytes: artifactJson.bytes(content).byteLength });
  const finalized = await transitions.finalizeTransitionArtifact({ ...identity, sourceSequence: 2, encodedBytes: page.encodedBytes, eventId: missing.id, pages: [page] });
  const badRecord = { ...identity, sourceSequence: 2, eventId: missing.id, eventHash: finalized.eventHash, inboxSequence: command.eventSequence, artifactManifest: finalized.manifest };
  await expect(transitions.recordTransition(badRecord)).rejects.toMatchObject({ code: "factory_inbox_applied_conflict" });
  const auditRows = await database.execute(sql`SELECT source_sequence FROM factory_audit_batches WHERE tenant_id=${identity.tenantId} AND run_id=${identity.logicalRunId}`) as unknown as { rows?: unknown[] } | unknown[];
  expect(Array.isArray(auditRows) ? auditRows : auditRows.rows).toHaveLength(1);
  const sourceRows = await database.execute(sql`SELECT payload FROM factory_audit_batches WHERE tenant_id=${identity.tenantId} AND run_id=${identity.logicalRunId}`) as unknown as { rows?: Array<{ payload: string }> } | Array<{ payload: string }>;
  const source = (Array.isArray(sourceRows) ? sourceRows : sourceRows.rows)![0]!;
  const record = { ...identity, sourceSequence: 1, eventId: event.id, eventHash: command.eventHash, inboxSequence: command.eventSequence, artifactManifest: JSON.parse(source.payload).artifactManifest };
  await Promise.all([transitions.recordTransition(record), transitions.recordTransition(record)]);
  expect(await inbox.confirmApplied(key, { inboxSequence: command.eventSequence, eventId: event.id, eventHash: command.eventHash })).toBe(true);
  client.destroy();
});
