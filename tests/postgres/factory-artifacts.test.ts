import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { sql } from "drizzle-orm";
import { s3ObjectKey } from "../../src/extensions/v4/blobs";
import { artifactJson, FactoryArtifacts } from "../../src/factory/artifacts";
import { createFactoryArtifactActivities } from "../../src/factory/artifact-activities";
import { FactoryDefinitionArtifacts } from "../../src/factory/definition-artifacts";
import { FactoryInbox } from "../../src/factory/inbox";
import { FactoryTransitionArtifacts } from "../../src/factory/transition-artifacts";
import { persistTransition } from "../../packages/@ezcorp/factory-orchestrator/src/transition-pages";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())); });

async function fixture() {
  const database = await setupFactoryPostgres(); closes.push(database.close);
  const prefix = `ordinary/factory-artifacts/${randomUUID()}`;
  const storage = await createFactoryOrdinaryStorage(prefix); closes.push(async () => storage.close());
  const identity = { tenantId: "artifact-tenant", projectId: `artifact-${randomUUID()}`, logicalRunId: `run-${randomUUID()}`, interpreterId: "worker-a" };
  await database.db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${identity.projectId}, 'Artifact', '/tmp/artifact')`);
  await database.db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${identity.tenantId}, 1)`);
  await database.db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${identity.tenantId}, ${identity.projectId})`);
  await database.db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${identity.tenantId}, ${identity.projectId}, ${identity.logicalRunId}, ${`sha256:${"a".repeat(64)}`}, 'test', 1, 'request', '{}')`);
  return { database: database.db, client: storage.client, blobs: storage.blobs, identity, bucket: storage.bucket, prefix: storage.prefix };
}

test("PostgreSQL artifact primary key carries tenant and project scope", async () => {
  const database = await setupFactoryPostgres(); closes.push(database.close);
  const selected = await database.db.execute(sql`SELECT column_name FROM information_schema.key_column_usage WHERE table_schema = current_schema() AND table_name = 'factory_artifacts' AND constraint_name = 'factory_artifacts_pkey' ORDER BY ordinal_position`) as unknown as { rows?: Array<{ column_name: string }> } | Array<{ column_name: string }>;
  const rows = Array.isArray(selected) ? selected : selected.rows;
  expect(rows?.map(row => row.column_name)).toEqual(["tenant_id", "project_id", "object_id"]);
});

test("PostgreSQL scoped S3 references retain original bytes and reject foreign and changed version records", async () => {
  const { database, client, blobs, identity, bucket, prefix } = await fixture();
  const artifacts = new FactoryArtifacts(database, blobs, "artifact-tenant");
  const content = new TextEncoder().encode("immutable artifact bytes");
  const reference = await artifacts.stage(identity, "execution_manifest", content, { definitionDigest: `sha256:${"a".repeat(64)}`, interpreterScoped: false });
  expect(await artifacts.load(identity, reference, ["execution_manifest"])).toMatchObject({ content });
  await expect(artifacts.load({ ...identity, projectId: "foreign" }, reference, ["execution_manifest"])).rejects.toMatchObject({ code: "factory_artifact_not_found" });
  const selected = await database.execute(sql`SELECT blob_digest, storage_version FROM factory_artifacts WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND object_id=${reference.objectId}`) as unknown as { rows?: unknown[] } | unknown[];
  const row = (Array.isArray(selected) ? selected : selected.rows) as Array<{ blob_digest: string; storage_version: string }>;
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: s3ObjectKey(prefix, row[0]!.blob_digest), Body: new TextEncoder().encode("changed artifact bytes") }));
  expect((await artifacts.load(identity, reference, ["execution_manifest"])).content).toEqual(content);
  const changed = await blobs.version(row[0]!.blob_digest);
  expect(changed).not.toBe(row[0]!.storage_version);
  await database.execute(sql`UPDATE factory_artifacts SET storage_version=${changed} WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND object_id=${reference.objectId}`);
  await expect(artifacts.load(identity, reference, ["execution_manifest"])).rejects.toMatchObject({ code: "artifact_corrupt" });
});

test("twelve concurrent PostgreSQL admissions converge and changed bytes fail", async () => {
  const { database, blobs, identity } = await fixture();
  const artifacts = new FactoryArtifacts(database, blobs, "artifact-tenant");
  const content = new TextEncoder().encode("concurrent immutable page");
  const options = { definitionDigest: `sha256:${"e".repeat(64)}`, pageIndex: 7, interpreterScoped: false };
  const references = await Promise.all(Array.from({ length: 12 }, () => artifacts.stage(identity, "definition_page", content, options)));
  expect(new Set(references.map(reference => reference.objectId)).size).toBe(1);
  await expect(artifacts.stage(identity, "definition_page", new TextEncoder().encode("changed page"), options)).rejects.toMatchObject({ code: "factory_artifact_conflict" });
  const rows = await database.execute(sql`SELECT object_id FROM factory_artifacts WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND run_id=${identity.logicalRunId} AND kind='definition_page' AND page_index=7`) as unknown as { rows?: unknown[] } | unknown[];
  expect(Array.isArray(rows) ? rows : rows.rows).toHaveLength(1);
});

test("uses compiler partition IDs without hash collisions or signed-index overflow", async () => {
  const { blobs, database, identity } = await fixture();
  const definitions = new FactoryDefinitionArtifacts(new FactoryArtifacts(database, blobs, identity.tenantId));
  const definitionDigest = `sha256:${"f".repeat(64)}`;
  const first = await definitions.stagePartition({ id: "Aa" } as never, identity, definitionDigest);
  const second = await definitions.stagePartition({ id: "BB" } as never, identity, definitionDigest);
  const overflow = await definitions.stagePartition({ id: "zzzzzz" } as never, identity, definitionDigest);
  expect(new Set([first.objectId, second.objectId, overflow.objectId]).size).toBe(3);
  const rows = await database.execute(sql`SELECT partition_id, page_index FROM factory_artifacts WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND run_id=${identity.logicalRunId} AND kind='partition' ORDER BY partition_id`) as unknown as { rows?: Array<{ partition_id: string; page_index: number | null }> } | Array<{ partition_id: string; page_index: number | null }>;
  expect(Array.isArray(rows) ? rows : rows.rows).toEqual([{ partition_id: "Aa", page_index: null }, { partition_id: "BB", page_index: null }, { partition_id: "zzzzzz", page_index: null }]);
});

test("PostgreSQL outer rollback leaves no staged reference or accepted factory fact", async () => {
  const { database, blobs, identity } = await fixture();
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
});

test("PostgreSQL and S3 commit paged Node transitions with exact inbox receipts", async () => {
  const { database, blobs, identity } = await fixture();
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
});
